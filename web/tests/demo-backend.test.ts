import { beforeEach, describe, expect, it } from "vitest";
import {
  decideDemoApproval,
  executeDemoTask,
  getDemoApproval,
  getDemoDashboard,
  requestDemoApproval,
  resetDemoState,
} from "@/lib/demo-backend";

const proposal = {
  request_id: "REQ-002",
  assignee: "support-lead",
  due_date: "2026-07-14",
  action: "顧客へ一次回答する",
};

beforeEach(resetDemoState);

describe("local portfolio workflow", () => {
  it("calculates deterministic dashboard metrics from the synthetic data", () => {
    const dashboard = getDemoDashboard();

    expect(dashboard.metrics).toEqual({
      active: 6,
      urgent: 4,
      overdue: 3,
      registeredTasks: 0,
    });
    expect(dashboard.categoryCounts["障害"]).toBe(2);
  });

  it("refuses task registration before approval", () => {
    const requested = requestDemoApproval("demo-user", proposal);

    expect(() => executeDemoTask(requested.approval.approval_id)).toThrowError(
      "承認後にのみタスクを登録できます。",
    );
    expect(getDemoApproval(requested.approval.approval_id).history.at(-1)?.event_type).toBe(
      "TASK_REGISTRATION_REJECTED",
    );
  });

  it("registers the exact approved proposal and audit trail", () => {
    const requested = requestDemoApproval("demo-user", proposal);
    const approvalId = requested.approval.approval_id;

    decideDemoApproval(approvalId, "demo-approver", "approve");
    const task = executeDemoTask(approvalId);
    const history = getDemoApproval(approvalId).history;

    expect(task.status).toBe("REGISTERED");
    expect(task.request_id).toBe("REQ-002");
    expect(history.map((event) => event.event_type)).toEqual([
      "APPROVAL_REQUESTED",
      "APPROVAL_APPROVED",
      "TASK_REGISTERED",
    ]);
    expect(getDemoDashboard().metrics.registeredTasks).toBe(1);
  });
});
