#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { App, Environment, Tags } from "aws-cdk-lib";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";
import { BizFlowAgentRuntimeStack } from "../lib/runtime-stack";
import { BizFlowAgentToolsStack } from "../lib/tools-stack";

const app = new App();
const environmentName = readEnvironmentName(app);
const bedrockModelAccess = readBedrockModelAccess(app);
const deploymentEnvironment: Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const foundationStack = new BizFlowAgentFoundationStack(
  app,
  "BizFlowAgentFoundationStack",
  {
    env: deploymentEnvironment,
    description: "Dedicated ECR and IAM foundation for the BizFlow AgentCore Runtime",
    bedrockModelAccess,
    environmentName,
  },
);

Tags.of(foundationStack).add("Application", "BizFlowAgent");
Tags.of(foundationStack).add("Environment", environmentName);
Tags.of(foundationStack).add("ManagedBy", "AWS-CDK");

const enableTools = readBooleanContext(app, "enableTools", false);
if (enableTools) {
  const runtimeExecutionRoleArn = readRuntimeExecutionRoleArn(app);
  const toolsStack = new BizFlowAgentToolsStack(app, "BizFlowAgentToolsStack", {
    env: deploymentEnvironment,
    description: "Synthetic data and AgentCore Gateway tools for BizFlow Agent",
    environmentName,
    runtimeExecutionRoleArn,
  });
  Tags.of(toolsStack).add("Application", "BizFlowAgent");
  Tags.of(toolsStack).add("Environment", environmentName);
  Tags.of(toolsStack).add("ManagedBy", "AWS-CDK");
}

const imageDigest = app.node.tryGetContext("agentImageDigest") as string | undefined;
if (imageDigest !== undefined && imageDigest.trim().length > 0) {
  if (bedrockModelAccess === undefined) {
    throw new Error(
      "Bedrock model access contexts are required when 'agentImageDigest' is specified.",
    );
  }
  const runtimeStack = new BizFlowAgentRuntimeStack(app, "BizFlowAgentRuntimeStack", {
    env: deploymentEnvironment,
    description: "Initial Amazon Bedrock AgentCore Runtime for BizFlow Agent",
    environmentName,
    executionRole: foundationStack.runtimeExecutionRole,
    imageDigest,
    modelId: bedrockModelAccess.inferenceProfileId,
    networkConfiguration: foundationStack.networkConfiguration,
    repository: foundationStack.repository,
  });

  runtimeStack.addDependency(foundationStack);
  Tags.of(runtimeStack).add("Application", "BizFlowAgent");
  Tags.of(runtimeStack).add("Environment", environmentName);
  Tags.of(runtimeStack).add("ManagedBy", "AWS-CDK");
}

app.synth();

function readEnvironmentName(cdkApp: App): string {
  const value = String(cdkApp.node.tryGetContext("environment") ?? "dev");
  if (!/^[a-z][a-z0-9-]{0,15}$/.test(value)) {
    throw new Error(
      "CDK context 'environment' must start with a lowercase letter and contain at most 16 lowercase letters, digits, or hyphens.",
    );
  }
  return value;
}

function readBooleanContext(
  cdkApp: App,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = cdkApp.node.tryGetContext(name) as unknown;
  if (value === undefined) {
    return defaultValue;
  }
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  throw new Error(`CDK context '${name}' must be true or false.`);
}

function readRuntimeExecutionRoleArn(cdkApp: App): string {
  const contextValue = String(
    cdkApp.node.tryGetContext("runtimeExecutionRoleArn") ?? "",
  ).trim();
  const value = contextValue || readRuntimeRoleArnFromOutputs(cdkApp);
  const match = /^arn:[a-z0-9-]+:iam::([0-9]{12}):role\/[A-Za-z0-9+=,.@_\/-]+$/.exec(
    value,
  );
  if (match === null) {
    throw new Error(
      "AgentRuntimeExecutionRoleArn must be a valid IAM role ARN from the deployed BizFlow Runtime outputs when 'enableTools=true'.",
    );
  }
  const deploymentAccount = process.env.CDK_DEFAULT_ACCOUNT;
  if (
    deploymentAccount !== undefined &&
    deploymentAccount.length > 0 &&
    match[1] !== deploymentAccount
  ) {
    throw new Error(
      "AgentRuntimeExecutionRoleArn must belong to CDK_DEFAULT_ACCOUNT.",
    );
  }
  return value;
}

function readRuntimeRoleArnFromOutputs(cdkApp: App): string {
  const configuredPath = String(
    cdkApp.node.tryGetContext("runtimeConfigPath") ?? "",
  ).trim();
  const configPath = configuredPath
    ? isAbsolute(configuredPath)
      ? configuredPath
      : resolve(process.cwd(), configuredPath)
    : join(__dirname, "../../config/cdk-outputs.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read Runtime outputs from '${configPath}'. Specify CDK context 'runtimeExecutionRoleArn' or a valid 'runtimeConfigPath'. ${detail}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(`Runtime outputs file '${configPath}' must contain a JSON object.`);
  }

  const candidates = new Set<string>();
  collectRuntimeRoleArn(parsed, candidates);
  for (const value of Object.values(parsed)) {
    if (isRecord(value)) {
      collectRuntimeRoleArn(value, candidates);
    }
  }
  if (candidates.size !== 1) {
    throw new Error(
      `Runtime outputs file '${configPath}' must contain exactly one unique AgentRuntimeExecutionRoleArn value.`,
    );
  }
  return [...candidates][0] as string;
}

function collectRuntimeRoleArn(
  value: Record<string, unknown>,
  candidates: Set<string>,
): void {
  const roleArn = value.AgentRuntimeExecutionRoleArn;
  if (typeof roleArn === "string" && roleArn.trim()) {
    candidates.add(roleArn.trim());
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBedrockModelAccess(cdkApp: App):
  | {
      destinationRegions: string[];
      foundationModelId: string;
      inferenceProfileId: string;
    }
  | undefined {
  const inferenceProfileId = String(
    cdkApp.node.tryGetContext("bedrockModelId") ?? "",
  ).trim();
  const foundationModelId = String(
    cdkApp.node.tryGetContext("bedrockFoundationModelId") ?? "",
  ).trim();
  const destinationRegionsValue = String(
    cdkApp.node.tryGetContext("bedrockModelDestinationRegions") ?? "",
  ).trim();

  if (!inferenceProfileId && !foundationModelId && !destinationRegionsValue) {
    return undefined;
  }
  if (!inferenceProfileId || !foundationModelId || !destinationRegionsValue) {
    throw new Error(
      "CDK contexts 'bedrockModelId', 'bedrockFoundationModelId', and 'bedrockModelDestinationRegions' must be specified together.",
    );
  }

  return {
    inferenceProfileId,
    foundationModelId,
    destinationRegions: destinationRegionsValue
      .split(",")
      .map((region) => region.trim())
      .filter(Boolean),
  };
}
