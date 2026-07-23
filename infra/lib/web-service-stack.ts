import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as elbv2Actions from "aws-cdk-lib/aws-elasticloadbalancingv2-actions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface BizFlowWebServiceStackProps extends StackProps {
  readonly agentRuntimeArn: string;
  readonly approvalFunctionName: string;
  readonly availabilityZones: string[];
  readonly clusterName: string;
  readonly endpointName: string;
  readonly environmentName: string;
  readonly httpsListenerArn: string;
  readonly imageDigest: string;
  readonly privateSubnetIds: string[];
  readonly privateSubnetRouteTableIds: string[];
  readonly readToolsFunctionName: string;
  readonly repositoryArn: string;
  readonly repositoryName: string;
  readonly userPoolClientId: string;
  readonly userPoolDomainName: string;
  readonly userPoolId: string;
  readonly vpcId: string;
  readonly webAlbSecurityGroupId: string;
  readonly webUrl: string;
  readonly writeToolsFunctionName: string;
}

export class BizFlowWebServiceStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowWebServiceStackProps,
  ) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromVpcAttributes(this, "ImportedWebVpc", {
      vpcId: props.vpcId,
      availabilityZones: props.availabilityZones,
      privateSubnetIds: props.privateSubnetIds,
      privateSubnetRouteTableIds: props.privateSubnetRouteTableIds,
    });
    const albSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "ImportedWebAlbSecurityGroup",
      props.webAlbSecurityGroupId,
    );
    const cluster = ecs.Cluster.fromClusterAttributes(this, "ImportedWebCluster", {
      clusterName: props.clusterName,
      vpc,
      securityGroups: [],
    });
    const repository = ecr.Repository.fromRepositoryAttributes(
      this,
      "ImportedWebRepository",
      {
        repositoryArn: props.repositoryArn,
        repositoryName: props.repositoryName,
      },
    );

    const logGroup = new logs.LogGroup(this, "WebLogGroup", {
      logGroupName: `/ecs/bizflow-web-${props.environmentName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, "WebTaskDefinition", {
      family: `bizflow-web-${props.environmentName}`,
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBizFlowAgentRuntime",
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [props.agentRuntimeArn],
      }),
    );
    const readToolsFunctionArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: props.readToolsFunctionName,
    });
    const writeToolsFunctionArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: props.writeToolsFunctionName,
    });
    const approvalFunctionArn = this.formatArn({
      service: "lambda",
      resource: "function",
      resourceName: props.approvalFunctionName,
    });
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBizFlowBusinessApis",
        actions: ["lambda:InvokeFunction"],
        resources: [
          readToolsFunctionArn,
          writeToolsFunctionArn,
          approvalFunctionArn,
        ],
      }),
    );

    taskDefinition.addVolume({ name: "NextCache" });
    taskDefinition.addVolume({ name: "Temp" });
    const container = taskDefinition.addContainer("WebContainer", {
      containerName: "bizflow-web",
      image: ecs.ContainerImage.fromEcrRepository(repository, props.imageDigest),
      logging: ecs.LogDrivers.awsLogs({
        logGroup,
        streamPrefix: "web",
      }),
      environment: {
        AWS_REGION: this.region,
        BIZFLOW_LOCAL_DEMO: "false",
        BIZFLOW_AGENT_RUNTIME_ARN: props.agentRuntimeArn,
        BIZFLOW_AGENT_ENDPOINT_NAME: props.endpointName,
        BIZFLOW_READ_TOOLS_FUNCTION_NAME: props.readToolsFunctionName,
        BIZFLOW_WRITE_TOOLS_FUNCTION_NAME: props.writeToolsFunctionName,
        BIZFLOW_APPROVAL_FUNCTION_NAME: props.approvalFunctionName,
        BIZFLOW_DATA_START_DATE: "2026-07-09",
        BIZFLOW_DATA_END_DATE: "2026-07-13",
        BIZFLOW_ANALYSIS_AS_OF: "2026-07-14",
      },
      readonlyRootFilesystem: true,
      healthCheck: {
        command: [
          "CMD-SHELL",
          "wget -q -O - http://127.0.0.1:3000/api/health >/dev/null || exit 1",
        ],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });
    container.addPortMappings({
      containerPort: 3000,
      protocol: ecs.Protocol.TCP,
      name: "http",
    });
    container.addMountPoints(
      { sourceVolume: "NextCache", containerPath: "/app/.next/cache", readOnly: false },
      { sourceVolume: "Temp", containerPath: "/tmp", readOnly: false },
    );

    const taskSecurityGroup = new ec2.SecurityGroup(this, "WebTaskSecurityGroup", {
      vpc,
      description: "Only the BizFlow ALB can reach Next.js tasks",
      allowAllOutbound: true,
    });
    taskSecurityGroup.addIngressRule(
      albSecurityGroup,
      ec2.Port.tcp(3000),
      "ALB to Next.js",
    );
    const service = new ecs.FargateService(this, "WebService", {
      serviceName: `bizflow-web-${props.environmentName}`,
      cluster,
      taskDefinition,
      desiredCount: 1,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSecurityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, "WebTargetGroup", {
      targetGroupName: `bizflow-web-${props.environmentName}`,
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: "/api/health",
        healthyHttpCodes: "200",
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
      },
      deregistrationDelay: Duration.seconds(30),
    });
    targetGroup.addTarget(service);

    const listener = elbv2.ApplicationListener.fromApplicationListenerAttributes(
      this,
      "ImportedHttpsListener",
      {
        listenerArn: props.httpsListenerArn,
        securityGroup: albSecurityGroup,
      },
    );
    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "ImportedWebUserPool",
      props.userPoolId,
    );
    const userPoolClient = cognito.UserPoolClient.fromUserPoolClientId(
      this,
      "ImportedWebUserPoolClient",
      props.userPoolClientId,
    );
    const userPoolDomain = cognito.UserPoolDomain.fromDomainName(
      this,
      "ImportedWebUserPoolDomain",
      props.userPoolDomainName,
    );
    new elbv2.ApplicationListenerRule(this, "AuthenticatedWebRule", {
      listener,
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(["/*"])],
      action: new elbv2Actions.AuthenticateCognitoAction({
        userPool,
        userPoolClient,
        userPoolDomain,
        next: elbv2.ListenerAction.forward([targetGroup]),
        sessionCookieName: "BizFlowAuthSession",
        sessionTimeout: Duration.hours(8),
      }),
    });

    const scaling = service.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 });
    scaling.scaleOnCpuUtilization("WebCpuScaling", {
      targetUtilizationPercent: 60,
      scaleInCooldown: Duration.minutes(5),
      scaleOutCooldown: Duration.minutes(1),
    });

    new CfnOutput(this, "WebServiceName", { value: service.serviceName });
    new CfnOutput(this, "WebTaskRoleArn", {
      value: taskDefinition.taskRole.roleArn,
    });
    new CfnOutput(this, "WebTargetGroupArn", {
      value: targetGroup.targetGroupArn,
    });
    new CfnOutput(this, "WebImageDigest", { value: props.imageDigest });
    new CfnOutput(this, "WebUrl", { value: props.webUrl });
  }
}
