import { createHash, randomUUID } from "node:crypto";
import type {
  AgentResult,
  Approval,
  ApprovalBundle,
  AuditEvent,
  BusinessTask,
  DashboardData,
  TaskProposal,
} from "@/lib/contracts";
import { DEMO_REQUESTS } from "@/lib/demo-data";
import { AppError } from "@/lib/errors";

interface DemoState {
  approvals: Map<string, Approval>;
  histories: Map<string, AuditEvent[]>;
  tasks: Map<string, BusinessTask>;
}

const globalState = globalThis as typeof globalThis & {
  __bizflowDemoState?: DemoState;
};

function state(): DemoState {
  globalState.__bizflowDemoState ??= {
    approvals: new Map(),
    histories: new Map(),
    tasks: new Map(),
  };
  return globalState.__bizflowDemoState;
}

export function resetDemoState(): void {
  globalState.__bizflowDemoState = undefined;
}

export function getDemoDashboard(): DashboardData {
  const asOf = "2026-07-14";
  const active = DEMO_REQUESTS.filter((item) => item.status !== "closed");
  const categoryCounts = DEMO_REQUESTS.reduce<Record<string, number>>((counts, item) => {
    counts[item.category] = (counts[item.category] ?? 0) + 1;
    return counts;
  }, {});
  return {
    source: "local-demo",
    period: { start: "2026-07-09", end: "2026-07-13", asOf },
    metrics: {
      active: active.length,
      urgent: active.filter((item) => item.urgency === "high").length,
      overdue: active.filter((item) => item.due_date < asOf).length,
      registeredTasks: state().tasks.size,
    },
    categoryCounts,
    requests: DEMO_REQUESTS,
  };
}

export function invokeDemoAgent(prompt: string): AgentResult {
  return {
    response: [
      "## 分析結果",
      "期限超過かつ緊急度highのREQ-002を最優先に対応してください。REQ-005とREQ-008もhighのため当日中の担当確定が必要です。",
      "",
      "## 参照した社内ルール",
      "- 障害カテゴリーかつhighの案件は2時間以内に担当者を決める",
      "- 期限超過案件はチームリーダーへエスカレーションする",
      "",
      `依頼: ${prompt}`,
      "",
      "書き込みは行っていません。右側の承認カードから提案内容を確認してください。",
    ].join("\n"),
    status: "success",
    execution_mode: "READ_ONLY",
    write_operations_performed: false,
    memory: {
      enabled: true,
      context_turns: 1,
      event_stored: true,
      degraded: false,
    },
  };
}

export function requestDemoApproval(
  actor: string,
  proposal: TaskProposal,
): ApprovalBundle {
  const approvalId = `APR-${digest({ actor, ...proposal }).slice(0, 12).toUpperCase()}`;
  let approval = state().approvals.get(approvalId);
  if (!approval) {
    approval = {
      approval_id: approvalId,
      status: "PENDING",
      requested_by: actor,
      approved_by: null,
      proposal,
      created_at: new Date().toISOString(),
      decided_at: null,
    };
    state().approvals.set(approvalId, approval);
    recordEvent(approvalId, actor, "APPROVAL_REQUESTED");
  }
  return bundle(approvalId);
}

export function getDemoApproval(approvalId: string): ApprovalBundle {
  if (!state().approvals.has(approvalId)) {
    throw new AppError("APPROVAL_NOT_FOUND", "承認依頼が見つかりません。", 404);
  }
  return bundle(approvalId);
}

export function decideDemoApproval(
  approvalId: string,
  actor: string,
  decision: "approve" | "reject",
): ApprovalBundle {
  const current = getDemoApproval(approvalId).approval;
  if (current.status !== "PENDING") {
    throw new AppError("APPROVAL_ALREADY_DECIDED", "承認依頼は判断済みです。", 409);
  }
  const approval: Approval = {
    ...current,
    status: decision === "approve" ? "APPROVED" : "REJECTED",
    approved_by: actor,
    decided_at: new Date().toISOString(),
  };
  state().approvals.set(approvalId, approval);
  recordEvent(
    approvalId,
    actor,
    decision === "approve" ? "APPROVAL_APPROVED" : "APPROVAL_REJECTED",
  );
  return bundle(approvalId);
}

export function executeDemoTask(approvalId: string): BusinessTask {
  const approval = getDemoApproval(approvalId).approval;
  if (approval.status !== "APPROVED") {
    recordEvent(approvalId, "bizflow-web-bff", "TASK_REGISTRATION_REJECTED");
    throw new AppError("APPROVAL_REQUIRED", "承認後にのみタスクを登録できます。", 409);
  }
  const taskId = `TASK-${digest({ approvalId, ...approval.proposal })
    .slice(0, 12)
    .toUpperCase()}`;
  let task = state().tasks.get(taskId);
  if (!task) {
    task = {
      task_id: taskId,
      status: "REGISTERED",
      approval_id: approvalId,
      approved_by: approval.approved_by ?? "unknown",
      ...approval.proposal,
      created_at: new Date().toISOString(),
    };
    state().tasks.set(taskId, task);
    recordEvent(approvalId, "bizflow-web-bff", "TASK_REGISTERED", taskId);
  }
  return task;
}

function bundle(approvalId: string): ApprovalBundle {
  return {
    approval: { ...(state().approvals.get(approvalId) as Approval) },
    history: [...(state().histories.get(approvalId) ?? [])],
  };
}

function recordEvent(
  approvalId: string,
  actor: string,
  eventType: string,
  taskId: string | null = null,
): void {
  const history = state().histories.get(approvalId) ?? [];
  history.push({
    event_id: `EVT-${randomUUID().replaceAll("-", "").toUpperCase()}`,
    event_type: eventType,
    actor,
    approval_id: approvalId,
    task_id: taskId,
    detail_code: eventType.endsWith("REJECTED") ? "APPROVAL_REQUIRED" : null,
    recorded_at: new Date().toISOString(),
  });
  state().histories.set(approvalId, history);
}

function digest(values: Record<string, string>): string {
  return createHash("sha256")
    .update(
      Object.keys(values)
        .sort()
        .map((key) => `${key}=${values[key]}`)
        .join("\n"),
    )
    .digest("hex");
}
