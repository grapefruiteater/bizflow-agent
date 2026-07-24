import { getIdentity, requireCsrfHeader } from "@/lib/auth";
import { requestApproval } from "@/lib/backend";
import { errorResponse, readJsonObject } from "@/lib/errors";
import { requireTaskProposal } from "@/lib/validation";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireCsrfHeader(request);
    const identity = await getIdentity(request);
    const body = await readJsonObject(request);
    const proposal = requireTaskProposal(body.proposal);
    const result = await requestApproval(identity.actor, proposal);
    return Response.json({ ok: true, result });
  } catch (error) {
    return errorResponse(error);
  }
}
