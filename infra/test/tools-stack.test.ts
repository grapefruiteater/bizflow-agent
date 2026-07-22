import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { BizFlowAgentToolsStack } from "../lib/tools-stack";

const TEST_RUNTIME_ROLE_ARN =
  "arn:aws:iam::111122223333:role/BizFlowAgentRuntimeRole";

function createToolsStack(): BizFlowAgentToolsStack {
  const app = new App();
  const env = { account: "111122223333", region: "ap-northeast-1" };
  return new BizFlowAgentToolsStack(app, "ToolsTestStack", {
    environmentName: "test",
    env,
    runtimeExecutionRoleArn: TEST_RUNTIME_ROLE_ARN,
  });
}

describe("BizFlowAgentToolsStack", () => {
  const template = Template.fromStack(createToolsStack());

  test("retains protected synthetic data storage", () => {
    template.hasResource("AWS::S3::Bucket", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BucketEncryption: Match.anyValue(),
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        VersioningConfiguration: { Status: "Enabled" },
      }),
    });
    template.hasResourceProperties("Custom::CDKBucketDeployment", {
      DestinationBucketKeyPrefix: "portfolio-data",
      Prune: false,
      RetainOnDelete: true,
    });
    template.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: Match.objectLike({
        BillingMode: "PAY_PER_REQUEST",
        DeletionProtectionEnabled: true,
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
        TableName: "bizflow-workflow-test",
      }),
    });
  });

  test("uses separate arm64 Lambda functions for read and write tools", () => {
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      FunctionName: "bizflow-read-tools-test",
      Handler: "business_tools.lambda_function.lambda_handler",
      Runtime: "python3.12",
      Environment: {
        Variables: Match.objectLike({
          BIZFLOW_ALLOWED_TOOLS:
            "get_business_requests,analyze_request_data,search_company_rules,get_task_status",
          BIZFLOW_DATA_BUCKET: Match.anyValue(),
          BIZFLOW_WORKFLOW_TABLE: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties("AWS::Lambda::Function", {
      Architectures: ["arm64"],
      FunctionName: "bizflow-write-tools-test",
      Handler: "business_tools.lambda_function.lambda_handler",
      Runtime: "python3.12",
      Environment: {
        Variables: {
          BIZFLOW_ALLOWED_TOOLS: "create_business_task",
          BIZFLOW_WORKFLOW_TABLE: Match.anyValue(),
        },
      },
    });
  });

  test("keeps data permissions least-privilege and separated", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "s3:GetObject",
            Sid: "ReadSyntheticBusinessData",
          }),
          Match.objectLike({
            Action: ["dynamodb:GetItem", "dynamodb:Query"],
            Sid: "ReadWorkflowState",
          }),
        ]),
      },
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            Sid: "CreateApprovedBusinessTask",
          }),
        ]),
      },
    });
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain("dynamodb:DeleteItem");
    expect(rendered).not.toContain("dynamodb:Scan");
  });

  test("publishes four read tools and one approval-enforced write tool", () => {
    template.hasResourceProperties("AWS::BedrockAgentCore::Gateway", {
      AuthorizerType: "AWS_IAM",
      Name: "bizflow-tools-test",
      ProtocolConfiguration: {
        Mcp: Match.objectLike({ SupportedVersions: ["2025-06-18"] }),
      },
      ProtocolType: "MCP",
    });
    template.resourceCountIs("AWS::BedrockAgentCore::GatewayTarget", 2);
    template.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
      Name: "BizFlowReadTools",
      TargetConfiguration: {
        Mcp: {
          Lambda: Match.objectLike({
            ToolSchema: {
              InlinePayload: Match.arrayWith([
                Match.objectLike({ Name: "get_business_requests" }),
                Match.objectLike({ Name: "analyze_request_data" }),
                Match.objectLike({ Name: "search_company_rules" }),
                Match.objectLike({ Name: "get_task_status" }),
              ]),
            },
          }),
        },
      },
    });
    template.hasResourceProperties("AWS::BedrockAgentCore::GatewayTarget", {
      Name: "BizFlowWriteTools",
      TargetConfiguration: {
        Mcp: {
          Lambda: Match.objectLike({
            ToolSchema: {
              InlinePayload: [
                Match.objectLike({ Name: "create_business_task" }),
              ],
            },
          }),
        },
      },
    });
  });

  test("allows only the runtime role to invoke this Gateway", () => {
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: "bedrock-agentcore:InvokeGateway",
            Sid: "InvokeBizFlowToolsGateway",
          }),
        ],
      },
      Roles: ["BizFlowAgentRuntimeRole"],
    });
    expect(JSON.stringify(template.toJSON())).not.toContain("Fn::ImportValue");
  });

  test("exports integration values for the runtime and future web app", () => {
    for (const outputName of [
      "BusinessDataBucketName",
      "WorkflowTableName",
      "BusinessToolsGatewayArn",
      "BusinessToolsGatewayId",
      "BusinessToolsGatewayUrl",
      "ReadToolsFunctionName",
      "WriteToolsFunctionName",
    ]) {
      template.hasOutput(outputName, {});
    }
  });
});
