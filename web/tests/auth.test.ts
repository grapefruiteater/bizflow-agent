import { afterEach, describe, expect, it } from "vitest";
import {
  type AccessTokenVerifier,
  deriveRuntimeSessionId,
  getIdentity,
  requireApprover,
  requireCsrfHeader,
} from "@/lib/auth";

afterEach(() => {
  delete process.env.BIZFLOW_LOCAL_DEMO;
});

describe("BFF authentication boundary", () => {
  it("uses a local identity only when demo mode is explicit", async () => {
    process.env.BIZFLOW_LOCAL_DEMO = "true";
    const identity = await getIdentity(new Request("http://localhost"));

    expect(identity.actor).toBe("demo-user");
    expect(identity.isApprover).toBe(true);
  });

  it("verifies the Cognito access token and reads its approver group", async () => {
    process.env.BIZFLOW_LOCAL_DEMO = "false";
    const verifier: AccessTokenVerifier = {
      verify: async (token) => {
        expect(token).toBe("signed-cognito-access-token");
        return {
          sub: "11111111-2222-3333-4444-555555555555",
          username: "BizFlow User",
          "cognito:groups": ["BizFlowApprovers"],
        };
      },
    };
    const request = new Request("https://bizflow.example.com", {
      headers: {
        "x-amzn-oidc-identity": "11111111-2222-3333-4444-555555555555",
        "x-amzn-oidc-accesstoken": "signed-cognito-access-token",
      },
    });

    const identity = await getIdentity(request, verifier);

    expect(identity.actor).toBe("cognito:11111111-2222-3333-4444-555555555555");
    expect(identity.displayName).toBe("BizFlow User");
    expect(identity.isApprover).toBe(true);
    expect(() => requireApprover(identity)).not.toThrow();
  });

  it("rejects a verified token whose subject differs from the ALB identity", async () => {
    process.env.BIZFLOW_LOCAL_DEMO = "false";
    const verifier: AccessTokenVerifier = {
      verify: async () => ({
        sub: "different-user",
        username: "BizFlow User",
        "cognito:groups": ["BizFlowApprovers"],
      }),
    };
    const request = new Request("https://bizflow.example.com", {
      headers: {
        "x-amzn-oidc-identity": "expected-user",
        "x-amzn-oidc-accesstoken": "signed-cognito-access-token",
      },
    });

    await expect(getIdentity(request, verifier)).rejects.toThrowError(
      "Cognito認証が必要です。",
    );
  });

  it("keeps a user without the approver group read-only", async () => {
    process.env.BIZFLOW_LOCAL_DEMO = "false";
    const verifier: AccessTokenVerifier = {
      verify: async () => ({
        sub: "read-only-user",
        username: "BizFlow Reader",
        "cognito:groups": ["BizFlowUsers"],
      }),
    };
    const request = new Request("https://bizflow.example.com", {
      headers: {
        "x-amzn-oidc-identity": "read-only-user",
        "x-amzn-oidc-accesstoken": "signed-cognito-access-token",
      },
    });

    const identity = await getIdentity(request, verifier);

    expect(identity.groups).toEqual(["BizFlowUsers"]);
    expect(identity.isApprover).toBe(false);
    expect(() => requireApprover(identity)).toThrowError(
      "承認操作にはBizFlowApproversグループが必要です。",
    );
  });

  it("rejects an invalid Cognito access token", async () => {
    process.env.BIZFLOW_LOCAL_DEMO = "false";
    const verifier: AccessTokenVerifier = {
      verify: async () => {
        throw new Error("invalid signature");
      },
    };
    const request = new Request("https://bizflow.example.com", {
      headers: {
        "x-amzn-oidc-identity": "expected-user",
        "x-amzn-oidc-accesstoken": "invalid-token",
      },
    });

    await expect(getIdentity(request, verifier)).rejects.toThrowError(
      "Cognito認証が必要です。",
    );
  });

  it("derives different AgentCore sessions for different Cognito actors", () => {
    const first = deriveRuntimeSessionId("cognito:user-a", "conversation-123456");
    const repeated = deriveRuntimeSessionId("cognito:user-a", "conversation-123456");
    const other = deriveRuntimeSessionId("cognito:user-b", "conversation-123456");

    expect(first).toHaveLength(64);
    expect(repeated).toBe(first);
    expect(other).not.toBe(first);
  });

  it("requires the custom CSRF header for write requests", () => {
    expect(() => requireCsrfHeader(new Request("https://example.com"))).toThrowError(
      "許可されていない更新リクエストです。",
    );
    expect(() =>
      requireCsrfHeader(
        new Request("https://example.com", { headers: { "x-bizflow-csrf": "1" } }),
      ),
    ).not.toThrow();
  });
});
