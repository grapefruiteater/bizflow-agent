import { afterEach, describe, expect, it } from "vitest";
import {
  deriveRuntimeSessionId,
  getIdentity,
  requireApprover,
  requireCsrfHeader,
} from "@/lib/auth";

afterEach(() => {
  delete process.env.BIZFLOW_LOCAL_DEMO;
});

describe("BFF authentication boundary", () => {
  it("uses a local identity only when demo mode is explicit", () => {
    process.env.BIZFLOW_LOCAL_DEMO = "true";
    const identity = getIdentity(new Request("http://localhost"));

    expect(identity.actor).toBe("demo-user");
    expect(identity.isApprover).toBe(true);
  });

  it("reads the stable Cognito subject and approver group from ALB headers", () => {
    process.env.BIZFLOW_LOCAL_DEMO = "false";
    const claims = Buffer.from(
      JSON.stringify({
        email: "user@example.com",
        name: "BizFlow User",
        "cognito:groups": ["BizFlowApprovers"],
      }),
    ).toString("base64url");
    const request = new Request("https://bizflow.example.com", {
      headers: {
        "x-amzn-oidc-identity": "11111111-2222-3333-4444-555555555555",
        "x-amzn-oidc-data": `header.${claims}.signature`,
      },
    });

    const identity = getIdentity(request);

    expect(identity.actor).toBe("cognito:11111111-2222-3333-4444-555555555555");
    expect(identity.displayName).toBe("BizFlow User");
    expect(identity.isApprover).toBe(true);
    expect(() => requireApprover(identity)).not.toThrow();
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
