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

  test("creates retained Memory with an actor-isolated user preference strategy", () => {
    template.hasResource("AWS::BedrockAgentCore::Memory", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        Name: "BizFlowMemory_test",
        Description:
          "BizFlow short term conversations and trusted user preferences",
        EventExpiryDuration: 30,
        Tags: Match.objectLike({
          MemoryScope: "RuntimeSessionAndTrustedUser",
        }),
        MemoryStrategies: [
          {
            UserPreferenceMemoryStrategy: Match.objectLike({
              Name: "BizFlowUserPreference",
              NamespaceTemplates: ["/users/{actorId}/preferences/"],
            }),
          },
        ],
      }),
    });
  });

  test("grants event access and namespace-limited preference retrieval", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "bedrock-agentcore:CreateEvent",
              "bedrock-agentcore:ListEvents",
            ],
            Effect: "Allow",
            Sid: "UseBizFlowShortTermMemory",
          }),
          Match.objectLike({
            Action: "bedrock-agentcore:RetrieveMemoryRecords",
            Condition: {
              StringLike: {
                "bedrock-agentcore:namespace": "/users/*/preferences/",
              },
            },
            Effect: "Allow",
            Sid: "RetrieveBizFlowUserPreferences",
          }),
        ]),
      },
      Roles: ["BizFlowAgentRuntimeRole"],
    });
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain("bedrock-agentcore:DeleteEvent");
    expect(rendered).not.toContain("bedrock-agentcore:DeleteMemoryRecord");
    expect(rendered).not.toContain("bedrock-agentcore:UpdateMemoryRecord");
  });

  test("exports runtime integration values", () => {
    for (const outputName of [
      "AgentMemoryId",
      "AgentMemoryArn",
      "AgentMemoryEventExpiryDays",
      "AgentMemoryUserPreferenceNamespaceTemplate",
      "AgentMemoryLongTermStrategyType",
    ]) {
      template.hasOutput(outputName, {});
    }
  });
});
