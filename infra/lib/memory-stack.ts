import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

const SHORT_TERM_MEMORY_EXPIRY_DAYS = 30;
export const USER_PREFERENCE_NAMESPACE_TEMPLATE =
  "/users/{actorId}/preferences/";

export interface BizFlowAgentMemoryStackProps extends StackProps {
  readonly environmentName: string;
  readonly runtimeExecutionRoleArn: string;
}

export class BizFlowAgentMemoryStack extends Stack {
  public readonly memory: bedrockagentcore.Memory;

  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowAgentMemoryStackProps,
  ) {
    super(scope, id, props);

    const runtimeExecutionRole = iam.Role.fromRoleArn(
      this,
      "ExistingRuntimeExecutionRole",
      props.runtimeExecutionRoleArn,
      { mutable: true },
    );

    this.memory = new bedrockagentcore.Memory(this, "ConversationMemory", {
      memoryName: `BizFlowMemory_${props.environmentName}`,
      description:
        "BizFlow short term conversations and trusted user preferences",
      expirationDuration: Duration.days(SHORT_TERM_MEMORY_EXPIRY_DAYS),
      tags: {
        Application: "BizFlowAgent",
        Environment: props.environmentName,
        ManagedBy: "AWS-CDK",
        MemoryScope: "RuntimeSessionAndTrustedUser",
      },
    });
    const cfnMemory = this.memory.node.findChild(
      "Memory",
    ) as bedrockagentcore.CfnMemory;
    cfnMemory.memoryStrategies = [
      {
        userPreferenceMemoryStrategy: {
          name: "BizFlowUserPreference",
          description:
            "Remember user preferences from Cognito-authenticated BizFlow sessions",
          namespaceTemplates: [USER_PREFERENCE_NAMESPACE_TEMPLATE],
        },
      },
    ];
    cfnMemory.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const runtimeMemoryPolicy = new iam.Policy(this, "RuntimeMemoryPolicy", {
      statements: [
        new iam.PolicyStatement({
          sid: "UseBizFlowShortTermMemory",
          actions: [
            "bedrock-agentcore:CreateEvent",
            "bedrock-agentcore:ListEvents",
          ],
          resources: [this.memory.memoryArn],
        }),
        new iam.PolicyStatement({
          sid: "RetrieveBizFlowUserPreferences",
          actions: ["bedrock-agentcore:RetrieveMemoryRecords"],
          resources: [this.memory.memoryArn],
          conditions: {
            StringLike: {
              "bedrock-agentcore:namespace": "/users/*/preferences/",
            },
          },
        }),
      ],
    });
    runtimeMemoryPolicy.attachToRole(runtimeExecutionRole);

    new CfnOutput(this, "AgentMemoryId", {
      description: "AgentCore Memory ID supplied to the BizFlow Runtime",
      value: this.memory.memoryId,
    });
    new CfnOutput(this, "AgentMemoryArn", {
      description: "AgentCore Memory ARN used by the Runtime IAM policy",
      value: this.memory.memoryArn,
    });
    new CfnOutput(this, "AgentMemoryEventExpiryDays", {
      description: "Short-term conversation event retention in days",
      value: SHORT_TERM_MEMORY_EXPIRY_DAYS.toString(),
    });
    new CfnOutput(this, "AgentMemoryUserPreferenceNamespaceTemplate", {
      description:
        "Actor-isolated namespace template used for long-term user preferences",
      value: USER_PREFERENCE_NAMESPACE_TEMPLATE,
    });
    new CfnOutput(this, "AgentMemoryLongTermStrategyType", {
      description: "Long-term Memory strategy enabled for BizFlow",
      value: "USER_PREFERENCE",
    });
  }
}
