import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as bedrockagentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

const READ_TOOL_NAMES = [
  "get_business_requests",
  "analyze_request_data",
  "search_company_rules",
  "get_task_status",
] as const;
const WRITE_TOOL_NAMES = ["create_business_task"] as const;
const DATA_PREFIX = "portfolio-data";

export interface BizFlowAgentToolsStackProps extends StackProps {
  readonly environmentName: string;
  readonly runtimeExecutionRoleArn: string;
}

export class BizFlowAgentToolsStack extends Stack {
  public readonly approvalWorkflowFunction: lambda.Function;
  public readonly dataBucket: s3.Bucket;
  public readonly gateway: bedrockagentcore.Gateway;
  public readonly readToolsFunction: lambda.Function;
  public readonly workflowTable: dynamodb.Table;
  public readonly writeToolsFunction: lambda.Function;

  public constructor(
    scope: Construct,
    id: string,
    props: BizFlowAgentToolsStackProps,
  ) {
    super(scope, id, props);

    const runtimeExecutionRole = iam.Role.fromRoleArn(
      this,
      "ExistingRuntimeExecutionRole",
      props.runtimeExecutionRoleArn,
      { mutable: true },
    );

    this.dataBucket = new s3.Bucket(this, "BusinessDataBucket", {
      bucketName: undefined,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const dataSourcePath = join(
      __dirname,
      "../../lambdas/business_tools/data",
    );
    new s3deploy.BucketDeployment(this, "SyntheticDataDeployment", {
      destinationBucket: this.dataBucket,
      destinationKeyPrefix: DATA_PREFIX,
      sources: [s3deploy.Source.asset(dataSourcePath)],
      prune: false,
      retainOnDelete: true,
    });

    this.workflowTable = new dynamodb.Table(this, "WorkflowTable", {
      tableName: `bizflow-workflow-${props.environmentName}`,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const lambdaCode = lambda.Code.fromAsset(join(__dirname, "../../lambdas"));
    this.readToolsFunction = this.createToolFunction(
      "ReadToolsFunction",
      `bizflow-read-tools-${props.environmentName}`,
      lambdaCode,
      READ_TOOL_NAMES,
      {
        BIZFLOW_DATA_BUCKET: this.dataBucket.bucketName,
        BIZFLOW_REQUESTS_KEY: `${DATA_PREFIX}/business_requests.csv`,
        BIZFLOW_RULES_KEY: `${DATA_PREFIX}/company_rules.md`,
        BIZFLOW_WORKFLOW_TABLE: this.workflowTable.tableName,
      },
    );
    this.readToolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadSyntheticBusinessData",
        actions: ["s3:GetObject"],
        resources: [this.dataBucket.arnForObjects(`${DATA_PREFIX}/*`)],
      }),
    );
    this.readToolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ReadWorkflowState",
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [this.workflowTable.tableArn],
      }),
    );

    this.writeToolsFunction = this.createToolFunction(
      "WriteToolsFunction",
      `bizflow-write-tools-${props.environmentName}`,
      lambdaCode,
      WRITE_TOOL_NAMES,
      {
        BIZFLOW_WORKFLOW_TABLE: this.workflowTable.tableName,
      },
    );
    this.writeToolsFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "CreateApprovedBusinessTask",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
        ],
        resources: [this.workflowTable.tableArn],
      }),
    );

    this.approvalWorkflowFunction = this.createApprovalWorkflowFunction(
      lambdaCode,
      this.workflowTable.tableName,
      props.environmentName,
    );
    this.approvalWorkflowFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "ManageApprovalWorkflow",
        actions: [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem",
        ],
        resources: [this.workflowTable.tableArn],
      }),
    );

    this.gateway = new bedrockagentcore.Gateway(this, "BusinessToolsGateway", {
      gatewayName: `bizflow-tools-${props.environmentName}`,
      description: "BizFlow portfolio business tools",
      authorizerConfiguration:
        bedrockagentcore.GatewayAuthorizer.usingAwsIam(),
      protocolConfiguration: bedrockagentcore.GatewayProtocol.mcp({
        supportedVersions: [
          bedrockagentcore.MCPProtocolVersion.MCP_2025_06_18,
        ],
        instructions:
          "Use read tools for analysis. Invoke create_business_task only with a server-issued approval ID.",
      }),
      tags: {
        Application: "BizFlowAgent",
        Environment: props.environmentName,
        ManagedBy: "AWS-CDK",
      },
    });
    this.gateway.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const allTools = loadToolDefinitions(
      join(__dirname, "../../lambdas/business_tools/tool-schema.json"),
    );
    const readTarget = this.gateway.addLambdaTarget("ReadToolsTarget", {
      gatewayTargetName: "BizFlowReadTools",
      description: "Read-only business request, analysis, rule, and task tools",
      lambdaFunction: this.readToolsFunction,
      toolSchema: bedrockagentcore.ToolSchema.fromInline(
        selectTools(allTools, READ_TOOL_NAMES),
      ),
    });
    readTarget.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const writeTarget = this.gateway.addLambdaTarget("WriteToolsTarget", {
      gatewayTargetName: "BizFlowWriteTools",
      description: "Approval-enforced business task creation tool",
      lambdaFunction: this.writeToolsFunction,
      toolSchema: bedrockagentcore.ToolSchema.fromInline(
        selectTools(allTools, WRITE_TOOL_NAMES),
      ),
    });
    writeTarget.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const runtimeGatewayPolicy = new iam.Policy(
      this,
      "RuntimeGatewayInvokePolicy",
      {
        statements: [
          new iam.PolicyStatement({
            sid: "InvokeBizFlowToolsGateway",
            actions: bedrockagentcore.GATEWAY_INVOKE_PERMS,
            resources: [this.gateway.gatewayArn],
          }),
        ],
      },
    );
    runtimeGatewayPolicy.attachToRole(runtimeExecutionRole);

    new CfnOutput(this, "BusinessDataBucketName", {
      value: this.dataBucket.bucketName,
    });
    new CfnOutput(this, "WorkflowTableName", {
      value: this.workflowTable.tableName,
    });
    new CfnOutput(this, "BusinessToolsGatewayArn", {
      value: this.gateway.gatewayArn,
    });
    new CfnOutput(this, "BusinessToolsGatewayId", {
      value: this.gateway.gatewayId,
    });
    new CfnOutput(this, "BusinessToolsGatewayUrl", {
      value: this.gateway.gatewayUrl ?? "",
    });
    new CfnOutput(this, "ReadToolsFunctionName", {
      value: this.readToolsFunction.functionName,
    });
    new CfnOutput(this, "WriteToolsFunctionName", {
      value: this.writeToolsFunction.functionName,
    });
    new CfnOutput(this, "ApprovalWorkflowFunctionName", {
      description: "Lambda function invoked by the future trusted BFF approval API",
      value: this.approvalWorkflowFunction.functionName,
    });
    new CfnOutput(this, "ApprovalWorkflowFunctionArn", {
      description: "ARN used to grant the future BFF least-privilege invoke access",
      value: this.approvalWorkflowFunction.functionArn,
    });
  }

  private createApprovalWorkflowFunction(
    code: lambda.Code,
    workflowTableName: string,
    environmentName: string,
  ): lambda.Function {
    const functionName = `bizflow-approval-workflow-${environmentName}`;
    const logGroup = new logs.LogGroup(this, "ApprovalWorkflowFunctionLogGroup", {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    return new lambda.Function(this, "ApprovalWorkflowFunction", {
      functionName,
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "approval_workflow.lambda_function.lambda_handler",
      code,
      description: "Trusted BizFlow approval workflow backend for the future BFF",
      timeout: Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        BIZFLOW_WORKFLOW_TABLE: workflowTableName,
      },
    });
  }

  private createToolFunction(
    id: string,
    functionName: string,
    code: lambda.Code,
    allowedTools: readonly string[],
    environment: Record<string, string>,
  ): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    return new lambda.Function(this, id, {
      functionName,
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: "business_tools.lambda_function.lambda_handler",
      code,
      description: "BizFlow AgentCore Gateway Lambda target",
      timeout: Duration.seconds(30),
      memorySize: 256,
      reservedConcurrentExecutions: 5,
      tracing: lambda.Tracing.ACTIVE,
      logGroup,
      environment: {
        ...environment,
        BIZFLOW_ALLOWED_TOOLS: allowedTools.join(","),
      },
    });
  }
}

interface RawSchemaDefinition {
  readonly type: string;
  readonly description?: string;
  readonly items?: RawSchemaDefinition;
  readonly properties?: Record<string, RawSchemaDefinition>;
  readonly required?: string[];
}

interface RawToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: RawSchemaDefinition;
  readonly outputSchema?: RawSchemaDefinition;
}

function loadToolDefinitions(
  schemaPath: string,
): bedrockagentcore.ToolDefinition[] {
  const parsed: unknown = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("BizFlow tool schema must contain at least one tool.");
  }
  const rawTools = parsed as RawToolDefinition[];
  const names = rawTools.map((tool) => tool.name);
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error("Every BizFlow tool schema entry must have a name.");
  }
  if (new Set(names).size !== names.length) {
    throw new Error("BizFlow tool schema names must be unique.");
  }
  return rawTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: convertSchemaDefinition(tool.inputSchema),
    outputSchema:
      tool.outputSchema === undefined
        ? undefined
        : convertSchemaDefinition(tool.outputSchema),
  }));
}

function selectTools(
  tools: bedrockagentcore.ToolDefinition[],
  names: readonly string[],
): bedrockagentcore.ToolDefinition[] {
  const selected = names.map((name) => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new Error(`Tool '${name}' was not found in tool-schema.json.`);
    }
    return tool;
  });
  return selected;
}

function convertSchemaDefinition(
  raw: RawSchemaDefinition,
): bedrockagentcore.SchemaDefinition {
  if (raw === null || typeof raw !== "object" || typeof raw.type !== "string") {
    throw new Error("Tool schema definitions must have a type.");
  }
  return {
    type: schemaDefinitionType(raw.type),
    description: raw.description,
    items:
      raw.items === undefined ? undefined : convertSchemaDefinition(raw.items),
    properties:
      raw.properties === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(raw.properties).map(([name, definition]) => [
              name,
              convertSchemaDefinition(definition),
            ]),
          ),
    required: raw.required,
  };
}

function schemaDefinitionType(
  value: string,
): bedrockagentcore.SchemaDefinitionType {
  const types: Record<string, bedrockagentcore.SchemaDefinitionType> = {
    array: bedrockagentcore.SchemaDefinitionType.ARRAY,
    boolean: bedrockagentcore.SchemaDefinitionType.BOOLEAN,
    integer: bedrockagentcore.SchemaDefinitionType.INTEGER,
    number: bedrockagentcore.SchemaDefinitionType.NUMBER,
    object: bedrockagentcore.SchemaDefinitionType.OBJECT,
    string: bedrockagentcore.SchemaDefinitionType.STRING,
  };
  const result = types[value];
  if (result === undefined) {
    throw new Error(`Unsupported tool schema type '${value}'.`);
  }
  return result;
}
