const SECRET_KEYS = /(?:access|secret|password|pass|token|authorization|hash|key)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEYS.test(key) ? "[REDACTED]" : redact(item)
      ])
    );
  }
  return value;
}

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(
      /(\b(?:access_key|secret_key|password|token)\b\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    );
  }
  return "Unknown error";
}
