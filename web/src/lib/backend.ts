import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import type {
  AgentResult,
  ApprovalBundle,
  BusinessRequest,
  BusinessTask,
  DashboardData,
  TaskProposal,
} from "@/lib/contracts";
import {
  decideDemoApproval,
  executeDemoTask,
  getDemoApproval,
  getDemoDashboard,
  invokeDemoAgent,
  requestDemoApproval,
} from "@/lib/demo-backend";
import { AppError } from "@/lib/errors";
import { isLocalDemo } from "@/lib/auth";

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "ap-northeast-1";
const lambdaClient = new LambdaClient({ region });
const agentCoreClient = new BedrockAgentCoreClient({ region });

interface LambdaEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

interface RequestDataResult {
  requests: BusinessRequest[];
}

interface AnalysisResult {
  active_count: number;
  urgent_open_request_ids: string[];
  overdue_request_ids: string[];
  category_counts: Record<string, number>;
}

export async function getDashboard(): Promise<DashboardData> {
  if (isLocalDemo()) {
    return getDemoDashboard();
  }
  const start = process.env.BIZFLOW_DATA_START_DATE ?? "2026-07-09";
  const end = process.env.BIZFLOW_DATA_END_DATE ?? "2026-07-13";
  const asOf = process.env.BIZFLOW_ANALYSIS_AS_OF ?? "2026-07-14";
  const requestData = await invokeBusinessTool<RequestDataResult>(
    requireEnvironment("BIZFLOW_READ_TOOLS_FUNCTION_NAME"),
    "get_business_requests",
    { start_date: start, end_date: end },
  );
  const analysis = await invokeBusinessTool<AnalysisResult>(
    requireEnvironment("BIZFLOW_READ_TOOLS_FUNCTION_NAME"),
    "analyze_request_data",
    { requests: requestData.requests, as_of: asOf },
  );
  return {
    source: "aws",
    period: { start, end, asOf },
    metrics: {
      active: analysis.active_count,
      urgent: analysis.urgent_open_request_ids.length,
      overdue: analysis.overdue_request_ids.length,
      registeredTasks: 0,
    },
    categoryCounts: analysis.category_counts,
    requests: requestData.requests,
  };
}

export async function invokeAgent(
  prompt: string,
  runtimeSessionId: string,
): Promise<AgentResult> {
  if (isLocalDemo()) {
    return invokeDemoAgent(prompt);
  }
  const response = await agentCoreClient.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: requireEnvironment("BIZFLOW_AGENT_RUNTIME_ARN"),
      runtimeSessionId,
      qualifier: process.env.BIZFLOW_AGENT_ENDPOINT_NAME ?? "PROD",
      contentType: "application/json",
      accept: "application/json",
      payload: JSON.stringify({ prompt }),
    }),
  );
  const text = await response.response?.transformToString();
  if (!text) {
    throw new AppError("EMPTY_AGENT_RESPONSE", "AgentCoreから応答がありません。", 502);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError("INVALID_AGENT_RESPONSE", "AgentCore応答を解析できません。", 502);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("INVALID_AGENT_RESPONSE", "AgentCore応答形式が不正です。", 502);
  }
  return parsed as AgentResult;
}

export async function requestApproval(
  actor: string,
  proposal: TaskProposal,
): Promise<ApprovalBundle> {
  if (isLocalDemo()) {
    return requestDemoApproval(actor, proposal);
  }
  return invokeApproval({ operation: "request_approval", actor, proposal });
}

export async function getApproval(
  actor: string,
  approvalId: string,
): Promise<ApprovalBundle> {
  if (isLocalDemo()) {
    return getDemoApproval(approvalId);
  }
  return invokeApproval({
    operation: "get_approval",
    actor,
    approval_id: approvalId,
  });
}

export async function decideApproval(
  actor: string,
  approvalId: string,
  decision: "approve" | "reject",
): Promise<ApprovalBundle> {
  if (isLocalDemo()) {
    return decideDemoApproval(approvalId, actor, decision);
  }
  return invokeApproval({
    operation: decision,
    actor,
    approval_id: approvalId,
  });
}

export async function executeApprovedTask(
  actor: string,
  approvalId: string,
): Promise<{ task: BusinessTask; approval: ApprovalBundle }> {
  if (isLocalDemo()) {
    const task = executeDemoTask(approvalId);
    return { task, approval: getDemoApproval(approvalId) };
  }
  const approval = await getApproval(actor, approvalId);
  if (approval.approval.status !== "APPROVED") {
    throw new AppError("APPROVAL_REQUIRED", "承認後にのみタスクを登録できます。", 409);
  }
  const result = await invokeBusinessTool<{ task: BusinessTask }>(
    requireEnvironment("BIZFLOW_WRITE_TOOLS_FUNCTION_NAME"),
    "create_business_task",
    {
      approval_id: approvalId,
      ...approval.approval.proposal,
    },
  );
  return { task: result.task, approval: await getApproval(actor, approvalId) };
}

async function invokeApproval(event: Record<string, unknown>): Promise<ApprovalBundle> {
  const result = await invokeLambda<ApprovalBundle>(
    requireEnvironment("BIZFLOW_APPROVAL_FUNCTION_NAME"),
    event,
  );
  return result;
}

async function invokeBusinessTool<T>(
  functionName: string,
  operation: string,
  argumentsValue: Record<string, unknown>,
): Promise<T> {
  return invokeLambda<T>(functionName, {
    source: "bizflow-web-bff",
    operation,
    arguments: argumentsValue,
  });
}

async function invokeLambda<T>(
  functionName: string,
  event: Record<string, unknown>,
): Promise<T> {
  const response = await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: "RequestResponse",
      Payload: Buffer.from(JSON.stringify(event), "utf8"),
    }),
  );
  if (response.FunctionError) {
    throw new AppError("LAMBDA_FUNCTION_ERROR", "業務APIの実行に失敗しました。", 502);
  }
  const text = response.Payload ? Buffer.from(response.Payload).toString("utf8") : "";
  let envelope: LambdaEnvelope<T>;
  try {
    envelope = JSON.parse(text) as LambdaEnvelope<T>;
  } catch {
    throw new AppError("INVALID_LAMBDA_RESPONSE", "業務API応答を解析できません。", 502);
  }
  if (!envelope.ok || envelope.data === undefined) {
    throw new AppError(
      envelope.error?.code ?? "BUSINESS_API_ERROR",
      envelope.error?.message ?? "業務APIがリクエストを拒否しました。",
      409,
    );
  }
  return envelope.data;
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new AppError("SERVER_MISCONFIGURED", `${name}が設定されていません。`, 503);
  }
  return value;
}
