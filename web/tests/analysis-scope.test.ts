import { describe, expect, it } from "vitest";
import {
  addAnalysisScope,
  analysisScopeFromEnvironment,
} from "@/lib/analysis-scope";

describe("Agent analysis scope", () => {
  it("adds the dashboard period and tool arguments to the prompt", () => {
    const prompt = addAnalysisScope("今週の問い合わせを分析してください。", {
      startDate: "2026-07-09",
      endDate: "2026-07-13",
      asOf: "2026-07-14",
    });

    expect(prompt).toContain("「今週」は2026-07-09から2026-07-13まで");
    expect(prompt).toContain(
      "get_business_requestsにはstart_date=2026-07-09、end_date=2026-07-13",
    );
    expect(prompt).toContain("analyze_request_dataにはas_of=2026-07-14");
  });

  it("reads the same period used by the dashboard", () => {
    expect(
      analysisScopeFromEnvironment({
        BIZFLOW_DATA_START_DATE: "2026-07-09",
        BIZFLOW_DATA_END_DATE: "2026-07-13",
        BIZFLOW_ANALYSIS_AS_OF: "2026-07-14",
      }),
    ).toEqual({
      startDate: "2026-07-09",
      endDate: "2026-07-13",
      asOf: "2026-07-14",
    });
  });

  it("rejects an invalid configured date instead of letting the model guess", () => {
    expect(() =>
      analysisScopeFromEnvironment({
        BIZFLOW_DATA_START_DATE: "2026/07/09",
        BIZFLOW_DATA_END_DATE: "2026-07-13",
        BIZFLOW_ANALYSIS_AS_OF: "2026-07-14",
      }),
    ).toThrow("BIZFLOW_DATA_START_DATE must use YYYY-MM-DD format.");
  });
});
