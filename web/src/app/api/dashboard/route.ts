import { getIdentity } from "@/lib/auth";
import { getDashboard } from "@/lib/backend";
import { errorResponse } from "@/lib/errors";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const identity = getIdentity(request);
    const dashboard = await getDashboard();
    return Response.json({ ok: true, identity, dashboard });
  } catch (error) {
    return errorResponse(error);
  }
}
