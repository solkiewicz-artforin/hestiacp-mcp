#!/usr/bin/env node
/**
 * Code generator: parses upstream HestiaCP bin/v-* scripts and builds
 * a deterministic JSON catalog of all commands with their arguments,
 * risk classification, and metadata.
 *
 * Usage:
 *   node scripts/generate-commands.mjs --upstream /path/to/hestia
 * Outputs:
 *   src/generated/commands.json — versioned catalog
 *   stdout summary
 */

import { parseArgs } from "node:util";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";

/**
 * HestiaCP CLI argument limit. No `v-*` script accepts more than 13
 * positional arguments. Must match HESTIA_MAX_ARGS in src/tools.ts
 */
const MAX_ARGS = 13;
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import handcraftedCommandsArr from "../src/generated/handcrafted-commands.json" with { type: "json" };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const GENERATED_DIR = join(ROOT, "src", "generated");
const DEFAULT_OUTPUT_PATH = join(GENERATED_DIR, "commands.json");
const OVERRIDES_PATH = join(GENERATED_DIR, "risk-overrides.json");

// ── Risk classification prefixes (priority descending) ────────────────────
const READ_PREFIXES = [
  "list", "search", "get", "check", "show", "display",
  "view", "is", "status", "test", "open"
];

// System: commands with "-sys-" pattern (operating on the panel/server itself).
// Does NOT include "-hestia-" — those 2 commands (v-add-cron-hestia-autoupdate,
// v-delete-cron-hestia-autoupdate) are mutating/destructive respectively, classified
// by their operation prefix.
const SYSTEM_PATTERNS = ["-sys-"];

const DESTRUCTIVE_PREFIXES = [
  "delete", "change", "update", "rebuild", "restart", "suspend",
  "unsuspend", "restore", "remove", "replace", "set", "enable",
  "disable", "start", "stop", "purge", "flush", "clean", "repair", "revoke"
];

const MUTATING_PREFIXES = [
  "add", "copy", "import", "backup", "schedule", "generate", "move",
  "rename", "sort", "create", "upload", "insert", "log", "dump",
  "export", "extract", "download", "acknowledge", "sync"
];

// ── Known API pseudo-commands (not in bin/) ────────────────────────────────
const API_PSEUDO_COMMANDS = [
  {
    name: "v-make-tmp-file",
    command: "v-make-tmp-file",
    description: "Create a temporary file on the server (API built-in). Writes content to /tmp/<filename>.",
    args: [
      { name: "CONTENT", optional: false, kind: "string" },
      { name: "FILENAME", optional: false, kind: "string" }
    ],
    risk: "mutating",
    notes: "API pseudo-command — arg1=content, arg2=filename. File is written to /tmp/.",
    usage_example: "v-make-tmp-file mycontent myfile.txt",
    stdin: false,
    fileArg: false
  }
];

// ── Handcrafted tool names to exclude from auto-registration ───────────────
const HANDCRAFTED_COMMANDS = new Set(handcraftedCommandsArr);

// ── Sanitization ───────────────────────────────────────────────────────────

/**
 * Sanitize a `# info:` description to prevent prompt injection.
 *
 * HestiaCP script info headers flow directly into MCP tool descriptions
 * consumed by LLMs. Malicious upstream text could be interpreted as agent
 * instructions. Strip control chars, code fences, and double-brace injection.
 */
function sanitizeDescription(raw) {
  return raw
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // keep \t, \n, \r   // control chars (keep \t, \n)
    .replace(/```[^]*?```/gs, '')                          // markdown code blocks
    .replace(/\[.*?\]\(javascript:/gi, '[link](')                    // javascript: URIs
    .replace(/\{\{[^{}]*\}\}/g, '')                                // double-brace injection
    .replace(/\n{3,}/g, '\n\n')                                      // collapse long newline runs
    .trim();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseArgsFromHeader(headerLine) {
  // e.g. "# options: USER PASSWORD EMAIL [PACKAGE] [NAME] [LASTNAME]"
  const raw = headerLine.replace(/^#\s*options:\s*/i, "").trim();
  if (!raw || raw.toLowerCase() === "none") return [];

  const tokens = raw.split(/\s+/).filter(Boolean);
  const args = [];
  for (const token of tokens) {
    const optional = token.startsWith("[") && token.endsWith("]");
    const name = optional ? token.slice(1, -1).replace(/\.\.\.$/, "…") : token;
    args.push({
      name: name.toUpperCase(),
      optional,
      kind: "string"
    });
  }
  return args;
}

function extractHeader(lines, key) {
  for (const line of lines) {
    const m = line.match(new RegExp(`^#\\s*${key}:\\s*(.*)`, "i"));
    if (m) return m[1].trim();
  }
  return "";
}

function classifyRisk(name, overrides) {
  // 1. Manual overrides always win
  if (overrides[name]) return overrides[name];

  // Strip "v-" prefix and get operation prefix
  const withoutV = name.replace(/^v-/, "");

  // 2. READ check first (wins over -sys- patterns)
  const opPrefix = withoutV.split("-")[0];
  if (opPrefix && READ_PREFIXES.includes(opPrefix)) {
    return "read";
  }

  // 3. SYSTEM check — contains -sys- (not -hestia-) and NOT read
  for (const pattern of SYSTEM_PATTERNS) {
    if (withoutV.includes(pattern)) return "system";
  }

  // 4. DESTRUCTIVE check
  if (opPrefix && DESTRUCTIVE_PREFIXES.includes(opPrefix)) {
    return "destructive";
  }

  // 5. MUTATING check
  if (opPrefix && MUTATING_PREFIXES.includes(opPrefix)) {
    return "mutating";
  }

  // 6. No match — error
  throw new Error(
    `Cannot classify risk for command "${name}". ` +
    `Operation prefix "${opPrefix}" does not match any known risk category. ` +
    `Add a manual override in src/generated/risk-overrides.json.`
  );
}

function determineNotes(name, args, risk) {
  const notes = [];

  if (name === "v-delete-sys-mail-queue" || name === "v-update-sys-hestia-git") {
    notes.push("This command reads from stdin interactively. Via the API, stdin receives immediate EOF so the interactive prompt cannot be answered — the command will likely be rejected or fail silently.");
  }

  // FILE-type arguments: only mark when an arg name is literally "FILE" (exact match).
  // This matches HestiaCP's REST API handler which treats "FILE" args specially —
  // the file must already exist on the server (the API sends a filename, not content).
  // Other path-like args (SRC_FILE, ARCHIVE, BACKUP, SNAPSHOT, OBJECT, PATH) are
  // regular string arguments from the API's perspective.
  const hasFileArg = args.some(a => a.name === "FILE");
  if (hasFileArg) {
    notes.push("Requires a file path on the SERVER side. This tool sends a filename string; the file must already exist at that path on the HestiaCP host.");
  }

  return notes.length > 0 ? notes.join(" | ") : "";
}

function parseScript(filePath) {
  const name = basename(filePath);
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  const info = extractHeader(lines, "info");
  const optionsRaw = extractHeader(lines, "options");
  const exampleRaw = extractHeader(lines, "example");

  let description = sanitizeDescription(info || `${name}`);
  const args = optionsRaw ? parseArgsFromHeader(`# options: ${optionsRaw}`) : [];

  return {
    name,
    command: name,
    description,
    args,
    risk: null, // filled later
    notes: "",  // filled later
    usage_example: sanitizeDescription(exampleRaw || ""),
    stdin: (name === "v-delete-sys-mail-queue" || name === "v-update-sys-hestia-git"),
    fileArg: false // filled later
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  options: {
    upstream: { type: "string", short: "u" },
    output: { type: "string", short: "o" },
    riskOverrides: { type: "string" },
    noApiPseudo: { type: "boolean", default: false }
  }
});

// Resolve output path: --output flag, or default
const OUTPUT_PATH = values.output || DEFAULT_OUTPUT_PATH;

if (!values.upstream) {
  console.error("Error: --upstream <path> is required (point to HestiaCP checkout)");
  process.exit(1);
}

const binDir = join(values.upstream, "bin");
let scripts;
try {
  scripts = readdirSync(binDir).filter(f => f.startsWith("v-")).sort();
} catch (e) {
  console.error(`Error: cannot read ${binDir}:`, e.message);
  process.exit(1);
}

// Load manual risk overrides — three sources, highest priority first:
// 1. HESTIACP_RISK_OVERRIDES env var (JSON string) — for testability
// 2. --riskOverrides <path> CLI flag
// 3. src/generated/risk-overrides.json (default, versioned)
let overrides = {};
const envOverrides = process.env.HESTIACP_RISK_OVERRIDES;
if (envOverrides) {
  try {
    overrides = JSON.parse(envOverrides);
  } catch (err) {
    console.error(`Error parsing HESTIACP_RISK_OVERRIDES: ${err.message}`);
    process.exit(1);
  }
  // Parse overrides but defer risk-downgrade validation until commands are
  // populated (the validation loop references `commands`).
} else if (values.riskOverrides) {
  overrides = JSON.parse(readFileSync(values.riskOverrides, "utf-8"));
} else {
  try {
    overrides = JSON.parse(readFileSync(OVERRIDES_PATH, "utf-8"));
  } catch {
    console.warn("Warning: no risk-overrides.json found — proceeding without overrides");
  }
}

// Parse all scripts
const commands = [];

for (const script of scripts) {
  const filePath = join(binDir, script);
  const cmd = parseScript(filePath);

  // Validate argument count before risk classification (hard limit: MAX_ARGS args)
  if (cmd.args.length > MAX_ARGS) {
    throw new Error(
      `Command "${cmd.name}" has ${cmd.args.length} arguments, which exceeds the API limit of ${MAX_ARGS}. ` +
      `The HestiaCP REST API truncates all arguments beyond the ${MAX_ARGS}th position.`
    );
  }
  cmd.risk = classifyRisk(cmd.name, overrides);
  cmd.notes = determineNotes(cmd.name, cmd.args, cmd.risk);
  cmd.fileArg = cmd.notes.includes("Requires a file path on the SERVER side");
  commands.push(cmd);
}

// Add API pseudo-commands
if (!values.noApiPseudo) {
  for (const pseudo of API_PSEUDO_COMMANDS) {
    pseudo.risk = classifyRisk(pseudo.name, overrides);
    commands.push(pseudo);
  }
}

// Validate no risk-level downgrades (destructive→mutating, system→read) unless --force
if (Object.keys(overrides).length > 0 && !values.force) {
  const riskSeverity = { destructive: 3, system: 3, mutating: 2, read: 1 };
  for (const [cmd, level] of Object.entries(overrides)) {
    const cmdObj = commands.find((c) => c.command === cmd);
    if (cmdObj && riskSeverity[level] < riskSeverity[cmdObj.risk]) {
      console.error(
        `Risk override for "${cmd}" downgrades risk from "${cmdObj.risk}" to "${level}". ` +
        `Use --force to allow this.`
      );
      process.exit(1);
    }
  }
}

// Sort for determinism
commands.sort((a, b) => a.name.localeCompare(b.name));

// ── Deterministic catalog (versioned, committed) ───────────────────────────
// Contains ONLY deterministic data: sorted commands + risk counts.
// No timestamps, paths, or other run-specific metadata — those go to stderr.
const catalog = {
  total: commands.length,
  handcrafted_count: HANDCRAFTED_COMMANDS.size,
  auto_register_count: commands.filter(c => !HANDCRAFTED_COMMANDS.has(c.command)).length,
  risk_counts: {
    read: commands.filter(c => c.risk === "read").length,
    mutating: commands.filter(c => c.risk === "mutating").length,
    destructive: commands.filter(c => c.risk === "destructive").length,
    system: commands.filter(c => c.risk === "system").length
  },
  commands
};

// Write deterministic output (ensure parent directory exists)
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf-8");

// Transient metadata to stderr only (never committed)
const transient = {
  generated_at: new Date().toISOString(),
  upstream_path: values.upstream,
};

// Try to detect upstream commit SHA for provenance
let upstreamSha = "unknown";
try {
  const { execSync } = await import("node:child_process");
  upstreamSha = execSync("git rev-parse HEAD", { cwd: values.upstream, encoding: "utf-8" }).trim();
  transient.upstream_sha = upstreamSha;
} catch {
  // not a git repo or git not available — non-fatal
  transient.upstream_sha = upstreamSha;
}

console.error(`[meta] ${JSON.stringify(transient)}`);
console.log(`✅ Generated ${commands.length} commands → ${OUTPUT_PATH}`);
console.log(`   Risk: read=${catalog.risk_counts.read}, mutating=${catalog.risk_counts.mutating}, destructive=${catalog.risk_counts.destructive}, system=${catalog.risk_counts.system}`);
console.log(`   Handcrafted (excluded): ${catalog.handcrafted_count}`);
console.log(`   Auto-register: ${catalog.auto_register_count}`);
if (upstreamSha !== "unknown") {
  console.log(`   Upstream: ${upstreamSha}`);
}