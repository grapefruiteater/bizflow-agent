import { describe, expect, it } from "vitest";
import { requireAgentResult } from "@/lib/validation";

const validResult = {
  response: "REQ-002を最優先で対応してください。",
  output_contract_version: "1.0",
  proposed_actions: [
    {
      request_id: "REQ-002",
      assignee: "support-lead",
      due_date: "2026-07-14",
      action: "顧客へ一次回答する",
      rationale: "期限超過かつ緊急度highのため",
      rule_ids: ["RULE-001", "RULE-002"],
    },
  ],
  status: "success",
  execution_mode: "READ_ONLY",
  write_operations_performed: false,
  memory: {
    enabled: true,
    context_turns: 2,
    event_stored: true,
    degraded: false,
  },
};

describe("AgentCore structured result boundary", () => {
  it("accepts a versioned read-only response and normalized proposals", () => {
    const result = requireAgentResult(validResult);

    expect(result.proposed_actions[0]).toEqual({
      request_id: "REQ-002",
      assignee: "support-lead",
      due_date: "2026-07-14",
      action: "顧客へ一次回答する",
      rationale: "期限超過かつ緊急度highのため",
      rule_ids: ["RULE-001", "RULE-002"],
    });
    expect(result.memory?.context_turns).toBe(2);
  });

  it("rejects a response that claims a write operation", () => {
    expect(() =>
      requireAgentResult({
        ...validResult,
        write_operations_performed: true,
      }),
    ).toThrowError("AgentCore応答形式が不正です。");
  });

  it("rejects malformed proposal dates and rule identifiers", () => {
    expect(() =>
      requireAgentResult({
        ...validResult,
        proposed_actions: [
          {
            ...validResult.proposed_actions[0],
            due_date: "2026/07/14",
            rule_ids: ["not-a-rule"],
          },
        ],
      }),
    ).toThrowError("AgentCore応答形式が不正です。");
  });

  it("rejects impossible calendar dates", () => {
    expect(() =>
      requireAgentResult({
        ...validResult,
        proposed_actions: [
          {
            ...validResult.proposed_actions[0],
            due_date: "2026-02-30",
          },
        ],
      }),
    ).toThrowError("AgentCore応答形式が不正です。");
  });

  it("rejects duplicate request IDs", () => {
    expect(() =>
      requireAgentResult({
        ...validResult,
        proposed_actions: [
          validResult.proposed_actions[0],
          {
            ...validResult.proposed_actions[0],
            action: "別の対応",
          },
        ],
      }),
    ).toThrowError("AgentCore応答形式が不正です。");
  });

  it("allows an empty proposal list when no grounded action exists", () => {
    const result = requireAgentResult({
      ...validResult,
      proposed_actions: [],
    });

    expect(result.proposed_actions).toEqual([]);
  });
});
