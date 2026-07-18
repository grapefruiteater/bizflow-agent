import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface BizFlowAgentFoundationStackProps extends StackProps {
  readonly environmentName: string;
}

export class BizFlowAgentFoundationStack extends Stack {
  public readonly repository: ecr.Repository;
  public readonly runtimeExecutionRole: iam.Role;
  public readonly networkConfiguration: bedrockagentcore.CfnRuntime.NetworkConfigurationProperty;

  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowAgentFoundationStackProps,
  ) {
    super(scope, id, props);

    this.repository = new ecr.Repository(this, "AgentRepository", {
      repositoryName: `bizflow-agent-${props.environmentName}`,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.AES_256,
      removalPolicy: RemovalPolicy.RETAIN,
      emptyOnDelete: false,
    });

    this.runtimeExecutionRole = new iam.Role(this, "AgentRuntimeExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Execution role dedicated to the BizFlow AgentCore Runtime",
    });

    this.repository.grantPull(this.runtimeExecutionRole);
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "EcrAuthorization",
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      }),
    );

    const runtimeLogGroupArn = this.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: "/aws/bedrock-agentcore/runtimes/*",
    });
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeLogging",
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutLogEvents",
        ],
        resources: [runtimeLogGroupArn, `${runtimeLogGroupArn}:*`],
      }),
    );
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DescribeRuntimeLogGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: ["*"],
      }),
    );

    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeTracing",
        actions: [
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "xray:PutTelemetryRecords",
          "xray:PutTraceSegments",
        ],
        resources: ["*"],
      }),
    );
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "RuntimeMetrics",
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "cloudwatch:namespace": "bedrock-agentcore",
          },
        },
      }),
    );

    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBedrockModels",
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:${this.partition}:bedrock:${this.region}::foundation-model/*`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:${this.partition}:bedrock:${this.region}:${this.account}:application-inference-profile/*`,
        ],
      }),
    );

    this.networkConfiguration = {
      networkMode: "PUBLIC",
    };

    new CfnOutput(this, "EcrRepositoryUri", {
      description: "URI of the dedicated immutable BizFlow Agent ECR repository",
      value: this.repository.repositoryUri,
    });
    new CfnOutput(this, "AgentRuntimeExecutionRoleArn", {
      description: "Execution role ARN reused by AgentCore Runtime updates",
      value: this.runtimeExecutionRole.roleArn,
    });
    new CfnOutput(this, "AgentRuntimeNetworkConfiguration", {
      description: "JSON networkConfiguration reused by AgentCore Runtime updates",
      value: JSON.stringify(this.networkConfiguration),
    });
  }
}
