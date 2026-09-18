import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Generator module tests ─────────────────────────────────────────────────
// These test the codegen script itself (scripts/generate-commands.mjs).
// They use a synthetic upstream directory with fake v-* scripts so we don't
// require the real HestiaCP checkout.

type CommandEntry = {
  command: string;
  name: string;
  description: string;
  args: { name: string; optional: boolean; kind: string }[];
  risk: string;
  stdin?: boolean;
  fileArg?: boolean;
};

type Catalog = {
  commands: CommandEntry[];
  risk_counts: Record<string, number>;
};

function findCmd(catalog: Catalog, name: string): CommandEntry {
  const entry = catalog.commands.find((c) => c.command === name);
  if (!entry) throw new Error(`Command ${name} not found in catalog`);
  return entry;
}

describe("generate-commands.mjs", () => {
  function runGenerator(
    upstreamDir: string,
    riskOverrides?: Record<string, string>,
    extraArgs: string[] = ["--noApiPseudo"]
  ): Catalog {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-"));
    const outFile = path.join(tmpdir, "commands.json");
    const cmd = [
      "node",
      path.resolve(__dirname, "..", "scripts", "generate-commands.mjs"),
      "--upstream",
      upstreamDir,
      "--output",
      outFile,
      ...extraArgs,
    ];
    const env: Record<string, string | undefined> = { ...process.env };
    if (riskOverrides) {
      env.HESTIACP_RISK_OVERRIDES = JSON.stringify(riskOverrides);
    }
    execSync(cmd.join(" "), { encoding: "utf-8", stdio: "pipe", env });
    const raw = fs.readFileSync(outFile, "utf-8");
    const result = JSON.parse(raw) as Catalog;
    fs.rmSync(tmpdir, { recursive: true, force: true });
    return result;
  }

  function writeScript(dir: string, name: string, info: string, options: string, example = "") {
    const content = `#!/bin/bash
# info: ${info}
# options: ${options}
${example ? `# example: ${example}` : ""}
echo "${name} ran"
`;
    fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
  }

  function scratchUpstream(scripts: { name: string; info: string; options: string }[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hestia-bin-"));
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    for (const s of scripts) {
      writeScript(binDir, s.name, s.info, s.options);
    }
    return dir;
  }

  // ── Parsing ────────────────────────────────────────────────────────────

  it("parses '# info:' header as description", () => {
    const dir = scratchUpstream([
      { name: "v-list-users", info: "List system users", options: "USER" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-list-users");
    expect(cmd.description).toBe("List system users");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses positional args from '# options:' (SIMPLE)", () => {
    const dir = scratchUpstream([
      { name: "v-add-user", info: "Add user", options: "USER PASSWORD EMAIL [PACKAGE] [NAME]" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-add-user");
    expect(cmd.args.map((a) => a.name)).toEqual([
      "USER",
      "PASSWORD",
      "EMAIL",
      "PACKAGE",
      "NAME",
    ]);
    expect(cmd.args.map((a) => a.optional)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parse optional args have optional = true, required args = false", () => {
    const dir = scratchUpstream([
      { name: "v-add-domain", info: "Add domain", options: "USER DOMAIN [IP] [RESTART]" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-add-domain");
    expect(cmd.args.length).toBe(4);
    expect(cmd.args.length >= 4 && cmd.args[0]?.optional).toBe(false);
    expect(cmd.args.length >= 4 && cmd.args[1]?.optional).toBe(false);
    expect(cmd.args.length >= 4 && cmd.args[2]?.optional).toBe(true);
    expect(cmd.args.length >= 4 && cmd.args[3]?.optional).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles commands without '# options:' (4 known)", () => {
    const dir = scratchUpstream([
      { name: "v-delete-user-auth-log", info: "Delete auth log", options: "" },
    ]);
    // Write script WITHOUT options header (simulates real edge case)
    const binDir = path.join(dir, "bin");
    fs.writeFileSync(
      path.join(binDir, "v-delete-user-auth-log"),
      `#!/bin/bash\n# info: Delete auth log records\necho "ok"\n`,
      { mode: 0o755 }
    );
    const catalog = runGenerator(dir);
    const cmd = findCmd(
      catalog,
      "v-delete-user-auth-log"
    );
    expect(cmd.args).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects stdin marker commands", () => {
    const dir = scratchUpstream([
      { name: "v-delete-sys-mail-queue", info: "Delete mail queue", options: "" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(
      catalog,
      "v-delete-sys-mail-queue"
    );
    // Known stdin command — detected by hardcoded list in generator
    expect(cmd.stdin).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects FILE commands", () => {
    const dir = scratchUpstream([
      { name: "v-import-cpanel", info: "Import cPanel", options: "USER FILE [OVERWRITE]" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-import-cpanel");
    // Options contains "FILE" — generator should detect this
    expect(cmd.fileArg).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("all required args go before optionals in order", () => {
    const dir = scratchUpstream([
      {
        name: "v-add-database",
        info: "Add database",
        options: "USER DATABASE DBUSER DBPASS [TYPE] [HOST] [CHARSET]",
      },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(
      catalog,
      "v-add-database"
    );
    // Required: USER, DATABASE, DBUSER, DBPASS
    // Optional: TYPE, HOST, CHARSET
    expect(cmd.args[0]).toMatchObject({ name: "USER", optional: false });
    expect(cmd.args[3]).toMatchObject({ name: "DBPASS", optional: false });
    expect(cmd.args[4]).toMatchObject({ name: "TYPE", optional: true });
    expect(cmd.args[5]).toMatchObject({ name: "HOST", optional: true });
    expect(cmd.args[6]).toMatchObject({ name: "CHARSET", optional: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Argument limits ──────────────────────────────────────────────────────

  it("rejects commands with more than 13 arguments", () => {
    const tooManyArgs = Array.from({ length: 14 }, (_, i) => `ARG${String(i + 1)}`).join(" ");
    const dir = scratchUpstream([
      { name: "v-too-many", info: "Has too many args", options: tooManyArgs },
    ]);
    expect(() => runGenerator(dir)).toThrow(/14 arguments|exceeds.*limit/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── Risk classification ──────────────────────────────────────────────────

  it("classifies a read prefix as 'read' even with -sys-", () => {
    const dir = scratchUpstream([
      { name: "v-list-sys-config", info: "List sys config", options: "[FORMAT]" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-list-sys-config");
    expect(cmd.risk).toBe("read");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies v-add-user as 'mutating'", () => {
    const dir = scratchUpstream([
      { name: "v-add-user", info: "Add user", options: "USER PASSWORD EMAIL" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-add-user");
    expect(cmd.risk).toBe("mutating");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies v-delete-user as 'destructive'", () => {
    const dir = scratchUpstream([
      { name: "v-delete-user", info: "Delete user", options: "USER [RESTART]" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-delete-user");
    expect(cmd.risk).toBe("destructive");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("classifies v-restart-system as 'system' via override", () => {
    const dir = scratchUpstream([
      { name: "v-restart-system", info: "Restart system services", options: "[RESTART]" },
    ]);
    const catalog = runGenerator(dir, { "v-restart-system": "system" });
    const cmd = findCmd(catalog, "v-restart-system");
    expect(cmd.risk).toBe("system");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to mutating with a warning on unknown operation prefix", () => {
    const dir = scratchUpstream([
      { name: "v-foobar-something", info: "Unknown operation", options: "THING" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-foobar-something");
    expect(cmd.risk).toBe("mutating");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // ── JSON parse error logging (LOW #9) ──────────────────────────────────

  it("fails gracefully when HESTIACP_RISK_OVERRIDES is invalid JSON", () => {
    const dir = scratchUpstream([
      { name: "v-list-users", info: "List users", options: "" },
    ]);
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-"));
    const outFile = path.join(tmpdir, "commands.json");
    const cmd = [
      "node",
      path.resolve(__dirname, "..", "scripts", "generate-commands.mjs"),
      "--upstream", dir,
      "--output", outFile,
      "--noApiPseudo",
    ];
    const env = { ...process.env, HESTIACP_RISK_OVERRIDES: "not valid json {{{" };
    expect(() => execSync(cmd.join(" "), { encoding: "utf-8", stdio: "pipe", env })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("fails when --riskOverrides file contains malformed JSON", () => {
    const dir = scratchUpstream([
      { name: "v-list-users", info: "List users", options: "" },
    ]);
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gen-test-"));
    const outFile = path.join(tmpdir, "commands.json");
    const badJson = path.join(tmpdir, "bad.json");
    fs.writeFileSync(badJson, "{invalid json content}", "utf-8");
    const cmd = [
      "node",
      path.resolve(__dirname, "..", "scripts", "generate-commands.mjs"),
      "--upstream", dir,
      "--output", outFile,
      "--riskOverrides", badJson,
      "--noApiPseudo",
    ];
    expect(() => execSync(cmd.join(" "), { encoding: "utf-8", stdio: "pipe" })).toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("handles empty options string gracefully", () => {
    const dir = scratchUpstream([
      { name: "v-generate-password-hash", info: "Generate hash", options: "" },
    ]);
    const catalog = runGenerator(dir);
    const cmd = findCmd(catalog, "v-generate-password-hash");
    expect(cmd.args).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("produces deterministic output for the same input", () => {
    const dir = scratchUpstream([
      { name: "v-list-users", info: "List users", options: "[FORMAT]" },
      { name: "v-add-user", info: "Add user", options: "USER PASSWORD" },
      { name: "v-delete-user", info: "Delete user", options: "USER" },
    ]);
    const catalog1 = runGenerator(dir);
    const catalog2 = runGenerator(dir);
    expect(catalog1).toEqual(catalog2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sorts commands alphabetically", () => {
    const dir = scratchUpstream([
      { name: "v-list-zebra-tool", info: "Should be last", options: "" },
      { name: "v-list-alpha-tool", info: "Should be first", options: "" },
    ]);
    const catalog = runGenerator(dir, {}, ["--noApiPseudo"]);
    const names = catalog.commands.map((c: { command: string }) => c.command);
    expect(names).toEqual(["v-list-alpha-tool", "v-list-zebra-tool"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
