import * as cdk from "aws-cdk-lib";
import * as batch from "aws-cdk-lib/aws-batch";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Names the workbench stack grants against without a cross-stack reference. */
export const SOLVER = {
  queue: "pai-solver", jobDefinition: "pai-solver-fea", cfdJobDefinition: "pai-solver-cfd", camJobDefinition: "pai-solver-cam", repository: "pai-solver",
  bucket: (account: string, region: string) => `pai-solver-jobs-${account}-${region}`,
};
const OPERATOR_ROLE = (account: string, region: string) => `cdk-hnb659fds-pai-operator-role-${account}-${region}`;

/**
 * FEA scale-out: one optimisation point = one AWS Batch job on Fargate (linux/amd64; Gmsh has no aarch64 wheel).
 *  - Image: Dockerfile.solver, built by CodeBuild from a content-hashed source asset into an immutable ECR tag.
 *  - Network: a dedicated VPC with public subnets only and no NAT or interface endpoints, so it has no fixed cost.
 *    Tasks get a public IP to pull from ECR. Their security group has no ingress and allows only HTTPS out.
 *  - Data: a jobs bucket (SSE-S3, TLS only, no public access, 30-day expiry). The job role can read and write only
 *    jobs/*. No retries: a failed or lost job is reported, never resubmitted automatically.
 */
export class SolverStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const contextDir = resolve("../.state/deploy/solver-context");
    if (!existsSync(contextDir)) throw new Error("Run python3 tools/package_solver.py first");

    const vpc = new ec2.Vpc(this, "Vpc", {
      ipAddresses: ec2.IpAddresses.cidr("10.81.0.0/16"), natGateways: 0, maxAzs: 2,
      subnetConfiguration: [{ name: "jobs", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }], restrictDefaultSecurityGroup: true,
    });
    const sg = new ec2.SecurityGroup(this, "JobSg", { vpc, description: "Solver jobs: no ingress, HTTPS egress only", allowAllOutbound: false });
    sg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "ECR, S3 and CloudWatch Logs over HTTPS");

    const jobs = new s3.Bucket(this, "Jobs", {
      bucketName: SOLVER.bucket(this.account, this.region), encryption: s3.BucketEncryption.S3_MANAGED, enforceSSL: true, minimumTLSVersion: 1.2,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }], removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const repo = new ecr.Repository(this, "Images", {
      repositoryName: SOLVER.repository, imageTagMutability: ecr.TagMutability.IMMUTABLE, imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, lifecycleRules: [{ maxImageCount: 10 }],
    });
    const source = new assets.Asset(this, "BuildContext", { path: contextDir });
    const imageTag = `fea-${source.assetHash.slice(0, 16)}`, cfdTag = `cfd-${source.assetHash.slice(0, 16)}`, camTag = `cam-${source.assetHash.slice(0, 16)}`;
    const buildLogs = new logs.LogGroup(this, "BuildLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const project = new codebuild.Project(this, "ImageBuild", {
      projectName: "pai-solver-image", description: "linux/amd64 build of the PAI FEA solver job image",
      source: codebuild.Source.s3({ bucket: source.bucket, path: source.s3ObjectKey }),
      environment: { buildImage: codebuild.LinuxBuildImage.STANDARD_7_0, computeType: codebuild.ComputeType.LARGE, privileged: true },
      environmentVariables: { REPO: { value: repo.repositoryUri }, TAG: { value: imageTag }, CFD_TAG: { value: cfdTag }, CAM_TAG: { value: camTag } },
      timeout: cdk.Duration.minutes(60), logging: { cloudWatch: { logGroup: buildLogs } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: { commands: ["aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin ${REPO%%/*}"] },
          build: { commands: [
            // Immutable tag per source hash: an existing image is never rebuilt or replaced.
            `if aws ecr describe-images --repository-name ${SOLVER.repository} --image-ids imageTag=$TAG >/dev/null 2>&1; then echo "exists $TAG"; else `
              + "docker build --platform linux/amd64 -f Dockerfile.solver --build-arg PAI_IMAGE_VERSION=$TAG -t $REPO:$TAG . && docker push $REPO:$TAG; fi",
            "docker run --rm --network none --entrypoint /opt/physics/bin/python $REPO:$TAG -c \"import gmsh; print('gmsh', gmsh.__version__)\" || true",
            // CFD image: FROM the digest-pinned OpenCFD OpenFOAM v2512 image (Dockerfile.cfd).
            `if aws ecr describe-images --repository-name ${SOLVER.repository} --image-ids imageTag=$CFD_TAG >/dev/null 2>&1; then echo "exists $CFD_TAG"; else `
              + "docker build --platform linux/amd64 -f Dockerfile.cfd --build-arg PAI_IMAGE_VERSION=$CFD_TAG -t $REPO:$CFD_TAG . && docker push $REPO:$CFD_TAG; fi",
            // CAM image: FreeCAD 1.1 installed by tools/setup_cam.py (AppImage sha256 from runtime-pins.json) (Dockerfile.cam).
            `if aws ecr describe-images --repository-name ${SOLVER.repository} --image-ids imageTag=$CAM_TAG >/dev/null 2>&1; then echo "exists $CAM_TAG"; else `
              + "docker build --platform linux/amd64 -f Dockerfile.cam --build-arg PAI_IMAGE_VERSION=$CAM_TAG -t $REPO:$CAM_TAG . && docker push $REPO:$CAM_TAG; fi",
          ] },
          post_build: { commands: [`aws ecr describe-images --repository-name ${SOLVER.repository} --image-ids imageTag=$TAG imageTag=$CFD_TAG imageTag=$CAM_TAG --query 'imageDetails[].[imageTags[0],imageSizeInBytes,imageDigest]' --output text`] },
        },
      }),
    });
    repo.grantPullPush(project);
    project.addToRolePolicy(new iam.PolicyStatement({ actions: ["ecr:DescribeImages"], resources: [repo.repositoryArn] }));

    const jobRole = new iam.Role(this, "JobRole", { assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"), description: "Solver job: jobs/* of the solver bucket only" });
    jobs.grantReadWrite(jobRole, "jobs/*");
    const jobLogs = new logs.LogGroup(this, "JobLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const env = new batch.FargateComputeEnvironment(this, "Compute", {
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, securityGroups: [sg], maxvCpus: 32, spot: false,
    });
    const queue = new batch.JobQueue(this, "Queue", { jobQueueName: SOLVER.queue, computeEnvironments: [{ computeEnvironment: env, order: 1 }] });
    const jobDef = new batch.EcsJobDefinition(this, "FeaJob", {
      jobDefinitionName: SOLVER.jobDefinition, retryAttempts: 1, timeout: cdk.Duration.minutes(30), propagateTags: true,
      container: new batch.EcsFargateContainerDefinition(this, "FeaContainer", {
        image: ecs.ContainerImage.fromEcrRepository(repo, imageTag), cpu: 2, memory: cdk.Size.gibibytes(4),
        fargateCpuArchitecture: ecs.CpuArchitecture.X86_64, fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        assignPublicIp: true, jobRole, logging: ecs.LogDriver.awsLogs({ streamPrefix: "fea", logGroup: jobLogs }),
        readonlyRootFilesystem: false, user: "1001",
      }),
    });

    // OpenFOAM: one case per job, 16 vCPU / 32 GiB (the Fargate maximum vCPU), 2 h limit, one attempt.
    const cfdJob = new batch.EcsJobDefinition(this, "CfdJob", {
      jobDefinitionName: SOLVER.cfdJobDefinition, retryAttempts: 1, timeout: cdk.Duration.hours(2), propagateTags: true,
      container: new batch.EcsFargateContainerDefinition(this, "CfdContainer", {
        image: ecs.ContainerImage.fromEcrRepository(repo, cfdTag), cpu: 16, memory: cdk.Size.gibibytes(32), ephemeralStorageSize: cdk.Size.gibibytes(40),
        fargateCpuArchitecture: ecs.CpuArchitecture.X86_64, fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        assignPublicIp: true, jobRole, logging: ecs.LogDriver.awsLogs({ streamPrefix: "cfd", logGroup: jobLogs }), readonlyRootFilesystem: false, user: "1002",
      }),
    });
    // CAM: one part's programs per job (FreeCAD CAM is multithreaded), 4 vCPU / 16 GiB, 1 h, one attempt. The image is
    // ~8 GB uncompressed, so the task gets 60 GiB of ephemeral storage. Verification runs on the workbench host.
    const camJob = new batch.EcsJobDefinition(this, "CamJob", {
      jobDefinitionName: SOLVER.camJobDefinition, retryAttempts: 1, timeout: cdk.Duration.hours(1), propagateTags: true,
      container: new batch.EcsFargateContainerDefinition(this, "CamContainer", {
        image: ecs.ContainerImage.fromEcrRepository(repo, camTag), cpu: 4, memory: cdk.Size.gibibytes(16), ephemeralStorageSize: cdk.Size.gibibytes(60),
        fargateCpuArchitecture: ecs.CpuArchitecture.X86_64, fargateOperatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        assignPublicIp: true, jobRole, logging: ecs.LogDriver.awsLogs({ streamPrefix: "cam", logGroup: jobLogs }), readonlyRootFilesystem: false, user: "1003",
      }),
    });
    // A separately named policy: the AgentCore stack already owns the default policy name on this imported role.
    new iam.Policy(this, "SolverOperatorPolicy", {
      policyName: "pai-solver-operator", roles: [iam.Role.fromRoleName(this, "Operator", OPERATOR_ROLE(this.account, this.region))],
      statements: [
        new iam.PolicyStatement({ actions: ["codebuild:StartBuild", "codebuild:BatchGetBuilds"], resources: [project.projectArn] }),
        new iam.PolicyStatement({ actions: ["logs:GetLogEvents", "logs:FilterLogEvents"],
          resources: [buildLogs.logGroupArn, `${buildLogs.logGroupArn}:*`, jobLogs.logGroupArn, `${jobLogs.logGroupArn}:*`] }),
        new iam.PolicyStatement({ actions: ["ecr:DescribeImages", "ecr:DescribeImageScanFindings"], resources: [repo.repositoryArn] }),
      ],
    });

    new cdk.CfnOutput(this, "SolverImageTag", { value: imageTag });
    new cdk.CfnOutput(this, "SolverBuildProject", { value: project.projectName });
    new cdk.CfnOutput(this, "SolverQueue", { value: queue.jobQueueName });
    new cdk.CfnOutput(this, "SolverJobDefinition", { value: jobDef.jobDefinitionName });
    new cdk.CfnOutput(this, "SolverCfdJobDefinition", { value: cfdJob.jobDefinitionName });
    new cdk.CfnOutput(this, "SolverCfdImageTag", { value: cfdTag });
    new cdk.CfnOutput(this, "SolverCamJobDefinition", { value: camJob.jobDefinitionName });
    new cdk.CfnOutput(this, "SolverCamImageTag", { value: camTag });
    new cdk.CfnOutput(this, "SolverBucket", { value: jobs.bucketName });
    new cdk.CfnOutput(this, "SolverJobLogGroup", { value: jobLogs.logGroupName });
  }
}
