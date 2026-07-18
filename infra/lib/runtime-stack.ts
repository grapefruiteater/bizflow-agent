import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

const DEFAULT_ENDPOINT_NAME = "DEFAULT";
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface BizFlowAgentRuntimeStackProps extends StackProps {
  readonly environmentName: string;
  readonly executionRole: iam.IRole;
  readonly imageDigest: string;
  readonly networkConfiguration: bedrockagentcore.CfnRuntime.NetworkConfigurationProperty;
  readonly repository: ecr.IRepository;
}

export class BizFlowAgentRuntimeStack extends Stack {
  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowAgentRuntimeStackProps,
  ) {
    super(scope, id, props);

    const imageDigest = props.imageDigest.trim().toLowerCase();
    if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
      throw new Error(
        "CDK context 'agentImageDigest' must be an ECR digest in the form sha256 followed by 64 lowercase hexadecimal characters.",
      );
    }

    const imageUri = `${props.repository.repositoryUri}@${imageDigest}`;
    const runtimeNameSuffix = props.environmentName.replace(/-/g, "_");
    const runtime = new bedrockagentcore.CfnRuntime(this, "AgentRuntime", {
      agentRuntimeName: `BizFlowAgent_${runtimeNameSuffix}`,
      agentRuntimeArtifact: {
        containerConfiguration: {
          containerUri: imageUri,
        },
      },
      description: "BizFlow Agent HTTP runtime on port 8080",
      networkConfiguration: props.networkConfiguration,
      protocolConfiguration: "HTTP",
      roleArn: props.executionRole.roleArn,
      tags: {
        Application: "BizFlowAgent",
        Environment: props.environmentName,
        ManagedBy: "AWS-CDK",
      },
    });
    runtime.applyRemovalPolicy(RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE);

    const runtimeLogGroup = new logs.LogGroup(this, "RuntimeLogGroup", {
      logGroupName: `/aws/bedrock-agentcore/runtimes/${runtime.attrAgentRuntimeId}-${DEFAULT_ENDPOINT_NAME}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN_ON_UPDATE_OR_DELETE,
    });

    new CfnOutput(this, "EcrRepositoryUri", {
      value: props.repository.repositoryUri,
    });
    new CfnOutput(this, "AgentRuntimeId", {
      value: runtime.attrAgentRuntimeId,
    });
    new CfnOutput(this, "AgentRuntimeArn", {
      value: runtime.attrAgentRuntimeArn,
    });
    new CfnOutput(this, "AgentRuntimeVersion", {
      value: runtime.attrAgentRuntimeVersion,
    });
    new CfnOutput(this, "AgentRuntimeExecutionRoleArn", {
      value: props.executionRole.roleArn,
    });
    new CfnOutput(this, "AgentRuntimeNetworkConfiguration", {
      value: JSON.stringify(props.networkConfiguration),
    });
    new CfnOutput(this, "AgentRuntimeEndpointName", {
      value: DEFAULT_ENDPOINT_NAME,
    });
    new CfnOutput(this, "RuntimeLogGroupName", {
      value: runtimeLogGroup.logGroupName,
    });
    new CfnOutput(this, "InitialAgentImageDigest", {
      value: imageDigest,
    });
    new CfnOutput(this, "InitialAgentImageUri", {
      value: imageUri,
    });
  }
}
