import type {
  AgentProposedAction,
  AgentResult,
  TaskProposal,
} from "@/lib/contracts";
import { AppError, requireText } from "@/lib/errors";

export function requireTaskProposal(value: unknown): TaskProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INVALID_PROPOSAL", "対応案の形式が正しくありません。", 400);
  }
  const proposal = value as Record<string, unknown>;
  const dueDate = requireText(proposal.due_date, "期限", 32);
  if (!isIsoCalendarDate(dueDate)) {
    throw new AppError("INVALID_DUE_DATE", "期限はYYYY-MM-DDで指定してください。", 400);
  }
  return {
    request_id: requireText(proposal.request_id, "問い合わせID", 64),
    assignee: requireText(proposal.assignee, "担当者", 128),
    due_date: dueDate,
    action: requireText(proposal.action, "対応内容", 1000),
  };
}

export function requireApprovalId(value: unknown): string {
  const approvalId = requireText(value, "承認ID", 64);
  if (!/^APR-[A-Z0-9-]+$/.test(approvalId)) {
    throw new AppError("INVALID_APPROVAL_ID", "承認IDの形式が正しくありません。", 400);
  }
  return approvalId;
}

export function requireAgentResult(value: unknown): AgentResult {
  const response = requireAgentObject(value);
  if (
    response.output_contract_version !== "1.0" ||
    response.status !== "success" ||
    response.execution_mode !== "READ_ONLY" ||
    response.write_operations_performed !== false
  ) {
    throw invalidAgentResponse();
  }
  const proposedActions = response.proposed_actions;
  if (!Array.isArray(proposedActions) || proposedActions.length > 5) {
    throw invalidAgentResponse();
  }
  const normalizedActions = proposedActions.map(requireAgentProposedAction);
  if (
    new Set(normalizedActions.map((action) => action.request_id)).size !==
    normalizedActions.length
  ) {
    throw invalidAgentResponse();
  }

  const memoryValue = response.memory;
  let memory: AgentResult["memory"];
  if (memoryValue !== undefined) {
    const memoryObject = requireAgentObject(memoryValue);
    memory = {
      enabled: optionalBoolean(memoryObject.enabled),
      context_turns: optionalNonNegativeInteger(memoryObject.context_turns),
      event_stored: optionalBoolean(memoryObject.event_stored),
      degraded: optionalBoolean(memoryObject.degraded),
    };
  }

  return {
    response: requireAgentText(response.response, 12000),
    output_contract_version: "1.0",
    proposed_actions: normalizedActions,
    status: "success",
    execution_mode: "READ_ONLY",
    write_operations_performed: false,
    ...(memory ? { memory } : {}),
  };
}

function requireAgentProposedAction(value: unknown): AgentProposedAction {
  const action = requireAgentObject(value);
  const dueDate = requireAgentText(action.due_date, 32);
  if (!isIsoCalendarDate(dueDate)) {
    throw invalidAgentResponse();
  }
  const requestId = requireAgentText(action.request_id, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)) {
    throw invalidAgentResponse();
  }
  const ruleIds = action.rule_ids;
  if (!Array.isArray(ruleIds) || ruleIds.length > 10) {
    throw invalidAgentResponse();
  }
  const normalizedRuleIds = ruleIds.map((ruleId) => {
    const normalized = requireAgentText(ruleId, 64);
    if (!/^RULE-[A-Za-z0-9-]+$/.test(normalized)) {
      throw invalidAgentResponse();
    }
    return normalized;
  });
  return {
    request_id: requestId,
    assignee: requireAgentText(action.assignee, 128),
    due_date: dueDate,
    action: requireAgentText(action.action, 1000),
    rationale: requireAgentText(action.rationale, 1000),
    rule_ids: normalizedRuleIds,
  };
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function requireAgentObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidAgentResponse();
  }
  return value as Record<string, unknown>;
}

function requireAgentText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    throw invalidAgentResponse();
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw invalidAgentResponse();
  }
  return normalized;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw invalidAgentResponse();
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalidAgentResponse();
  }
  return value as number;
}

function invalidAgentResponse(): AppError {
  return new AppError(
    "INVALID_AGENT_RESPONSE",
    "AgentCore応答形式が不正です。",
    502,
  );
}
