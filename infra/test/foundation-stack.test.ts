import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";

describe("BizFlowAgentFoundationStack", () => {
  const app = new App();
  const stack = new BizFlowAgentFoundationStack(app, "FoundationTestStack", {
    bedrockModelAccess: {
      inferenceProfileId: "jp.amazon.nova-2-lite-v1:0",
      foundationModelId: "amazon.nova-2-lite-v1:0",
      destinationRegions: ["ap-northeast-1", "ap-northeast-3"],
    },
    environmentName: "test",
    env: { account: "111122223333", region: "ap-northeast-1" },
  });
  const template = Template.fromStack(stack);

  test("creates an immutable scan-on-push ECR repository", () => {
    template.hasResourceProperties("AWS::ECR::Repository", {
      RepositoryName: "bizflow-agent-test",
      ImageTagMutability: "IMMUTABLE",
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
    });
    template.hasResource("AWS::ECR::Repository", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("creates a dedicated AgentCore execution role", () => {
    template.hasResourceProperties("AWS::IAM::Role", {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "ecr:GetAuthorizationToken",
            Resource: "*",
          }),
          Match.objectLike({
            Action: Match.arrayWith([
              "bedrock:InvokeModel",
              "bedrock:InvokeModelWithResponseStream",
            ]),
            Sid: "InvokeBizFlowInferenceProfile",
            Resource: Match.anyValue(),
          }),
          Match.objectLike({
            Sid: "InvokeBizFlowProfileModels",
            Resource: Match.anyValue(),
            Condition: Match.objectLike({
              StringEquals: Match.objectLike({
                "bedrock:InferenceProfileArn": Match.anyValue(),
              }),
            }),
          }),
        ]),
      },
    });
    const synthesizedTemplate = JSON.stringify(template.toJSON());
    expect(synthesizedTemplate).toContain("jp.amazon.nova-2-lite-v1:0");
    expect(synthesizedTemplate).toContain("amazon.nova-2-lite-v1:0");
    expect(synthesizedTemplate).toContain("ap-northeast-3");
  });

  test("uses valid least-privilege CloudWatch Logs ARNs for the runtime", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              "logs:CreateLogGroup",
              "logs:DescribeLogStreams",
            ]),
            Sid: "ManageRuntimeLogGroups",
          }),
          Match.objectLike({
            Action: Match.arrayWith([
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ]),
            Sid: "WriteRuntimeLogStreams",
          }),
          Match.objectLike({
            Action: "logs:DescribeLogGroups",
            Sid: "DescribeRuntimeLogGroups",
          }),
        ]),
      },
    });

    const synthesizedTemplate = JSON.stringify(template.toJSON());
    expect(synthesizedTemplate).toContain(
      "log-group:/aws/bedrock-agentcore/runtimes/*",
    );
    expect(synthesizedTemplate).toContain(":log-stream:*");
    expect(synthesizedTemplate).not.toContain(
      "log-group//aws/bedrock-agentcore/runtimes",
    );
  });

  test("allows sessions only on the AWS-managed Code Interpreter", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "bedrock-agentcore:StartCodeInterpreterSession",
              "bedrock-agentcore:StopCodeInterpreterSession",
              "bedrock-agentcore:GetCodeInterpreterSession",
              "bedrock-agentcore:ListCodeInterpreterSessions",
              "bedrock-agentcore:InvokeCodeInterpreter",
            ],
            Resource: Match.anyValue(),
            Sid: "UseManagedCodeInterpreter",
          }),
        ]),
      },
    });

    const synthesizedTemplate = JSON.stringify(template.toJSON());
    expect(synthesizedTemplate).toContain("bedrock-agentcore");
    expect(synthesizedTemplate).toContain("ap-northeast-1");
    expect(synthesizedTemplate).toContain(":aws:code-interpreter/*");
    expect(synthesizedTemplate).not.toContain(
      "bedrock-agentcore:CreateCodeInterpreter",
    );
    expect(synthesizedTemplate).not.toContain(
      "bedrock-agentcore:DeleteCodeInterpreter",
    );
  });

  test("exports values needed by the initial runtime deployment", () => {
    template.hasOutput("EcrRepositoryUri", {});
    template.hasOutput("AgentRuntimeExecutionRoleArn", {});
    template.hasOutput("AgentRuntimeNetworkConfiguration", {
      Value: '{"networkMode":"PUBLIC"}',
    });
    template.hasOutput("AllowedBedrockModelId", {
      Value: "jp.amazon.nova-2-lite-v1:0",
    });
    template.hasOutput("AllowedBedrockDestinationRegions", {
      Value: '["ap-northeast-1","ap-northeast-3"]',
    });
  });

  test("rejects malformed Bedrock model access settings", () => {
    expect(
      () =>
        new BizFlowAgentFoundationStack(new App(), "InvalidModelStack", {
          environmentName: "test",
          env: { account: "111122223333", region: "ap-northeast-1" },
          bedrockModelAccess: {
            inferenceProfileId: "invalid model",
            foundationModelId: "amazon.nova-2-lite-v1:0",
            destinationRegions: ["ap-northeast-1"],
          },
        }),
    ).toThrow(/inferenceProfileId/);
  });
});
