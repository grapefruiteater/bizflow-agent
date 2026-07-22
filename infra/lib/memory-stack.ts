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
      description: "BizFlow session scoped short term conversation memory",
      expirationDuration: Duration.days(SHORT_TERM_MEMORY_EXPIRY_DAYS),
      tags: {
        Application: "BizFlowAgent",
        Environment: props.environmentName,
        ManagedBy: "AWS-CDK",
        MemoryScope: "RuntimeSession",
      },
    });
    const cfnMemory = this.memory.node.findChild(
      "Memory",
    ) as bedrockagentcore.CfnMemory;
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
  }
}
