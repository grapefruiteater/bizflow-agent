import {
  getIdentity,
  requireApprover,
  requireCsrfHeader,
} from "@/lib/auth";
import { executeApprovedTask } from "@/lib/backend";
import { errorResponse } from "@/lib/errors";
import { requireApprovalId } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    requireCsrfHeader(request);
    const identity = getIdentity(request);
    requireApprover(identity);
    const { approvalId: rawApprovalId } = await context.params;
    const approvalId = requireApprovalId(rawApprovalId);
    const result = await executeApprovedTask(identity.actor, approvalId);
    return Response.json({ ok: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
