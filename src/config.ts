import { z } from "zod";

const booleanString = (defaultValue: "true" | "false") =>
  z
    .preprocess((value) => value ?? defaultValue, z.enum(["true", "false", "1", "0"]))
    .transform((value) => value === "true" || value === "1");

const toolProfileSchema = z.enum(["all", "curated"]).default("curated");

const envSchema = z.object({
  HESTIACP_URL: z.url().transform((value) => new URL(value)),
  HESTIACP_ACCESS_KEY: z.string().min(1),
  HESTIACP_SECRET_KEY: z.string().min(1),
  HESTIACP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  HESTIACP_LONG_RUNNING_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(30_000)
    .max(3_600_000)
    .default(900_000),
  HESTIACP_TLS_REJECT_UNAUTHORIZED: booleanString("true"),
  HESTIACP_ALLOW_MUTATIONS: booleanString("false"),
  HESTIACP_ALLOW_DESTRUCTIVE: booleanString("false"),
  HESTIACP_ALLOW_SYSTEM: booleanString("false"),
  HESTIACP_TOOL_PROFILE: toolProfileSchema,
  HESTIACP_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10_000_000)
    .default(1_000_000)
});

export type Config = {
  apiUrl: URL;
  accessKey: string;
  secretKey: string;
  timeoutMs: number;
  longRunningTimeoutMs: number;
  tlsRejectUnauthorized: boolean;
  allowMutations: boolean;
  allowDestructive: boolean;
  allowSystem: boolean;
  toolProfile: "all" | "curated";
  maxResponseBytes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid HestiaCP configuration: ${details}`);
  }

  const apiUrl = new URL(result.data.HESTIACP_URL);
  if (apiUrl.username || apiUrl.password) {
    throw new Error("HESTIACP_URL must not contain embedded credentials");
  }
  if (apiUrl.protocol !== "https:" && result.data.HESTIACP_TLS_REJECT_UNAUTHORIZED) {
    throw new Error("HESTIACP_URL must use HTTPS when TLS verification is enabled");
  }
  if (!apiUrl.pathname || apiUrl.pathname === "/") {
    apiUrl.pathname = "/api/";
  }
  apiUrl.search = "";
  apiUrl.hash = "";

  return {
    apiUrl,
    accessKey: result.data.HESTIACP_ACCESS_KEY,
    secretKey: result.data.HESTIACP_SECRET_KEY,
    timeoutMs: result.data.HESTIACP_TIMEOUT_MS,
    longRunningTimeoutMs: result.data.HESTIACP_LONG_RUNNING_TIMEOUT_MS,
    tlsRejectUnauthorized: result.data.HESTIACP_TLS_REJECT_UNAUTHORIZED,
    allowMutations: result.data.HESTIACP_ALLOW_MUTATIONS,
    allowDestructive: result.data.HESTIACP_ALLOW_DESTRUCTIVE,
    allowSystem: result.data.HESTIACP_ALLOW_SYSTEM,
    toolProfile: result.data.HESTIACP_TOOL_PROFILE,
    maxResponseBytes: result.data.HESTIACP_MAX_RESPONSE_BYTES
  };
}
