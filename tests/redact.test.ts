import { describe, expect, it } from "vitest";
import { redact, safeError } from "../src/redact.js";

describe("secret redaction", () => {
  it("redacts sensitive object fields recursively", () => {
    expect(redact({
      command: "v-add-user",
      password: "secret",
      nested: { access_key: "identifier", value: "visible" }
    })).toEqual({
      command: "v-add-user",
      password: "[REDACTED]",
      nested: { access_key: "[REDACTED]", value: "visible" }
    });
  });

  it("redacts secrets from error messages without hiding validation text", () => {
    expect(safeError(new Error("secret_key=abc123 command failed")))
      .toBe("secret_key=[REDACTED] command failed");
    expect(safeError(new Error("HESTIACP_ACCESS_KEY: Invalid input")))
      .toBe("HESTIACP_ACCESS_KEY: Invalid input");
  });

  it("handles non-Error input", () => {
    expect(safeError(null)).toBe("");
    expect(safeError(undefined)).toBe("");
    expect(safeError("plain string")).toBe("plain string");
    expect(safeError(42)).toBe("42");
    expect(safeError({ a: 1 })).toBe('{"a":1}');
    expect(safeError("password=hunter2")).toContain("[REDACTED]");
  });

  it("redacts secrets in array items", () => {
    expect(redact([{ password: "secret" }, { name: "visible" }]))
      .toEqual([{ password: "[REDACTED]" }, { name: "visible" }]);
    expect(redact(["plain", { access_key: "key123" }]))
      .toEqual(["plain", { access_key: "[REDACTED]" }]);
  });
});
