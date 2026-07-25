import { afterEach, describe, expect, it } from "vitest";
import { buildAgentInvocationInput } from "@/lib/backend";

afterEach(() => {
  delete process.env.BIZFLOW_AGENT_RUNTIME_ARN;
  delete process.env.BIZFLOW_AGENT_ENDPOINT_NAME;
});

describe("AgentCore invocation identity boundary", () => {
  it("passes the BFF-derived opaque user ID through the SDK field", () => {
    process.env.BIZFLOW_AGENT_RUNTIME_ARN =
      "arn:aws:bedrock-agentcore:ap-northeast-1:111122223333:runtime/BizFlowAgent_test-example";
    process.env.BIZFLOW_AGENT_ENDPOINT_NAME = "PROD";
    const runtimeUserId = `bizflow-user-${"a".repeat(64)}`;

    const input = buildAgentInvocationInput(
      "問い合わせを分析してください。",
      "session-12345678",
      runtimeUserId,
    );

    expect(input.runtimeSessionId).toBe("session-12345678");
    expect(input.runtimeUserId).toBe(runtimeUserId);
    expect(input.qualifier).toBe("PROD");
    expect(JSON.parse(input.payload as string)).toHaveProperty("prompt");
  });
});
