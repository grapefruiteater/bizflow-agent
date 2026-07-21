import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";
import { BizFlowAgentRuntimeStack } from "../lib/runtime-stack";

const TEST_DIGEST = `sha256:${"a".repeat(64)}`;
const TEST_MODEL_ID = "example.model-v1:0";

function createRuntimeStack(
  imageDigest = TEST_DIGEST,
  modelId = TEST_MODEL_ID,
): BizFlowAgentRuntimeStack {
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
    modelId,
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
      EnvironmentVariables: {
        BIZFLOW_AWS_REGION: "ap-northeast-1",
        BIZFLOW_MODEL_ID: TEST_MODEL_ID,
        BIZFLOW_MODEL_PROVIDER: "bedrock",
      },
      ProtocolConfiguration: "HTTP",
      RoleArn: Match.anyValue(),
    });
    expect(JSON.stringify(template.toJSON())).toContain(`@${TEST_DIGEST}`);
  });

  test("adds a version-pinned PROD endpoint alongside service-managed DEFAULT", () => {
    const template = Template.fromStack(createRuntimeStack());
    template.resourceCountIs("AWS::BedrockAgentCore::RuntimeEndpoint", 1);
    template.hasResourceProperties("AWS::BedrockAgentCore::RuntimeEndpoint", {
      AgentRuntimeId: Match.anyValue(),
      AgentRuntimeVersion: Match.anyValue(),
      Name: "PROD",
    });
    template.hasOutput("AgentRuntimeEndpointName", {
      Value: "PROD",
    });
  });

  test("retains runtime and endpoint resources except when initial creation rolls back", () => {
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
    template.resourceCountIs("AWS::Logs::LogGroup", 2);
    template.hasResource("AWS::BedrockAgentCore::RuntimeEndpoint", {
      DeletionPolicy: "RetainExceptOnCreate",
      UpdateReplacePolicy: "Retain",
    });
    expect(JSON.stringify(template.toJSON())).toContain("-DEFAULT");
    expect(JSON.stringify(template.toJSON())).toContain("-PROD");
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
      "AgentRuntimeEndpointArn",
      "RuntimeLogGroupName",
      "DefaultRuntimeLogGroupName",
      "InitialBedrockModelId",
    ]) {
      template.hasOutput(outputName, {});
    }
  });

  test("rejects a tag or malformed digest", () => {
    expect(() => createRuntimeStack("latest")).toThrow(/agentImageDigest/);
    expect(() => createRuntimeStack("sha256:1234")).toThrow(/agentImageDigest/);
  });

  test("rejects a missing or malformed model ID", () => {
    expect(() => createRuntimeStack(TEST_DIGEST, "   ")).toThrow(/bedrockModelId/);
    expect(() => createRuntimeStack(TEST_DIGEST, "model\ninvalid")).toThrow(
      /bedrockModelId/,
    );
  });
});
