import {
  getIdentity,
  requireApprover,
  requireCsrfHeader,
} from "@/lib/auth";
import { decideApproval } from "@/lib/backend";
import { AppError, errorResponse, readJsonObject } from "@/lib/errors";
import { requireApprovalId } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
): Promise<Response> {
  try {
    requireCsrfHeader(request);
    const identity = await getIdentity(request);
    requireApprover(identity);
    const { approvalId: rawApprovalId } = await context.params;
    const approvalId = requireApprovalId(rawApprovalId);
    const body = await readJsonObject(request);
    if (body.decision !== "approve" && body.decision !== "reject") {
      throw new AppError("INVALID_DECISION", "approveまたはrejectを指定してください。", 400);
    }
    const result = await decideApproval(identity.actor, approvalId, body.decision);
    return Response.json({ ok: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
