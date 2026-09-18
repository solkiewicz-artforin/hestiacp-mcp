import { McpServer, type RegisteredTool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { HestiaApiError, type HestiaClient } from "./client.js";
import type { Config } from "./config.js";
import { basename } from "node:path";
import { redact, safeError } from "./redact.js";
import { allCommands, type CommandEntry } from "./generated/commands.js";
import handcraftedCommandsArr from "./commands/handcrafted-commands.json" with { type: "json" };
import constants from "./generated/constants.json" with { type: "json" };

type Safety = "read" | "mutating" | "destructive";
type CommandSpec = {
  name: string;
  command: `v-${string}`;
  description: string;
  safety: Safety;
  idempotent?: boolean;
  schema: z.ZodType<Record<string, unknown>>;
  args: (input: Record<string, unknown>) => string[];
  transformOutput?: (data: unknown) => unknown;
  longRunning?: boolean;
};

const user = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z][a-z0-9_-]*$/, "must be a valid HestiaCP user");
const domain = z.string().min(1).max(253).toLowerCase();
const format = z.enum(["json", "plain"]).default("json");
const yesNo = z.enum(["yes", "no"]);
const password = z.string().min(8).max(1024).describe("Sensitive value; never logged");
const confirm = z.literal(true).describe("Explicit confirmation for a destructive operation");
const text = (input: Record<string, unknown>, key: string): string => String(input[key]);
const strings = (input: Record<string, unknown>, key: string): string[] => {
  const value = input[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${key} must be a string array`);
  }
  return value;
};

const SAFE_SYSTEM_CONFIG_FIELDS = [
  "ANTISPAM_SYSTEM",
  "ANTIVIRUS_SYSTEM",
  "APP_NAME",
  "BACKUP_SYSTEM",
  "CRON_SYSTEM",
  "DB_SYSTEM",
  "DNS_SYSTEM",
  "FILE_MANAGER",
  "FIREWALL_SYSTEM",
  "FTP_SYSTEM",
  "IMAP_SYSTEM",
  "LANGUAGE",
  "MAIL_SYSTEM",
  "PROXY_SYSTEM",
  "RELEASE_BRANCH",
  "STATS_SYSTEM",
  "THEME",
  "VERSION",
  "WEB_BACKEND",
  "WEB_SYSTEM"
] as const;

export function sanitizeSystemConfig(data: unknown): { config: Record<string, unknown> } {
  if (
    data === null ||
    typeof data !== "object" ||
    !("config" in data) ||
    data.config === null ||
    typeof data.config !== "object"
  ) {
    throw new Error("Unexpected v-list-sys-config response shape");
  }

  const config = data.config as Record<string, unknown>;
  return {
    config: Object.fromEntries(
      SAFE_SYSTEM_CONFIG_FIELDS.flatMap((key) =>
        Object.hasOwn(config, key) ? [[key, config[key]]] : []
      )
    )
  };
}

/** Commands already hand-crafted as typed tool specs — skipped by the generated loop. */
export const HANDCRAFTED_COMMANDS: ReadonlySet<string> = new Set(handcraftedCommandsArr);

/**
 * HestiaCP CLI argument limit. No `v-*` script accepts more than 13 positional
 * arguments. This constant is shared between the generator (Zod schema size)
 * and the runtime (argument validation in `generatedArgs`).
 */
export const HESTIA_MAX_ARGS: number = constants.MAX_ARGS;

function read(
  name: string,
  command: `v-${string}`,
  description: string,
  schema: z.ZodType<Record<string, unknown>>,
  args: CommandSpec["args"]
): CommandSpec {
  return { name, command, description, safety: "read", idempotent: true, schema, args };
}

const userFormatSchema = z.object({ user, format });
const userDomainFormatSchema = z.object({ user, domain, format });
const databaseSchema = z.preprocess(
  (input) => {
    if (input !== null && typeof input === "object" && !("type" in input)) {
      return { ...input, type: "mysql" };
    }
    return input;
  },
  z.discriminatedUnion("type", [
    z.object({
      user,
      database: z.string().min(1).max(64),
      databaseUser: z.string().min(1).max(64),
      password,
      type: z.literal("mysql"),
      host: z.string().default(""),
      charset: z.string().min(1).default("UTF8MB4")
    }),
    z.object({
      user,
      database: z.string().min(1).max(64),
      databaseUser: z.string().min(1).max(64),
      password,
      type: z.literal("pgsql"),
      host: z.string().default(""),
      charset: z.string().min(1).default("UTF8")
    })
  ])
);
const toolOutputSchema = z.object({
  ok: z.boolean(),
  command: z.string(),
  data: z.json().optional(),
  error: z
    .object({
      message: z.string(),
      httpStatus: z.number().int().optional(),
      exitCode: z.number().int().optional(),
      outcomeUnknown: z.boolean()
    })
    .optional()
});

function errorDetails(
  command: string,
  error: unknown
): {
  ok: false;
  command: string;
  error: {
    message: string;
    httpStatus?: number;
    exitCode?: number;
    outcomeUnknown: boolean;
  };
} {
  const message = safeError(error);
  if (error instanceof HestiaApiError) {
    return {
      ok: false,
      command,
      error: {
        message,
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        outcomeUnknown: error.outcomeUnknown
      }
    };
  }
  return {
    ok: false,
    command,
    error: { message, outcomeUnknown: false }
  };
}

function formatError(details: ReturnType<typeof errorDetails>): string {
  const metadata = [
    details.command,
    details.error.exitCode === undefined
      ? undefined
      : `Hestia exit ${String(details.error.exitCode)}`,
    details.error.httpStatus === undefined
      ? undefined
      : `HTTP ${String(details.error.httpStatus)}`,
    details.error.outcomeUnknown ? "outcome unknown" : undefined
  ].filter((value): value is string => value !== undefined);
  return `[${metadata.join(", ")}] ${details.error.message}`;
}

export const commandSpecs: readonly CommandSpec[] = [
  read("list_users", "v-list-users", "List HestiaCP users.", z.object({ format }), (v) => [text(v, "format")]),
  read("get_user", "v-list-user", "Get one HestiaCP user.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("list_web_domains", "v-list-web-domains", "List a user's web domains.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("get_web_domain", "v-list-web-domain", "Get one web domain.", userDomainFormatSchema, (v) => [text(v, "user"), text(v, "domain"), text(v, "format")]),
  read("list_dns_domains", "v-list-dns-domains", "List a user's DNS zones.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("get_dns_domain", "v-list-dns-domain", "Get one DNS zone.", userDomainFormatSchema, (v) => [text(v, "user"), text(v, "domain"), text(v, "format")]),
  read("list_dns_records", "v-list-dns-records", "List records in a DNS zone.", userDomainFormatSchema, (v) => [text(v, "user"), text(v, "domain"), text(v, "format")]),
  read("list_mail_domains", "v-list-mail-domains", "List a user's mail domains.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("get_mail_domain", "v-list-mail-domain", "Get one mail domain.", userDomainFormatSchema, (v) => [text(v, "user"), text(v, "domain"), text(v, "format")]),
  read("list_mail_accounts", "v-list-mail-accounts", "List accounts in a mail domain.", userDomainFormatSchema, (v) => [text(v, "user"), text(v, "domain"), text(v, "format")]),
  read("list_databases", "v-list-databases", "List a user's databases.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("get_database", "v-list-database", "Get one database.", z.object({ user, database: z.string().min(1), format }), (v) => [text(v, "user"), text(v, "database"), text(v, "format")]),
  read("list_cron_jobs", "v-list-cron-jobs", "List a user's cron jobs.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("list_user_backups", "v-list-user-backups", "List a user's backups.", userFormatSchema, (v) => [text(v, "user"), text(v, "format")]),
  read("get_system_info", "v-list-sys-info", "Get HestiaCP system information.", z.object({ format }), (v) => [text(v, "format")]),
  {
    ...read(
      "get_system_config",
      "v-list-sys-config",
      "Get an allowlisted, non-sensitive HestiaCP system configuration summary.",
      z.object({}),
      () => ["json"]
    ),
    transformOutput: sanitizeSystemConfig
  },
  read("list_system_services", "v-list-sys-services", "List system services and status.", z.object({ format }), (v) => [text(v, "format")]),
  read("list_system_ips", "v-list-sys-ips", "List configured server IP addresses.", z.object({ format }), (v) => [text(v, "format")]),

  {
    name: "add_user", command: "v-add-user", description: "Create a HestiaCP user.", safety: "mutating",
    schema: z.object({ user, password, email: z.email(), package: z.string().default("default"), firstName: z.string().max(64).default(""), lastName: z.string().max(64).default("") }),
    args: (v) => [text(v, "user"), text(v, "password"), text(v, "email"), text(v, "package"), text(v, "firstName"), text(v, "lastName")]
  },
  {
    name: "add_web_domain", command: "v-add-web-domain", description: "Create a web domain.", safety: "mutating",
    schema: z.object({ user, domain, ip: z.string().default(""), restart: yesNo.default("yes"), aliases: z.string().default(""), proxyExtensions: z.string().default("") }),
    args: (v) => [text(v, "user"), text(v, "domain"), text(v, "ip"), text(v, "restart"), text(v, "aliases"), text(v, "proxyExtensions")]
  },
  {
    name: "issue_web_certificate", command: "v-add-letsencrypt-domain", description: "Issue or renew a Let's Encrypt certificate for a web domain.", safety: "mutating",
    schema: z.object({ user, domain, aliases: z.string().default(""), includeMail: yesNo.default("no") }),
    args: (v) => [text(v, "user"), text(v, "domain"), text(v, "aliases"), text(v, "includeMail")],
    longRunning: true
  },
  {
    name: "add_dns_domain", command: "v-add-dns-domain", description: "Create a DNS zone using HestiaCP defaults.", safety: "mutating",
    schema: z.object({ user, domain, ip: z.string().min(1), nameservers: z.array(domain).max(8).default([]), restart: yesNo.default("yes") }),
    args: (v) => {
      const nameservers = strings(v, "nameservers");
      return [text(v, "user"), text(v, "domain"), text(v, "ip"), ...nameservers, ...Array.from({ length: 8 - nameservers.length }, () => ""), text(v, "restart")];
    }
  },
  {
    name: "add_dns_record", command: "v-add-dns-record", description: "Add a record to an existing DNS zone.", safety: "mutating",
    schema: z.object({ user, domain, record: z.string().min(1), type: z.enum(["A", "AAAA", "CAA", "CNAME", "DNSKEY", "MX", "NS", "PTR", "SRV", "TXT"]), value: z.string().min(1), priority: z.coerce.number().int().min(0).max(65535).default(10), id: z.string().default(""), restart: yesNo.default("yes"), ttl: z.coerce.number().int().min(60).max(604800).default(14400) }),
    args: (v) => ["user", "domain", "record", "type", "value", "priority", "id", "restart", "ttl"].map((key) => text(v, key))
  },
  {
    name: "add_mail_domain", command: "v-add-mail-domain", description: "Create a mail domain.", safety: "mutating",
    schema: z.object({ user, domain, antispam: yesNo.default("yes"), antivirus: yesNo.default("yes"), dkim: yesNo.default("yes"), dkimSize: z.enum(["1024", "2048"]).default("2048"), restart: yesNo.default("yes"), rejectSpam: yesNo.default("no") }),
    args: (v) => ["user", "domain", "antispam", "antivirus", "dkim", "dkimSize", "restart", "rejectSpam"].map((key) => text(v, key))
  },
  {
    name: "add_mail_account", command: "v-add-mail-account", description: "Create a mailbox.", safety: "mutating",
    schema: z.object({ user, domain, account: z.string().min(1).max(64), password, quota: z.union([z.literal("unlimited"), z.coerce.number().int().positive().transform(String)]).default("unlimited") }),
    args: (v) => ["user", "domain", "account", "password", "quota"].map((key) => text(v, key))
  },
  {
    name: "add_database", command: "v-add-database", description: "Create a database and database user.", safety: "mutating",
    schema: databaseSchema,
    args: (v) => ["user", "database", "databaseUser", "password", "type", "host", "charset"].map((key) => text(v, key))
  },
  {
    name: "add_cron_job", command: "v-add-cron-job", description: "Create a cron job that executes an arbitrary shell command.", safety: "destructive",
    schema: z.object({ user, minute: z.string().min(1), hour: z.string().min(1), day: z.string().min(1), month: z.string().min(1), weekday: z.string().min(1), command: z.string().min(1).max(4096), jobId: z.string().default(""), restart: yesNo.default("yes"), confirm }),
    args: (v) => ["user", "minute", "hour", "day", "month", "weekday", "command", "jobId", "restart"].map((key) => text(v, key))
  },
  {
    name: "backup_user", command: "v-backup-user", description: "Start a complete user backup.", safety: "mutating",
    schema: z.object({ user, notify: yesNo.default("no") }),
    args: (v) => [text(v, "user"), text(v, "notify")],
    longRunning: true
  },
  {
    name: "suspend_user", command: "v-suspend-user", description: "Suspend a user and their services.", safety: "destructive", idempotent: true,
    schema: z.object({ user, restart: yesNo.default("yes"), confirm }),
    args: (v) => [text(v, "user"), text(v, "restart")]
  },
  {
    name: "unsuspend_user", command: "v-unsuspend-user", description: "Unsuspend a user and their services.", safety: "mutating", idempotent: true,
    schema: z.object({ user, restart: yesNo.default("yes") }),
    args: (v) => [text(v, "user"), text(v, "restart")]
  },

  ...([
    ["delete_user", "v-delete-user", "Delete a user and all owned data.", z.object({ user, restart: yesNo.default("yes"), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "restart")]],
    ["delete_web_domain", "v-delete-web-domain", "Delete a web domain and its files.", z.object({ user, domain, restart: yesNo.default("yes"), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "domain"), text(v, "restart")]],
    ["delete_dns_domain", "v-delete-dns-domain", "Delete a DNS zone and all records.", z.object({ user, domain, confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "domain")]],
    ["delete_dns_record", "v-delete-dns-record", "Delete a DNS record.", z.object({ user, domain, id: z.coerce.number().int().positive(), restart: yesNo.default("yes"), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "domain"), text(v, "id"), text(v, "restart")]],
    ["delete_mail_domain", "v-delete-mail-domain", "Delete a mail domain and all mailboxes.", z.object({ user, domain, confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "domain")]],
    ["delete_mail_account", "v-delete-mail-account", "Delete a mailbox and its messages.", z.object({ user, domain, account: z.string().min(1), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "domain"), text(v, "account")]],
    ["delete_database", "v-delete-database", "Delete a database.", z.object({ user, database: z.string().min(1), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "database")]],
    ["delete_cron_job", "v-delete-cron-job", "Delete a cron job.", z.object({ user, jobId: z.coerce.number().int().positive(), confirm }), (v: Record<string, unknown>) => [text(v, "user"), text(v, "jobId")]]
  ] as const).map(([name, command, description, schema, args]) => ({
    name, command, description, schema, args, safety: "destructive" as const, idempotent: false
  }))
];

// ── Generated tool helpers ────────────────────────────────────────────────

export function __generatedSchema(entry: CommandEntry): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  for (const arg of entry.args) {
    if (arg.kind === "confirm") {
      shape[arg.name] = z.literal(true);
    } else if (arg.optional) {
      shape[arg.name] = z.string().optional().describe(arg.name);
    } else {
      shape[arg.name] = z.string().min(1).describe(arg.name);
    }
  }
  // Add confirm field for destructive and system risk classes
  if (entry.risk === "destructive" || entry.risk === "system") {
    if (!("confirm" in shape)) {
      shape.confirm = z.literal(true).describe("Type true to confirm this potentially dangerous operation");
    }
  }
  return z.object(shape);
}

export function createServer(
  client: HestiaClient,
  config: Pick<Config, "allowMutations" | "allowDestructive" | "allowSystem" | "longRunningTimeoutMs" | "toolProfile">
): McpServer {
  const server = new McpServer({ name: "hestiacp-mcp", version: "0.1.0" });

  for (const spec of commandSpecs) {
    server.registerTool(
      spec.name,
      {
        title: spec.name.replaceAll("_", " "),
        description: `${spec.description} Executes verified command ${spec.command}.`,
        inputSchema: spec.schema,
        outputSchema: toolOutputSchema,
        annotations: {
          readOnlyHint: spec.safety === "read",
          destructiveHint: spec.safety === "destructive",
          idempotentHint: spec.idempotent ?? spec.safety === "read",
          openWorldHint: true
        }
      },
      async (rawInput) => {
        const blockMsg = gateCheck(spec.safety, config);
        if (blockMsg !== null) {
          const details = errorDetails(spec.command, new Error(blockMsg));
          return {
            isError: true,
            content: [{ type: "text", text: formatError(details) }],
            structuredContent: redact(details)
          };
        }

        try {
          const input = spec.schema.parse(rawInput);
          const args = spec.args(input);
          const result = spec.longRunning
            ? await client.execute(spec.command, args, {
                timeoutMs: config.longRunningTimeoutMs
              })
            : await client.execute(spec.command, args);
          const data = redact(spec.transformOutput?.(result.data) ?? result.data);
          const structuredContent = { ok: true as const, command: spec.command, data };
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            structuredContent
          };
        } catch (error) {
          const details = errorDetails(spec.command, error);
          return {
            isError: true,
            content: [{ type: "text", text: formatError(details) }],
            structuredContent: redact(details)
          };
        }
      }
    );
  }


  function entryRiskClass(entry: CommandEntry): "read" | "mutating" | "destructive" | "system" {
  return entry.risk;
}

function toolTitle(cmd: string): string {
  return cmd.replace(/^v-/, "").replaceAll("-", " ");
}

function generatedDescription(entry: CommandEntry): string {
  let desc = entry.description;
  if (entry.notes) {
    desc += ` (${entry.notes})`;
  }
  desc += ` Executes command ${entry.command}.`;
  return desc;
}

function toolAnnotation(risk: string) {
  return {
    readOnlyHint: risk === "read",
    destructiveHint: risk === "destructive" || risk === "system",
    idempotentHint: risk === "read",
    openWorldHint: true
  };
}

function gateCheck(
  risk: string,
  cfg: Pick<Config, "allowMutations" | "allowDestructive" | "allowSystem">
): string | null {
  if (risk === "read") return null;
  if (!cfg.allowMutations) {
    return "Mutating tools are disabled. Set HESTIACP_ALLOW_MUTATIONS=true to enable them.";
  }
  if (risk === "mutating") return null;
  if (!cfg.allowDestructive) {
    return "Destructive tools are disabled. Set HESTIACP_ALLOW_DESTRUCTIVE=true as well as HESTIACP_ALLOW_MUTATIONS=true.";
  }
  if (risk === "system" && !cfg.allowSystem) {
    return "System-level tools are disabled. Set HESTIACP_ALLOW_SYSTEM=true as well as HESTIACP_ALLOW_DESTRUCTIVE=true and HESTIACP_ALLOW_MUTATIONS=true.";
  }
  return null;
}

/**
 * Build the positional argument array for a generated command invocation.
 *
 * HestiaCP uses positional CLI binding: every index maps to a specific argument,
 * and empty strings act as placeholders for missing optional arguments.
 *
 * **Known limitation (#24):** When an optional argument at position N is omitted
 * but a required argument at position N+1 is provided, the array keeps an empty
 * string at position N. The HestiaCP CLI treats `""` as a valid (empty) positional
 * value, which may have unintended side-effects for certain commands. This is a
 * fundamental constraint of positional argument encoding — the only workaround
 * would be per-command arg-remapping (as done for v-make-tmp-file). No upstream
 * 0pen-source `v-*` script exhibits this pathological ordering for mandatory args.
 *
 * Trailing empty strings are trimmed before invocation (the HestiaCP API does not
 * require them).
 */
/**
 * Validate filename for v-make-tmp-file inputs.
 *
 * Filenames must consist of alphanumeric characters, dots, underscores, and
 * hyphens. A leading dot is allowed (e.g. ".htaccess", ".env").
 */
function validateTmpFileArgs(filename: string): string {
  const DOT_FILE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$|^\.[a-zA-Z0-9._-]+$/;
  if (!DOT_FILE_RE.test(filename)) {
    const safe = JSON.stringify(filename.length > 100 ? filename.slice(0, 100) + "…" : filename);
    throw new Error(
      `Invalid filename ${safe} for v-make-tmp-file. ` +
      `Filename must match ${String(DOT_FILE_RE)}.`
    );
  }
  return filename;
}

/**
 * Trim trailing empty placeholders and enforce the HestiaCP positional-arg cap.
 */
function capArgs(result: string[]): string[] {
  while (result.length > 0 && result[result.length - 1] === "") {
    result.pop();
  }
  if (result.length > HESTIA_MAX_ARGS) {
    throw new Error(
      `Too many arguments (${String(result.length)}). HestiaCP API limit is ${String(HESTIA_MAX_ARGS)}.`
    );
  }
  return result;
}

function generatedArgs(entry: CommandEntry, input: Record<string, unknown>): string[] {
  // v-make-tmp-file requires two ordered arguments:
  // arg1: file content (string, may contain multi-line or binary-safe data)
  // arg2: optional filename (defaults to 'mcp-tmp' if empty)
  if (entry.command === "v-make-tmp-file") {
    const content = typeof input.CONTENT === "string" ? input.CONTENT : "";
    const raw = typeof input.FILENAME === "string" ? basename(input.FILENAME) : "";
    return capArgs([content, validateTmpFileArgs(raw)]);
  }
  const result: string[] = new Array<string>(entry.args.length).fill("");
  for (let i = 0; i < entry.args.length; i++) {
    const arg = entry.args[i];
    if (!arg) continue;
    const val: unknown = input[arg.name];
    if (val !== undefined && val !== null) {
      result[i] = typeof val === "string" ? val : JSON.stringify(val);
    } else if (!arg.optional) {
      throw new Error(`Missing required argument: ${arg.name} (position ${String(i + 1)})`);
    }
    // optional args missing stay as "" (placeholder — see JSDoc above)
  }
  return capArgs(result);
}

const generatedToolMap = new Map<string, RegisteredTool>();

// Build TOOL_GROUPS dynamically from generated commands
type ToolGroup = {
  prefix: string;
  description: string;
}
function buildToolGroups(): Record<string, ToolGroup> {
  const groups: Record<string, ToolGroup> = {};
  const seen = new Set<string>();
  for (const c of allCommands) {
    if (HANDCRAFTED_COMMANDS.has(c.command)) continue;
    // Build 3-segment prefix: v-<action>-<target>
    const parts = c.command.split("-");
    if (parts.length >= 3) {
      const prefix = parts.slice(0, 3).join("-");
      if (!seen.has(prefix)) {
        seen.add(prefix);
        groups[prefix] = { prefix, description: `Tools for ${prefix}` };
      }
    }
  }
  return groups;
}
const TOOL_GROUPS = buildToolGroups();

  // ── Generated tool registration ──────────────────────────────────────────
  const enabledGenerated = new Set<string>();
  const profile = config.toolProfile;

  for (const entry of allCommands) {
    if (HANDCRAFTED_COMMANDS.has(entry.command)) continue;

    const schema: z.ZodObject<Record<string, z.ZodType>> = __generatedSchema(entry);
    const risk = entryRiskClass(entry);
    // Register all, but immediately disable if profile === "curated"
    const tool = server.registerTool(
      entry.command,
      {
        title: toolTitle(entry.command),
        description: generatedDescription(entry),
        inputSchema: schema,
        outputSchema: toolOutputSchema,
        annotations: toolAnnotation(risk)
      },
      async (rawInput: unknown) => {
        const blockMsg = gateCheck(risk, config);
        if (blockMsg !== null) {
          const details = errorDetails(entry.command, new Error(blockMsg));
          return {
            isError: true,
            content: [{ type: "text", text: formatError(details) }],
            structuredContent: redact(details)
          };
        }

        try {
          const input = schema.parse(rawInput);
          const args = generatedArgs(entry, input);
          const result = await client.execute(entry.command, args);
          const data = redact(result.data);
          const structuredContent = { ok: true as const, command: entry.command, data };
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
            structuredContent
          };
        } catch (error) {
          const details = errorDetails(entry.command, error);
          return {
            isError: true,
            content: [{ type: "text", text: formatError(details) }],
            structuredContent: redact(details)
          };
        }
      }
    );

    generatedToolMap.set(entry.command, tool);
    if (profile === "curated") {
      tool.disable();
    } else {
      enabledGenerated.add(entry.command);
    }
  }

  // ── Meta-tools (always registered, always read-only) ─────────────────────
  server.registerTool(
    "list_tool_groups",
    {
      title: "list tool groups",
      description: "List all auto-generated tool group prefixes that can be managed via set_tool_group.",
      inputSchema: z.object({}),
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    () => {
      const groups = Object.entries(TOOL_GROUPS).map(([, g]) => {
        const cmds = allCommands.filter(
          (c) => !HANDCRAFTED_COMMANDS.has(c.command) && c.command.startsWith(g.prefix)
        );
        const active = cmds.filter((c) => enabledGenerated.has(c.command));
        return {
          prefix: g.prefix,
          description: g.description,
          total: cmds.length,
          enabled: active.length
        };
      });
      const structuredContent = {
        ok: true as const,
        command: "list_tool_groups",
        data: { groups }
      };
      return {
        content: [{ type: "text", text: JSON.stringify(groups, null, 2) }],
        structuredContent
      };
    }
  );

  server.registerTool(
    "set_tool_group",
    {
      title: "set tool group",
      description: "Enable or disable all auto-generated tools matching a given prefix. Use list_tool_groups to see available prefixes.",
      inputSchema: z.object({
        prefix: z.string().min(1).describe("Tool group prefix (e.g. 'v-list-sys', 'v-add-web-domain')"),
        enabled: z.boolean().describe("true to enable, false to disable")
      }),
      outputSchema: toolOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    (rawInput: unknown) => {
      const params = rawInput as { prefix: string; enabled: boolean };
      const { prefix, enabled: enable } = params;

      // Enabling/disabling tools is a mutating operation (it changes tool availability)
      const blockMsg = gateCheck("mutating", config);
      if (blockMsg !== null) {
        const details = errorDetails("set_tool_group", new Error(blockMsg));
        return { isError: true, content: [{ type: "text", text: formatError(details) }], structuredContent: redact(details) };
      }

      // Validate prefix matches at least one generated tool (prevents typos)
      const matched: string[] = [];
      for (const [cmdName, tool] of generatedToolMap) {
        if (cmdName.startsWith(prefix)) {
          matched.push(cmdName);
          if (enable) {
            tool.enable();
            enabledGenerated.add(cmdName);
          } else {
            tool.disable();
            enabledGenerated.delete(cmdName);
          }
        }
      }

      if (matched.length === 0) {
        const details = errorDetails("set_tool_group", new Error(`No generated tools match prefix '${prefix}'. Use list_tool_groups to see valid prefixes.`));
        return { isError: true, content: [{ type: "text", text: formatError(details) }], structuredContent: redact(details) };
      }

      const structuredContent = {
        ok: true as const,
        command: "set_tool_group",
        data: { prefix, enabled: enable, matchedCount: matched.length, matched }
      };
      return {
        content: [{ type: "text", text: `${enable ? "Enabled" : "Disabled"} ${String(matched.length)} tools matching '${prefix}'` }],
        structuredContent
      };
    }
  );

  // ── Startup schema validation ──────────────────────────────────────────
  // Validate every generated schema at startup so broken schemas are caught
  // immediately rather than at invocation time.
  for (const entry of allCommands) {
    if (HANDCRAFTED_COMMANDS.has(entry.command)) continue;
    try {
      // __generatedSchema adds mandatory `confirm: z.literal(true)` for destructive/system,
      // so provide it to test schemas with no visible required args.
      const needsImplicitConfirm = entry.risk === "destructive" || entry.risk === "system";
      const testInput = needsImplicitConfirm ? { confirm: true } : {};
      const result = __generatedSchema(entry).safeParse(testInput);
      if (!result.success) {
        // Expected for commands with required args; only warn on unexpected errors
        const hasRequired = entry.args.some(a => !a.optional);
        if (!hasRequired) {
          console.warn(
            `[startup] Schema validation failed for "${entry.command}" (all args optional):`,
            result.error.issues.map(i => i.message).join("; ")
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[startup] Skipping broken tool "${entry.command}":`, msg);
    }
  }

  return server;
}
