import type { TaskProposal } from "@/lib/contracts";
import { AppError, requireText } from "@/lib/errors";

export function requireTaskProposal(value: unknown): TaskProposal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INVALID_PROPOSAL", "対応案の形式が正しくありません。", 400);
  }
  const proposal = value as Record<string, unknown>;
  const dueDate = requireText(proposal.due_date, "期限", 32);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
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
