import {
  deriveRuntimeSessionId,
  deriveRuntimeUserId,
  getIdentity,
  requireCsrfHeader,
} from "@/lib/auth";
import { invokeAgent } from "@/lib/backend";
import { errorResponse, readJsonObject, requireText } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    requireCsrfHeader(request);
    const identity = await getIdentity(request);
    const body = await readJsonObject(request);
    const prompt = requireText(body.prompt, "依頼", 4000);
    const runtimeSessionId = deriveRuntimeSessionId(identity.actor, body.conversationId);
    const runtimeUserId = deriveRuntimeUserId(identity.actor);
    const result = await invokeAgent(prompt, runtimeSessionId, runtimeUserId);
    return Response.json({ ok: true, identity, result });
  } catch (error) {
    return errorResponse(error);
  }
}
