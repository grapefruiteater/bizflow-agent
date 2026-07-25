import { createHash } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Identity } from "@/lib/contracts";
import { AppError, requireText } from "@/lib/errors";

const APPROVER_GROUP = "BizFlowApprovers";
const COGNITO_USER_POOL_ID_ENVIRONMENT_VARIABLE =
  "BIZFLOW_COGNITO_USER_POOL_ID";
const COGNITO_CLIENT_ID_ENVIRONMENT_VARIABLE = "BIZFLOW_COGNITO_CLIENT_ID";

export interface AccessTokenVerifier {
  verify(token: string): Promise<unknown>;
}

let configuredVerifier:
  | {
      configurationKey: string;
      verifier: AccessTokenVerifier;
    }
  | undefined;

export function isLocalDemo(): boolean {
  if (process.env.BIZFLOW_LOCAL_DEMO === "true") {
    return true;
  }
  if (process.env.BIZFLOW_LOCAL_DEMO === "false") {
    return false;
  }
  return process.env.NODE_ENV !== "production";
}

export async function getIdentity(
  request: Request,
  verifier?: AccessTokenVerifier,
): Promise<Identity> {
  if (isLocalDemo()) {
    return {
      actor: "demo-user",
      displayName: "ポートフォリオ利用者",
      email: "demo@example.com",
      groups: ["BizFlowUsers", APPROVER_GROUP],
      isApprover: true,
    };
  }

  const albIdentity = request.headers.get("x-amzn-oidc-identity")?.trim();
  const accessToken = request.headers.get("x-amzn-oidc-accesstoken")?.trim();
  if (
    !albIdentity ||
    albIdentity.length > 128 ||
    !accessToken ||
    accessToken.length > 16384
  ) {
    throw new AppError("UNAUTHENTICATED", "Cognito認証が必要です。", 401);
  }

  const claims = await verifyAccessToken(
    accessToken,
    verifier ?? getConfiguredAccessTokenVerifier(),
  );
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject || subject !== albIdentity) {
    throw new AppError("UNAUTHENTICATED", "Cognito認証が必要です。", 401);
  }

  const groups = normalizeGroups(claims["cognito:groups"]);
  const username =
    typeof claims.username === "string" && claims.username.trim()
      ? claims.username.trim()
      : undefined;
  const displayName =
    username ?? `利用者 ${subject.slice(0, 8)}`;
  return {
    actor: `cognito:${subject}`,
    displayName,
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

export function deriveRuntimeUserId(actor: string): string {
  const normalizedActor = requireText(actor, "actor", 256);
  const digest = createHash("sha256")
    .update(`bizflow-runtime-user-v1\n${normalizedActor}`, "utf8")
    .digest("hex");
  return `bizflow-user-${digest}`;
}

function getConfiguredAccessTokenVerifier(): AccessTokenVerifier {
  const userPoolId = requireAuthEnvironment(
    COGNITO_USER_POOL_ID_ENVIRONMENT_VARIABLE,
  );
  const clientId = requireAuthEnvironment(
    COGNITO_CLIENT_ID_ENVIRONMENT_VARIABLE,
  );
  const configurationKey = `${userPoolId}\n${clientId}`;
  if (configuredVerifier?.configurationKey !== configurationKey) {
    configuredVerifier = {
      configurationKey,
      verifier: CognitoJwtVerifier.create({
        userPoolId,
        tokenUse: "access",
        clientId,
      }),
    };
  }
  return configuredVerifier.verifier;
}

async function verifyAccessToken(
  token: string,
  verifier: AccessTokenVerifier,
): Promise<Record<string, unknown>> {
  let claims: unknown;
  try {
    claims = await verifier.verify(token);
  } catch {
    throw new AppError("UNAUTHENTICATED", "Cognito認証が必要です。", 401);
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
    throw new AppError("UNAUTHENTICATED", "Cognito認証が必要です。", 401);
  }
  return claims as Record<string, unknown>;
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

function requireAuthEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new AppError(
      "SERVER_MISCONFIGURED",
      `${name}が設定されていません。`,
      503,
    );
  }
  return value;
}
