import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";
import { BizFlowAgentRuntimeStack } from "../lib/runtime-stack";

const TEST_DIGEST = `sha256:${"a".repeat(64)}`;

function createRuntimeStack(imageDigest = TEST_DIGEST): BizFlowAgentRuntimeStack {
  const app = new App();
  const foundation = new BizFlowAgentFoundationStack(app, "FoundationTestStack", {
    environmentName: "test",
    env: { account: "111122223333", region: "ap-northeast-1" },
  });
  return new BizFlowAgentRuntimeStack(app, "RuntimeTestStack", {
    environmentName: "test",
    env: { account: "111122223333", region: "ap-northeast-1" },
    executionRole: foundation.runtimeExecutionRole,
    imageDigest,
    networkConfiguration: foundation.networkConfiguration,
    repository: foundation.repository,
  });
}

describe("BizFlowAgentRuntimeStack", () => {
  test("creates an HTTP runtime using an immutable digest URI", () => {
    const template = Template.fromStack(createRuntimeStack());
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", {
      AgentRuntimeName: "BizFlowAgent_test",
      AgentRuntimeArtifact: {
        ContainerConfiguration: {
          ContainerUri: Match.anyValue(),
        },
      },
      NetworkConfiguration: { NetworkMode: "PUBLIC" },
      ProtocolConfiguration: "HTTP",
      RoleArn: Match.anyValue(),
    });
    expect(JSON.stringify(template.toJSON())).toContain(`@${TEST_DIGEST}`);
  });

  test("relies on the service-managed DEFAULT endpoint", () => {
    const template = Template.fromStack(createRuntimeStack());
    template.resourceCountIs("AWS::BedrockAgentCore::RuntimeEndpoint", 0);
    template.hasOutput("AgentRuntimeEndpointName", {
      Value: "DEFAULT",
    });
  });

  test("retains runtime resources except when initial creation rolls back", () => {
    const template = Template.fromStack(createRuntimeStack());
    template.hasResource("AWS::BedrockAgentCore::Runtime", {
      DeletionPolicy: "RetainExceptOnCreate",
      UpdateReplacePolicy: "Retain",
    });
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "RetainExceptOnCreate",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        RetentionInDays: 30,
      }),
    });
  });

  test("exports the normal-update configuration contract", () => {
    const template = Template.fromStack(createRuntimeStack());
    for (const outputName of [
      "EcrRepositoryUri",
      "AgentRuntimeId",
      "AgentRuntimeArn",
      "AgentRuntimeExecutionRoleArn",
      "AgentRuntimeNetworkConfiguration",
      "AgentRuntimeEndpointName",
      "RuntimeLogGroupName",
    ]) {
      template.hasOutput(outputName, {});
    }
  });

  test("rejects a tag or malformed digest", () => {
    expect(() => createRuntimeStack("latest")).toThrow(/agentImageDigest/);
    expect(() => createRuntimeStack("sha256:1234")).toThrow(/agentImageDigest/);
  });
});
