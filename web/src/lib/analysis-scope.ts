const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AnalysisScope {
  readonly startDate: string;
  readonly endDate: string;
  readonly asOf: string;
}

export function analysisScopeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AnalysisScope {
  return {
    startDate: requireIsoDate(
      environment.BIZFLOW_DATA_START_DATE ?? "2026-07-09",
      "BIZFLOW_DATA_START_DATE",
    ),
    endDate: requireIsoDate(
      environment.BIZFLOW_DATA_END_DATE ?? "2026-07-13",
      "BIZFLOW_DATA_END_DATE",
    ),
    asOf: requireIsoDate(
      environment.BIZFLOW_ANALYSIS_AS_OF ?? "2026-07-14",
      "BIZFLOW_ANALYSIS_AS_OF",
    ),
  };
}

export function addAnalysisScope(prompt: string, scope: AnalysisScope): string {
  return [
    prompt.trim(),
    "",
    "<bizflow_analysis_scope>",
    "以下はBizFlow Webが指定した固定の分析条件です。日付を推測せず、この条件を優先してください。",
    `「今週」は${scope.startDate}から${scope.endDate}までを指します。`,
    `get_business_requestsにはstart_date=${scope.startDate}、end_date=${scope.endDate}を指定してください。`,
    `analyze_request_dataにはas_of=${scope.asOf}を指定してください。`,
    "取得結果が空の場合のみ0件と判断し、別期間へ読み替えないでください。",
    "</bizflow_analysis_scope>",
  ].join("\n");
}

function requireIsoDate(value: string, name: string): string {
  const normalized = value.trim();
  if (!ISO_DATE.test(normalized)) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }
  return normalized;
}
