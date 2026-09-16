import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  HESTIACP_URL: "https://panel.example.test:8083",
  HESTIACP_ACCESS_KEY: "access",
  HESTIACP_SECRET_KEY: "secret"
};

describe("loadConfig", () => {
  it("uses secure defaults and normalizes the API path", () => {
    const config = loadConfig(required);
    expect(config.apiUrl.href).toBe("https://panel.example.test:8083/api/");
    expect(config.tlsRejectUnauthorized).toBe(true);
    expect(config.allowMutations).toBe(false);
    expect(config.allowDestructive).toBe(false);
    expect(config.longRunningTimeoutMs).toBe(900_000);
  });

  it("rejects plaintext endpoints by default", () => {
    expect(() => loadConfig({ ...required, HESTIACP_URL: "http://panel.example.test" }))
      .toThrow("must use HTTPS");
  });

  it("permits explicit development TLS opt-out", () => {
    const config = loadConfig({
      ...required,
      HESTIACP_URL: "http://localhost:8083/api/",
      HESTIACP_TLS_REJECT_UNAUTHORIZED: "false"
    });
    expect(config.tlsRejectUnauthorized).toBe(false);
  });
});
