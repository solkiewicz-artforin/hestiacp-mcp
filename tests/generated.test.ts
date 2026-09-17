import { describe, expect, it } from "vitest";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { allCommands } from "../src/generated/commands.js";

// ── Static catalog integrity ──────────────────────────────────────────────

describe("generated command catalog", () => {
  // Bootstrapping: validate the shape of every entry
  for (const entry of allCommands) {
    it(`${entry.command}: valid entry shape`, () => {
      expect(entry.command).toMatch(/^v-[a-z0-9_-]+$/);
      expect(entry.name).toBe(entry.command);
      expect(entry.description).toBeTruthy();
      expect(Array.isArray(entry.args)).toBe(true);
      for (const arg of entry.args) {
        expect(arg).toHaveProperty("name");
        expect(arg).toHaveProperty("optional");
        expect(arg).toHaveProperty("kind");
        expect(["string", "confirm"]).toContain(arg.kind);
      }
      expect(["read", "mutating", "destructive", "system"]).toContain(entry.risk);
      expect(typeof entry.stdin).toBe("boolean");
      expect(typeof entry.fileArg).toBe("boolean");
    });
  }

  it("has no duplicate command names", () => {
    const names = allCommands.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has Snapshot risk-class counts matching commands.json", () => {
    const counts = { read: 0, mutating: 0, destructive: 0, system: 0 };
    for (const entry of allCommands) {
      counts[entry.risk] += 1;
    }
    // Snapshot — these are exported from the versioned commands.json.
    expect(counts).toStrictEqual({
      read: 119,
      mutating: 104,
      destructive: 225,
      system: 77
    });
    expect(counts.read + counts.mutating + counts.destructive + counts.system).toBe(
      allCommands.length
    );
  });

  it("has total matching 525 (524 scripts + 1 pseudo)", () => {
    expect(allCommands.length).toBe(525);
  });

  it("classifies v-list-sys-config as read (not system)", () => {
    const entry = allCommands.find((c) => c.command === "v-list-sys-config");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-list-sys-disk-status as read (not system)", () => {
    const entry = allCommands.find((c) => c.command === "v-list-sys-disk-status");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-list-sys-cpu-status as read (not system)", () => {
    const entry = allCommands.find((c) => c.command === "v-list-sys-cpu-status");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-list-sys-hestia-updates as read (not system)", () => {
    const entry = allCommands.find((c) => c.command === "v-list-sys-hestia-updates");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-get-sys-timezone as read (not system)", () => {
    const entry = allCommands.find((c) => c.command === "v-get-sys-timezone");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-restart-system as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-restart-system");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-update-sys-hestia as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-update-sys-hestia");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-update-sys-hestia-git as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-update-sys-hestia-git");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-rebuild-all as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-rebuild-all");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-run-cli-cmd as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-run-cli-cmd");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-quick-install-app as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-quick-install-app");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-import-directadmin as system (override)", () => {
    const entry = allCommands.find((c) => c.command === "v-import-directadmin");
    expect(entry?.risk).toBe("system");
  });

  it("classifies v-open-fs-file as read (can read secrets)", () => {
    const entry = allCommands.find((c) => c.command === "v-open-fs-file");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-open-fs-config as read (can read secrets)", () => {
    const entry = allCommands.find((c) => c.command === "v-open-fs-config");
    expect(entry?.risk).toBe("read");
  });

  it("classifies v-make-tmp-file as mutating", () => {
    const entry = allCommands.find((c) => c.command === "v-make-tmp-file");
    expect(entry?.risk).toBe("mutating");
  });

  // stdin / FILE markers
  it("marks v-delete-sys-mail-queue as stdin command", () => {
    const entry = allCommands.find((c) => c.command === "v-delete-sys-mail-queue");
    expect(entry?.stdin).toBe(true);
  });

  it("marks v-update-sys-hestia-git as stdin command", () => {
    const entry = allCommands.find((c) => c.command === "v-update-sys-hestia-git");
    expect(entry?.stdin).toBe(true);
  });

  it("has exactly 8 FILE commands", () => {
    const fileCmds = allCommands.filter((c) => c.fileArg);
    expect(fileCmds.length).toBe(8);
  });

  // No command exceeds 13 arguments
  for (const entry of allCommands) {
    it(`${entry.command}: args ≤ 13`, () => {
      expect(entry.args.length).toBeLessThanOrEqual(13);
    });
  }
});

// ── Determinism of codegen ─────────────────────────────────────────────────

describe("generator determinism", () => {
  it("re-running on the same upstream yields byte-identical commands.json", () => {
    const cwd = path.resolve(fileURLToPath(import.meta.url), "..", "..");
    const outFile = path.join(cwd, "src", "generated", "commands.json");

    // Run generator twice; output must be byte-identical
    const opts = { cwd, encoding: "utf-8", stdio: "pipe" } as const;

    execSync("node scripts/generate-commands.mjs --upstream /tmp/hestiacp-upstream", opts);
    const run1 = fs.readFileSync(outFile, "utf-8");

    execSync("node scripts/generate-commands.mjs --upstream /tmp/hestiacp-upstream", opts);
    const run2 = fs.readFileSync(outFile, "utf-8");

    expect(run1).toBe(run2);
  });
});