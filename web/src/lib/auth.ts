import { createHash } from "node:crypto";
import type { Identity } from "@/lib/contracts";
import { AppError, requireText } from "@/lib/errors";

const APPROVER_GROUP = "BizFlowApprovers";

export function isLocalDemo(): boolean {
  if (process.env.BIZFLOW_LOCAL_DEMO === "true") {
    return true;
  }
  if (process.env.BIZFLOW_LOCAL_DEMO === "false") {
    return false;
  }
  return process.env.NODE_ENV !== "production";
}

export function getIdentity(request: Request): Identity {
  if (isLocalDemo()) {
    return {
      actor: "demo-user",
      displayName: "ポートフォリオ利用者",
      email: "demo@example.com",
      groups: ["BizFlowUsers", APPROVER_GROUP],
      isApprover: true,
    };
  }

  const actor = request.headers.get("x-amzn-oidc-identity")?.trim();
  if (!actor || actor.length > 128) {
    throw new AppError("UNAUTHENTICATED", "Cognito認証が必要です。", 401);
  }
  const claims = decodeAlbClaims(request.headers.get("x-amzn-oidc-data"));
  const groups = normalizeGroups(claims["cognito:groups"]);
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const displayName =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim()
      : email ?? `利用者 ${actor.slice(0, 8)}`;
  return {
    actor: `cognito:${actor}`,
    displayName,
    email,
    groups,
    isApprover: groups.includes(APPROVER_GROUP),
  };
}

export function requireApprover(identity: Identity): void {
  if (!identity.isApprover) {
    throw new AppError(
      "APPROVER_REQUIRED",
      "承認操作にはBizFlowApproversグループが必要です。",
      403,
    );
  }
}

export function requireCsrfHeader(request: Request): void {
  if (request.headers.get("x-bizflow-csrf") !== "1") {
    throw new AppError("CSRF_REJECTED", "許可されていない更新リクエストです。", 403);
  }
}

export function deriveRuntimeSessionId(actor: string, conversationId: unknown): string {
  const conversation = requireText(conversationId, "conversationId", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/.test(conversation)) {
    throw new AppError(
      "INVALID_CONVERSATION_ID",
      "conversationIdの形式が正しくありません。",
      400,
    );
  }
  return createHash("sha256")
    .update(`bizflow-runtime-session-v1\n${actor}\n${conversation}`, "utf8")
    .digest("hex");
}

function decodeAlbClaims(value: string | null): Record<string, unknown> {
  if (!value) {
    return {};
  }
  const segments = value.split(".");
  if (segments.length !== 3) {
    return {};
  }
  try {
    const decoded = Buffer.from(segments[1] as string, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeGroups(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}
