import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentMemoryStack } from "../lib/memory-stack";

const TEST_RUNTIME_ROLE_ARN =
  "arn:aws:iam::111122223333:role/BizFlowAgentRuntimeRole";

function createMemoryStack(): BizFlowAgentMemoryStack {
  const app = new App();
  return new BizFlowAgentMemoryStack(app, "MemoryTestStack", {
    environmentName: "test",
    env: { account: "111122223333", region: "ap-northeast-1" },
    runtimeExecutionRoleArn: TEST_RUNTIME_ROLE_ARN,
  });
}

describe("BizFlowAgentMemoryStack", () => {
  const template = Template.fromStack(createMemoryStack());

  test("creates retained short-term memory without extraction strategies", () => {
    template.hasResource("AWS::BedrockAgentCore::Memory", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        Name: "BizFlowMemory_test",
        Description: "BizFlow session scoped short term conversation memory",
        EventExpiryDuration: 30,
        Tags: Match.objectLike({ MemoryScope: "RuntimeSession" }),
      }),
    });
    expect(JSON.stringify(template.toJSON())).not.toContain("MemoryStrategies");
  });

  test("grants only short-term read and write to the existing runtime role", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: [
              "bedrock-agentcore:CreateEvent",
              "bedrock-agentcore:ListEvents",
            ],
            Effect: "Allow",
            Sid: "UseBizFlowShortTermMemory",
          }),
        ],
      },
      Roles: ["BizFlowAgentRuntimeRole"],
    });
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain("bedrock-agentcore:DeleteEvent");
    expect(rendered).not.toContain("bedrock-agentcore:RetrieveMemoryRecords");
  });

  test("exports runtime integration values", () => {
    for (const outputName of [
      "AgentMemoryId",
      "AgentMemoryArn",
      "AgentMemoryEventExpiryDays",
    ]) {
      template.hasOutput(outputName, {});
    }
  });
});
