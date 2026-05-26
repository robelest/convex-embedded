export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

export function parseErrorMetadata(error: unknown): {
  code?: string;
  message: string;
} {
  const fallback = errorMessage(error);
  try {
    const parsed = JSON.parse(fallback) as {
      code?: unknown;
      message?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      return {
        code: typeof parsed.code === "string" ? parsed.code : undefined,
        message:
          typeof parsed.message === "string"
            ? parsed.message.toLowerCase()
            : fallback.toLowerCase(),
      };
    }
  } catch {}
  return { message: fallback.toLowerCase() };
}
