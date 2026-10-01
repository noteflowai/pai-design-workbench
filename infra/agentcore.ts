import * as cdk from "aws-cdk-lib";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as efs from "aws-cdk-lib/aws-efs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * PAI on Amazon Bedrock AgentCore Runtime (bring your own container, linux/arm64).
 *
 * A dedicated VPC keeps every change away from the shared WordPress VPC:
 *  - isolated subnets (no NAT, no IGW) for the CAD sandbox runtime; it reaches only ECR/logs interface endpoints
 *    and the S3 gateway endpoint (scoped to ECR layer storage) needed to pull its own image and ship logs;
 *  - private subnets with one NAT gateway for the agent runtime, which must reach the Kiro service;
 *  - an encrypted EFS file system (retained) holding the agent's attempt-only ledger and run receipts, so new
 *    sessions and runtime version updates never reset accounting.
 * Images are built natively on arm64 by CodeBuild from a source asset; runtimes are created by the second stack
 * once the images exist. Invocation uses IAM (SigV4) authorization only.
 */
const OPERATOR_ROLE = (account: string, region: string) => `cdk-hnb659fds-pai-operator-role-${account}-${region}`;

export class AgentCoreBaseStack extends cdk.Stack {
  readonly vpc: ec2.Vpc;
  readonly repo: ecr.Repository;
  readonly sandboxSg: ec2.SecurityGroup;
  readonly agentSg: ec2.SecurityGroup;
  readonly ledger: efs.FileSystem;
  readonly ledgerAccess: efs.AccessPoint;
  readonly imageTag: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const contextDir = resolve("../.state/deploy/agentcore-context");
    if (!existsSync(contextDir)) throw new Error("Run python3 tools/package_agentcore.py first");

    this.vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.80.0.0/16"), natGateways: 1,
      // apne1-az1 (1c) and apne1-az4 (1a) are AgentCore-supported Availability Zones.
      availabilityZones: ["ap-northeast-1a", "ap-northeast-1c"],
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: "agent", subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: "sandbox", subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });
    const isolated = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };
    const endpointSg = new ec2.SecurityGroup(this, "EndpointSg", { vpc: this.vpc, description: "AWS interface endpoints for AgentCore runtimes", allowAllOutbound: false });
    this.sandboxSg = new ec2.SecurityGroup(this, "SandboxSg", { vpc: this.vpc, description: "CAD sandbox: only image pull and logs", allowAllOutbound: false });
    this.agentSg = new ec2.SecurityGroup(this, "AgentSg", { vpc: this.vpc, description: "Kiro agent: HTTPS egress and the ledger volume", allowAllOutbound: false });
    const efsSg = new ec2.SecurityGroup(this, "LedgerSg", { vpc: this.vpc, description: "Agent ledger EFS mount targets", allowAllOutbound: false });
    for (const sg of [this.sandboxSg, this.agentSg]) endpointSg.addIngressRule(sg, ec2.Port.tcp(443), "Runtime to AWS endpoints");
    this.sandboxSg.addEgressRule(endpointSg, ec2.Port.tcp(443), "ECR and logs endpoints only");
    const s3 = this.vpc.addGatewayEndpoint("S3", { service: ec2.GatewayVpcEndpointAwsService.S3, subnets: [isolated, { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }] });
    // Only ECR layer storage, read-only; nothing else in S3 is reachable from these subnets.
    s3.addToPolicy(new iam.PolicyStatement({ principals: [new iam.AnyPrincipal()], actions: ["s3:GetObject"], resources: [`arn:aws:s3:::prod-${this.region}-starport-layer-bucket/*`] }));
    this.sandboxSg.addEgressRule(ec2.Peer.prefixList(ec2.PrefixList.fromLookup(this, "S3List", { prefixListName: `com.amazonaws.${this.region}.s3` }).prefixListId), ec2.Port.tcp(443), "ECR layers via S3 gateway");
    for (const service of [ec2.InterfaceVpcEndpointAwsService.ECR, ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER, ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS]) {
      // One AZ keeps endpoint cost down; endpoint ENIs are reachable from both AZs.
      this.vpc.addInterfaceEndpoint(service.shortName.replace(/\W/g, ""), { service, securityGroups: [endpointSg], privateDnsEnabled: true,
        subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED, availabilityZones: ["ap-northeast-1c"] } });
    }
    this.agentSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "Kiro service, Secrets Manager");
    this.agentSg.addEgressRule(efsSg, ec2.Port.tcp(2049), "Ledger volume");
    efsSg.addIngressRule(this.agentSg, ec2.Port.tcp(2049), "Agent runtime");

    this.ledger = new efs.FileSystem(this, "Ledger", {
      vpc: this.vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, securityGroup: efsSg, encrypted: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, performanceMode: efs.PerformanceMode.GENERAL_PURPOSE, throughputMode: efs.ThroughputMode.ELASTIC,
      enableAutomaticBackups: true,
    });
    this.ledgerAccess = this.ledger.addAccessPoint("LedgerAccess", {
      path: "/pai-agent-ledger", posixUser: { uid: "1001", gid: "1001" }, createAcl: { ownerUid: "1001", ownerGid: "1001", permissions: "0700" },
    });

    this.repo = new ecr.Repository(this, "Images", {
      repositoryName: "pai-agentcore", imageTagMutability: ecr.TagMutability.IMMUTABLE, imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, lifecycleRules: [{ maxImageCount: 20 }],
    });
    const source = new assets.Asset(this, "BuildContext", { path: contextDir });
    this.imageTag = source.assetHash.slice(0, 16);
    const buildLogs = new logs.LogGroup(this, "BuildLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const project = new codebuild.Project(this, "ImageBuild", {
      projectName: "pai-agentcore-images", description: "Native arm64 build of the PAI AgentCore images",
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      environmentVariables: { REPO: { value: this.repo.repositoryUri }, TAG: { value: this.imageTag } },
      timeout: cdk.Duration.minutes(60), logging: { cloudWatch: { logGroup: buildLogs } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: { commands: ["aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${REPO%%/*}", "uname -m"] },
          build: { commands: [
            // Immutable tags: an image that already exists for this source hash is never rebuilt or replaced.
            "for target in sandbox agent; do if aws ecr describe-images --repository-name pai-agentcore --image-ids imageTag=$target-$TAG >/dev/null 2>&1; then echo \"exists $target-$TAG\"; continue; fi; "
              + "docker build --platform linux/arm64 -f Dockerfile.agentcore --target $target --build-arg PAI_IMAGE_VERSION=$TAG -t $REPO:$target-$TAG . && "
              + "docker image inspect $REPO:$target-$TAG --format \"PAI_IMAGE $target {{.Architecture}} {{.Size}}\" && "
              // A concurrent build may have pushed the same immutable tag from the same source; that is not a failure.
              + "(docker push $REPO:$target-$TAG || aws ecr describe-images --repository-name pai-agentcore --image-ids imageTag=$target-$TAG >/dev/null); done",
          ] },
          post_build: { commands: ["aws ecr describe-images --repository-name pai-agentcore --image-ids imageTag=sandbox-$TAG imageTag=agent-$TAG --query 'imageDetails[].[imageTags[0],imageSizeInBytes,imageDigest]' --output text"] },
        },
      }),
    });
    this.repo.grantPullPush(project);
    project.addToRolePolicy(new iam.PolicyStatement({ actions: ["ecr:DescribeImages"], resources: [this.repo.repositoryArn] }));

    const operator = iam.Role.fromRoleName(this, "Operator", OPERATOR_ROLE(this.account, this.region));
    operator.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"], resources: [project.projectArn] }));
    operator.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["logs:GetLogEvents", "logs:FilterLogEvents"], resources: [buildLogs.logGroupArn, `${buildLogs.logGroupArn}:*`] }));
    operator.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["ecr:DescribeImages"], resources: [this.repo.repositoryArn] }));

    new cdk.CfnOutput(this, "ImageTag", { value: this.imageTag });
    new cdk.CfnOutput(this, "Repository", { value: this.repo.repositoryUri });
    new cdk.CfnOutput(this, "BuildProject", { value: project.projectName });
    new cdk.CfnOutput(this, "BuildLogGroup", { value: buildLogs.logGroupName });
    new cdk.CfnOutput(this, "LedgerFileSystem", { value: this.ledger.fileSystemId });
  }
}

export class AgentCoreRuntimeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps & { base: AgentCoreBaseStack; imageTag: string }) {
    super(scope, id, props);
    const { base, imageTag } = props;
    const assume = new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", { conditions: {
      StringEquals: { "aws:SourceAccount": this.account },
      ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
    } });
    const executionRole = (name: string) => {
      const role = new iam.Role(this, name, { assumedBy: assume, description: `PAI AgentCore ${name}` });
      base.repo.grantPull(role);
      role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ["logs:DescribeLogGroups"], resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:*`] }));
      role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudwatch:PutMetricData"], resources: ["*"], conditions: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } } }));
      return role;
    };
    const sandboxRole = executionRole("SandboxRole");
    const agentRole = executionRole("AgentRole");
    const keys = secrets.Secret.fromSecretNameV2(this, "KiroKeys", "pai-workbench/kiro-keys");
    keys.grantRead(agentRole);
    agentRole.addToPolicy(new iam.PolicyStatement({ actions: ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"], resources: [base.ledger.fileSystemArn],
      conditions: { ArnEquals: { "elasticfilesystem:AccessPointArn": base.ledgerAccess.accessPointArn } } }));
    // Validated by CreateAgentRuntime for EFS mounts (read-only describe calls).
    agentRole.addToPolicy(new iam.PolicyStatement({ actions: ["elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets", "elasticfilesystem:DescribeFileSystems"],
      resources: [base.ledger.fileSystemArn, base.ledgerAccess.accessPointArn] }));

    const subnets = (type: ec2.SubnetType) => base.vpc.selectSubnets({ subnetType: type }).subnetIds;
    const sandbox = new agentcore.CfnRuntime(this, "Sandbox", {
      agentRuntimeName: "pai_cad_sandbox", description: "PAI CadQuery sandbox: untrusted code and native CAD checks; isolated network, no credentials",
      roleArn: sandboxRole.roleArn, protocolConfiguration: "HTTP",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: `${base.repo.repositoryUri}:sandbox-${imageTag}` } },
      networkConfiguration: { networkMode: "VPC", networkModeConfig: { subnets: subnets(ec2.SubnetType.PRIVATE_ISOLATED), securityGroups: [base.sandboxSg.securityGroupId] } },
      environmentVariables: { PAI_AGENTCORE: "1" },
      // One job per session: short idle timeout so each job's microVM is reclaimed promptly.
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 120, maxLifetime: 1800 },
    });
    const agent = new agentcore.CfnRuntime(this, "Agent", {
      agentRuntimeName: "pai_kiro_agent", description: "PAI bounded NoteFlow executor with Kiro x3; text proposals only; ledger on EFS",
      roleArn: agentRole.roleArn, protocolConfiguration: "HTTP",
      agentRuntimeArtifact: { containerConfiguration: { containerUri: `${base.repo.repositoryUri}:agent-${imageTag}` } },
      networkConfiguration: { networkMode: "VPC", networkModeConfig: { subnets: subnets(ec2.SubnetType.PRIVATE_WITH_EGRESS), securityGroups: [base.agentSg.securityGroupId] } },
      filesystemConfigurations: [{ efsAccessPoint: { accessPointArn: base.ledgerAccess.accessPointArn, mountPath: "/mnt/ledger" } }],
      environmentVariables: { PAI_AGENTCORE: "1", PAI_AI_KEYS_ARN: keys.secretArn, PAI_AI_PROFILES: "kiro-primary,kiro-backup,kiro-backup2" },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
    });
    // Roles (and their inline policies) must exist before AgentCore validates image pull and network access.
    sandbox.node.addDependency(sandboxRole); agent.node.addDependency(agentRole);

    const operator = iam.Role.fromRoleName(this, "Operator", OPERATOR_ROLE(this.account, this.region));
    const runtimes = [sandbox.attrAgentRuntimeArn, agent.attrAgentRuntimeArn];
    // A named policy: inline policies generated for an imported role must not collide with the base stack's.
    new iam.Policy(this, "OperatorInvoke", { policyName: "pai-agentcore-operator-invoke", roles: [operator], statements: [
      new iam.PolicyStatement({ actions: ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:StopRuntimeSession", "bedrock-agentcore:GetAgentRuntime"],
        resources: runtimes.flatMap(arn => [arn, `${arn}/*`]) }),
      new iam.PolicyStatement({ actions: ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:DescribeLogStreams"],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`] }),
    ] });
    new cdk.CfnOutput(this, "SandboxRuntimeArn", { value: sandbox.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "AgentRuntimeArn", { value: agent.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "ImageTag", { value: imageTag });
  }
}
