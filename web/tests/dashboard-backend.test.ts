import { LambdaClient } from "@aws-sdk/client-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDashboard } from "@/lib/backend";

const request = {
  request_id: "REQ-002",
  received_at: "2026-07-11",
  category: "障害",
  customer: "XYZ株式会社",
  description: "サービスにログインできない",
  urgency: "high",
  status: "open",
  due_date: "2026-07-12",
};

beforeEach(() => {
  process.env.BIZFLOW_LOCAL_DEMO = "false";
  process.env.BIZFLOW_READ_TOOLS_FUNCTION_NAME = "bizflow-read-tools-test";
});

afterEach(() => {
  delete process.env.BIZFLOW_LOCAL_DEMO;
  delete process.env.BIZFLOW_READ_TOOLS_FUNCTION_NAME;
  vi.restoreAllMocks();
});

describe("AWS dashboard backend", () => {
  it("loads the persistent registered task count from the BFF-only read operation", async () => {
    const operations: string[] = [];
    vi.spyOn(LambdaClient.prototype, "send").mockImplementation(
      async (command: unknown) => {
        const input = (command as { input: { Payload?: Uint8Array } }).input;
        const event = JSON.parse(
          Buffer.from(input.Payload ?? []).toString("utf8"),
        ) as { operation: string };
        operations.push(event.operation);

        const dataByOperation: Record<string, unknown> = {
          get_business_requests: { requests: [request] },
          analyze_request_data: {
            active_count: 1,
            urgent_open_request_ids: ["REQ-002"],
            overdue_request_ids: ["REQ-002"],
            category_counts: { 障害: 1 },
          },
          get_dashboard_metrics: { registered_task_count: 3 },
        };
        return {
          Payload: Buffer.from(
            JSON.stringify({
              ok: true,
              data: dataByOperation[event.operation],
            }),
            "utf8",
          ),
        } as never;
      },
    );

    const dashboard = await getDashboard();

    expect(operations).toEqual([
      "get_business_requests",
      "analyze_request_data",
      "get_dashboard_metrics",
    ]);
    expect(dashboard.metrics).toEqual({
      active: 1,
      urgent: 1,
      overdue: 1,
      registeredTasks: 3,
    });
  });

  it("rejects an invalid persistent task count", async () => {
    vi.spyOn(LambdaClient.prototype, "send").mockImplementation(
      async (command: unknown) => {
        const input = (command as { input: { Payload?: Uint8Array } }).input;
        const event = JSON.parse(
          Buffer.from(input.Payload ?? []).toString("utf8"),
        ) as { operation: string };
        const dataByOperation: Record<string, unknown> = {
          get_business_requests: { requests: [request] },
          analyze_request_data: {
            active_count: 1,
            urgent_open_request_ids: ["REQ-002"],
            overdue_request_ids: ["REQ-002"],
            category_counts: { 障害: 1 },
          },
          get_dashboard_metrics: { registered_task_count: -1 },
        };
        return {
          Payload: Buffer.from(
            JSON.stringify({
              ok: true,
              data: dataByOperation[event.operation],
            }),
            "utf8",
          ),
        } as never;
      },
    );

    await expect(getDashboard()).rejects.toThrow(
      "業務API応答のregistered_task_countが不正です。",
    );
  });
});
