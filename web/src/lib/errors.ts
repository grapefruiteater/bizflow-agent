export class AppError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function errorResponse(error: unknown): Response {
  if (error instanceof AppError) {
    return Response.json(
      { ok: false, error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  console.error("Unhandled BizFlow BFF error", error);
  return Response.json(
    {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "処理を完了できませんでした。時間を置いて再試行してください。",
      },
    },
    { status: 500 },
  );
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new AppError("INVALID_JSON", "JSON形式のリクエストが必要です。", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("INVALID_REQUEST", "リクエストはオブジェクトで指定してください。", 400);
  }
  return value as Record<string, unknown>;
}

export function requireText(
  value: unknown,
  name: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AppError("INVALID_ARGUMENT", `${name}を入力してください。`, 400);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `${name}は${maxLength}文字以内で入力してください。`,
      400,
    );
  }
  return normalized;
}
