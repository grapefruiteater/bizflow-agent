import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";

describe("BizFlowAgentFoundationStack", () => {
  const app = new App();
  const stack = new BizFlowAgentFoundationStack(app, "FoundationTestStack", {
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
          }),
        ]),
      },
    });
  });

  test("exports values needed by the initial runtime deployment", () => {
    template.hasOutput("EcrRepositoryUri", {});
    template.hasOutput("AgentRuntimeExecutionRoleArn", {});
    template.hasOutput("AgentRuntimeNetworkConfiguration", {
      Value: '{"networkMode":"PUBLIC"}',
    });
  });
});
