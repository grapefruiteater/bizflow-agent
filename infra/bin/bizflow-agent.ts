#!/usr/bin/env node
import { App, Environment, Tags } from "aws-cdk-lib";
import { BizFlowAgentFoundationStack } from "../lib/foundation-stack";
import { BizFlowAgentRuntimeStack } from "../lib/runtime-stack";

const app = new App();
const environmentName = readEnvironmentName(app);
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
    environmentName,
  },
);

Tags.of(foundationStack).add("Application", "BizFlowAgent");
Tags.of(foundationStack).add("Environment", environmentName);
Tags.of(foundationStack).add("ManagedBy", "AWS-CDK");

const imageDigest = app.node.tryGetContext("agentImageDigest") as string | undefined;
if (imageDigest !== undefined && imageDigest.trim().length > 0) {
  const bedrockModelId = app.node.tryGetContext("bedrockModelId") as string | undefined;
  if (bedrockModelId === undefined || bedrockModelId.trim().length === 0) {
    throw new Error(
      "CDK context 'bedrockModelId' is required when 'agentImageDigest' is specified.",
    );
  }
  const runtimeStack = new BizFlowAgentRuntimeStack(app, "BizFlowAgentRuntimeStack", {
    env: deploymentEnvironment,
    description: "Initial Amazon Bedrock AgentCore Runtime for BizFlow Agent",
    environmentName,
    executionRole: foundationStack.runtimeExecutionRole,
    imageDigest,
    modelId: bedrockModelId,
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
