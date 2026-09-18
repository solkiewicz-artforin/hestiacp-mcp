/** Shared list of sensitive key names used by both {@link redact} and {@link safeError}. */
const SENSITIVE_KEY_NAMES = [
  "access",
  "secret",
  "password",
  "pass",
  "token",
  "authorization",
  "hash",
  "key",
] as const;

/** Regex matching sensitive key names for object-key redaction. */
const SECRET_KEYS_RE = new RegExp(
  SENSITIVE_KEY_NAMES.map((k) => `(?:${k})`).join("|"),
  "i"
);

/** Regex matching sensitive key=value patterns in error strings. */
const SAFE_ERROR_SENSITIVE_RE = new RegExp(
  `(\\b(?:${SENSITIVE_KEY_NAMES.map((k) => `${k}_?(?:key)?`).join("|")})\\b\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`,
  "gi"
);

/**
 * Recursively redacts values of sensitive keys from an object or array.
 *
 * Replaces values whose key matches a known sensitive name with `"[REDACTED]"`.
 * Supports nested objects, arrays, and primitive values. Uses a WeakSet to
 * detect and safely handle circular references.
 *
 * @param value - The value to redact. Can be any JSON-serializable type.
 * @param seen  - Internal WeakSet used to track visited objects for cycle detection.
 * @returns A deep copy with sensitive values replaced.
 */
export function redact(value: unknown, seen = new WeakSet()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  // Cycle detection: return a placeholder for already-visited objects.
  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS_RE.test(key) ? "[REDACTED]" : redact(item, seen)
    ])
  );
}

/**
 * Scrubs sensitive values (keys, tokens, passwords) from error message strings.
 *
 * Replaces patterns like `access_key=abc123` or `password: "secret"` with
 * `[REDACTED]`, keeping the key name intact for debuggability.
 *
 * @param error - The error to sanitize. Can be an Error instance or any value.
 * @returns A string safe for logging and telemetry.
 */
export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(SAFE_ERROR_SENSITIVE_RE, "$1[REDACTED]");
  }
  return "Unknown error";
}
