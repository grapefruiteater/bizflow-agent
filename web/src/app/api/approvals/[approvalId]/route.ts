import { getIdentity } from "@/lib/auth";
import { getApproval } from "@/lib/backend";
import { AppError, errorResponse } from "@/lib/errors";
import { requireApprovalId } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    const identity = await getIdentity(request);
    const { approvalId: rawApprovalId } = await context.params;
    const approvalId = requireApprovalId(rawApprovalId);
    const result = await getApproval(identity.actor, approvalId);
    if (result.approval.requested_by !== identity.actor && !identity.isApprover) {
      throw new AppError("APPROVAL_FORBIDDEN", "この承認履歴は参照できません。", 403);
    }
    return Response.json({ ok: true, identity, result });
  } catch (error) {
    return errorResponse(error);
  }
}
