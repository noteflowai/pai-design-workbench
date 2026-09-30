import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as cr from "aws-cdk-lib/custom-resources";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as backup from "aws-cdk-lib/aws-backup";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as assets from "aws-cdk-lib/aws-s3-assets";
import { Construct } from "constructs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

export class WorkbenchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    const context = (key: string): string => {
      const value = this.node.tryGetContext(key);
      if (value === undefined) throw new Error(`Missing deployment context: ${key}`);
      return String(value);
    };
    const domain = context("domain"), zone = context("availabilityZone");
    const vpc = ec2.Vpc.fromVpcAttributes(this, "ExistingVpc", {
      vpcId: context("vpcId"), availabilityZones: [zone],
      publicSubnetIds: [context("subnetId")], publicSubnetRouteTableIds: [context("routeTableId")],
    });
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, "AlbSecurityGroup", context("albSecurityGroupId"), { mutable: false });
    const group = new ec2.SecurityGroup(this, "InstanceSecurityGroup", {
      vpc, description: "PAI HTTP from the existing ALB only; no SSH ingress", allowAllOutbound: true,
    });
    group.addIngressRule(albSecurityGroup, ec2.Port.tcp(4317), "Existing authenticated ALB");
    const secret = new secrets.Secret(this, "AdminLogin", {
      secretName: "pai-workbench/admin",
      description: "Private PAI workbench Cognito administrator",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "qiangguo", url: `https://${domain}` }),
        generateStringKey: "password", passwordLength: 32, excludeCharacters: "\"'\\`$&",
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const pool = new cognito.UserPool(this, "Users", {
      userPoolName: "pai-design-workbench", selfSignUpEnabled: false,
      signInAliases: { username: true }, accountRecovery: cognito.AccountRecovery.NONE,
      passwordPolicy: { minLength: 14, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true },
      mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { otp: true, sms: false },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const client = pool.addClient("AlbClient", {
      generateSecret: true,
      oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID],
        callbackUrls: [`https://${domain}/oauth2/idpresponse`], logoutUrls: [`https://${domain}/`] },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
    });
    const authDomain = pool.addDomain("LoginDomain", {
      cognitoDomain: { domainPrefix: `pai-design-${this.account}` },
    });
    const initializeAdmin = new lambda.Function(this, "InitializeAdmin", {
      runtime: lambda.Runtime.PYTHON_3_14, handler: "index.handler",
      code: lambda.Code.fromInline(readFileSync(resolve("admin.py"), "utf8")),
      timeout: cdk.Duration.seconds(60),
    });
    secret.grantRead(initializeAdmin);
    initializeAdmin.addToRolePolicy(new iam.PolicyStatement({
      actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminSetUserPassword"], resources: [pool.userPoolArn],
    }));
    const provider = new cr.Provider(this, "AdminProvider", { onEventHandler: initializeAdmin });
    new cdk.CustomResource(this, "AdminInitialization", {
      serviceToken: provider.serviceToken,
      properties: { SecretArn: secret.secretArn, PoolId: pool.userPoolId },
    });
    const role = new iam.Role(this, "InstanceRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
    });
    const releasePath = resolve("../.state/deploy/release.tgz");
    const asset = new assets.Asset(this, "Release", {
      path: releasePath,
      assetHash: createHash("sha256").update(readFileSync(releasePath)).digest("hex"),
      assetHashType: cdk.AssetHashType.CUSTOM,
    });
    asset.grantRead(role);
    const data = new ec2.Volume(this, "Data", {
      availabilityZone: zone, size: cdk.Size.gibibytes(40), volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true, removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const ami = new cdk.CfnParameter(this, "UbuntuAmi", {
      type: "AWS::EC2::Image::Id", default: context("amiId"),
      description: "Verified current Ubuntu 24.04 amd64 AMI; reviewed replacement required for upgrades",
    });
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `export PAI_VOLUME_ID='${data.volumeId}'`,
      `export PAI_RELEASE_HASH='${createHash("sha256").update(readFileSync(releasePath)).digest("hex")}'`,
      `export PAI_ASSET_BUCKET='${asset.s3BucketName}'`,
      `export PAI_ASSET_KEY='${asset.s3ObjectKey}'`,
      `export PAI_ALB_ARN='${context("albArn")}'`,
      `export PAI_ISSUER='https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}'`,
      `export PAI_CLIENT_ID='${client.userPoolClientId}'`,
      `export PAI_LOGOUT_URL='https://${authDomain.domainName}.auth.${this.region}.amazoncognito.com/logout?client_id=${client.userPoolClientId}&logout_uri=${encodeURIComponent(`https://${domain}/`)}'`,
      readFileSync(resolve("bootstrap.sh"), "utf8").replace(/^#!.*\n/, ""),
    );
    const instance = new ec2.Instance(this, "Workbench", {
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, role, securityGroup: group,
      instanceType: new ec2.InstanceType("t3.medium"),
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: ami.valueAsString }),
      associatePublicIpAddress: true, requireImdsv2: true,
      blockDevices: [{ deviceName: "/dev/sda1", volume: ec2.BlockDeviceVolume.ebs(16, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userData,
    });
    const attachment = new ec2.CfnVolumeAttachment(this, "DataAttachment", {
      instanceId: instance.instanceId, volumeId: data.volumeId, device: "/dev/sdf",
    });
    attachment.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(this, "ExistingHttps", {
      listenerArn: context("listenerArn"), securityGroup: albSecurityGroup,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "Targets", {
      vpc, port: 4317, protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(instance, 4317)],
      healthCheck: { path: "/healthz", healthyHttpCodes: "200", interval: cdk.Duration.seconds(30),
        healthyThresholdCount: 2, unhealthyThresholdCount: 3 },
      deregistrationDelay: cdk.Duration.seconds(60),
    });
    listener.addAction("PaiRoute", {
      priority: Number(context("rulePriority")), conditions: [elbv2.ListenerCondition.hostHeaders([domain])],
      action: new actions.AuthenticateCognitoAction({
        userPool: pool, userPoolClient: client, userPoolDomain: authDomain,
        sessionCookieName: "PAIAuthSession", sessionTimeout: cdk.Duration.hours(1), scope: "openid",
        onUnauthenticatedRequest: elbv2.UnauthenticatedAction.AUTHENTICATE,
        next: elbv2.ListenerAction.forward([targetGroup]),
      }),
    });
    const vault = new backup.BackupVault(this, "Backups", { removalPolicy: cdk.RemovalPolicy.RETAIN });
    const plan = new backup.BackupPlan(this, "BackupPlan");
    plan.addRule(new backup.BackupPlanRule({
      backupVault: vault, scheduleExpression: cdk.aws_events.Schedule.cron({ hour: "18", minute: "0" }),
      deleteAfter: cdk.Duration.days(14), startWindow: cdk.Duration.hours(1), completionWindow: cdk.Duration.hours(2),
    }));
    plan.addSelection("PersistentState", {
      resources: [backup.BackupResource.fromArn(`arn:aws:ec2:${this.region}:${this.account}:volume/${data.volumeId}`)],
    });
    new cloudwatch.Alarm(this, "InstanceFailure", {
      metric: new cloudwatch.Metric({ namespace: "AWS/EC2", metricName: "StatusCheckFailed", dimensionsMap: { InstanceId: instance.instanceId }, statistic: "Maximum", period: cdk.Duration.minutes(5) }),
      threshold: 1, evaluationPeriods: 2,
    });
    new cloudwatch.Alarm(this, "UnhealthyTarget", {
      metric: targetGroup.metrics.unhealthyHostCount({ period: cdk.Duration.minutes(5), statistic: "Maximum" }),
      threshold: 1, evaluationPeriods: 2,
    });
    const operator = new iam.Role(this, "Operator", {
      roleName: `cdk-hnb659fds-pai-operator-role-${this.account}-${this.region}`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:role/physical-ai-dcv-tokyo`),
      description: "PAI deployment verification and private admin credential retrieval",
    });
    secret.grantRead(operator);
    operator.addToPolicy(new iam.PolicyStatement({
      actions: ["ssm:SendCommand"], resources: [
        `arn:aws:ec2:${this.region}:${this.account}:instance/${instance.instanceId}`,
        `arn:aws:ssm:${this.region}::document/AWS-RunShellScript`,
      ],
    }));
    operator.addToPolicy(new iam.PolicyStatement({ actions: ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"], resources: ["*"] }));
    new cdk.CfnOutput(this, "SiteUrl", { value: `https://${domain}` });
    new cdk.CfnOutput(this, "InstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "VpcId", { value: vpc.vpcId });
    new cdk.CfnOutput(this, "DataVolumeId", { value: data.volumeId });
    new cdk.CfnOutput(this, "TargetGroupArn", { value: targetGroup.targetGroupArn });
    new cdk.CfnOutput(this, "AdminSecretArn", { value: secret.secretArn });
    new cdk.CfnOutput(this, "OperatorRoleArn", { value: operator.roleArn });
    new cdk.CfnOutput(this, "UserPoolId", { value: pool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId });
    new cdk.CfnOutput(this, "ReleaseHash", { value: createHash("sha256").update(readFileSync(releasePath)).digest("hex") });
    new cdk.CfnOutput(this, "ReleaseBucket", { value: asset.s3BucketName });
    new cdk.CfnOutput(this, "ReleaseKey", { value: asset.s3ObjectKey });
  }
}
