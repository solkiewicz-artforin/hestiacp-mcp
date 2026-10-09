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

/** Regex matching sensitive key names for object-key redaction, with word boundaries. */
const SECRET_KEYS_RE = new RegExp(
  SENSITIVE_KEY_NAMES.map((k) => `(?<![a-z])${k}(?![a-z])`).join("|"),
  "i"
);

/** Regex matching sensitive key=value patterns in error strings. */
const SAFE_ERROR_SENSITIVE_RE = new RegExp(
  `(\\b(?:-{1,2})?(?:${SENSITIVE_KEY_NAMES.map((k) => `${k}_?(?:key)?`).join("|")})\\b\\s*(?:[=:]\\s*)?\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`,
  "gi"
);

/**
 * Recursively redacts values of sensitive keys from an object or array.
 *
 * Replaces values whose key matches a known sensitive name with `"[REDACTED]"`.
 * Supports nested objects, arrays, and primitive values. Input is always
 * acyclic (flat command results), so no cycle detection is needed.
 *
 * @param value - The value to redact. Can be any JSON-serializable type.
 * @returns A deep copy with sensitive values replaced.
 */
export function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEYS_RE.test(key) ? "[REDACTED]" : redact(item)
    ])
  );
}

/**
 * Scrubs sensitive values (keys, tokens, passwords) from error message strings.
 *
 * Replaces patterns like `access_key=abc123` or `password: "secret"` with
 * `[REDACTED]`, keeping the key name intact for debuggability.
 *
 * Error instances yield their redacted message, strings are scrubbed, other
 * values are JSON-stringified and scrubbed, and `null`/`undefined` yield `""`.
 * The function always returns a string.
 *
 * @param error - The error to sanitize. Can be an Error instance or any value.
 * @returns A string safe for logging and telemetry.
 */
export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(SAFE_ERROR_SENSITIVE_RE, "$1[REDACTED]");
  }
  if (error === null || error === undefined) {
    return "";
  }
  let text: string;
  if (typeof error === "string") {
    text = error;
  } else {
    try {
      text = JSON.stringify(error);
    } catch {
      text = Object.prototype.toString.call(error);
    }
  }
  return text.replace(SAFE_ERROR_SENSITIVE_RE, "$1[REDACTED]");
}
