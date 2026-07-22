import {
  ArnFormat,
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface BedrockModelAccessConfiguration {
  readonly destinationRegions: readonly string[];
  readonly foundationModelId: string;
  readonly inferenceProfileId: string;
}

export interface BizFlowAgentFoundationStackProps extends StackProps {
  readonly bedrockModelAccess?: BedrockModelAccessConfiguration;
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
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    const allLogGroupsArn = this.formatArn({
      service: "logs",
      resource: "log-group",
      resourceName: "*",
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "ManageRuntimeLogGroups",
        actions: [
          "logs:CreateLogGroup",
          "logs:DescribeLogStreams",
        ],
        resources: [runtimeLogGroupArn],
      }),
    );
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "WriteRuntimeLogStreams",
        actions: [
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: [`${runtimeLogGroupArn}:log-stream:*`],
      }),
    );
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "DescribeRuntimeLogGroups",
        actions: ["logs:DescribeLogGroups"],
        resources: [allLogGroupsArn],
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

    const managedCodeInterpreterArn = this.formatArn({
      service: "bedrock-agentcore",
      account: "aws",
      resource: "code-interpreter",
      resourceName: "*",
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "UseManagedCodeInterpreter",
        actions: [
          "bedrock-agentcore:StartCodeInterpreterSession",
          "bedrock-agentcore:StopCodeInterpreterSession",
          "bedrock-agentcore:GetCodeInterpreterSession",
          "bedrock-agentcore:ListCodeInterpreterSessions",
          "bedrock-agentcore:InvokeCodeInterpreter",
        ],
        resources: [managedCodeInterpreterArn],
      }),
    );

    if (props.bedrockModelAccess !== undefined) {
      this.addBedrockModelAccess(props.bedrockModelAccess);
    }

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
    if (props.bedrockModelAccess !== undefined) {
      new CfnOutput(this, "AllowedBedrockModelId", {
        description: "Bedrock inference profile ID allowed for BizFlow Runtime",
        value: props.bedrockModelAccess.inferenceProfileId,
      });
      new CfnOutput(this, "AllowedBedrockDestinationRegions", {
        description: "Destination Regions allowed for the Bedrock inference profile",
        value: JSON.stringify(props.bedrockModelAccess.destinationRegions),
      });
    }
  }

  private addBedrockModelAccess(
    configuration: BedrockModelAccessConfiguration,
  ): void {
    const inferenceProfileId = validateModelIdentifier(
      "inferenceProfileId",
      configuration.inferenceProfileId,
    );
    const foundationModelId = validateModelIdentifier(
      "foundationModelId",
      configuration.foundationModelId,
    );
    const destinationRegions = Array.from(
      new Set(configuration.destinationRegions.map((region) => region.trim())),
    );
    if (
      destinationRegions.length === 0 ||
      destinationRegions.some((region) => !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region))
    ) {
      throw new Error(
        "bedrockModelAccess.destinationRegions must contain valid AWS Region names.",
      );
    }

    const inferenceProfileArn =
      `arn:${this.partition}:bedrock:${this.region}:${this.account}:` +
      `inference-profile/${inferenceProfileId}`;
    const invokeActions = [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ];

    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBizFlowInferenceProfile",
        actions: invokeActions,
        resources: [inferenceProfileArn],
      }),
    );
    this.runtimeExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: "InvokeBizFlowProfileModels",
        actions: invokeActions,
        resources: destinationRegions.map(
          (region) =>
            `arn:${this.partition}:bedrock:${region}::foundation-model/${foundationModelId}`,
        ),
        conditions: {
          StringEquals: {
            "bedrock:InferenceProfileArn": inferenceProfileArn,
          },
        },
      }),
    );
  }
}

function validateModelIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/.test(normalized)) {
    throw new Error(
      `bedrockModelAccess.${name} must be a valid Bedrock model identifier.`,
    );
  }
  return normalized;
}
