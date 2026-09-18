import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/generated/commands.js";
import {
  HESTIA_MAX_ARGS,
  validateTmpFilePath,
  capArgs,
  gateCheck,
  entryRiskClass,
} from "../src/tools.js";

// ── entryRiskClass ────────────────────────────────────────────────────────

describe("entryRiskClass", () => {
  it("returns the risk field from a command entry", () => {
    expect(entryRiskClass({ risk: "read" } as CommandEntry)).toBe("read");
    expect(entryRiskClass({ risk: "mutating" } as CommandEntry)).toBe("mutating");
    expect(entryRiskClass({ risk: "destructive" } as CommandEntry)).toBe("destructive");
    expect(entryRiskClass({ risk: "system" } as CommandEntry)).toBe("system");
  });
});

// ── validateTmpFilePath ──────────────────────────────────────────────────

describe("validateTmpFilePath", () => {
  it("accepts alphanumeric filenames", () => {
    expect(validateTmpFilePath("data.txt")).toBe("/tmp/data.txt");
  });

  it("accepts dotfiles", () => {
    expect(validateTmpFilePath(".htaccess")).toBe("/tmp/.htaccess");
    expect(validateTmpFilePath(".env")).toBe("/tmp/.env");
  });

  it("rejects solitary dot and double-dot", () => {
    expect(() => validateTmpFilePath(".")).toThrow(/filename cannot be '.' or '..'/);
    expect(() => validateTmpFilePath("..")).toThrow(/filename cannot be '.' or '..'/);
  });

  it("accepts filenames with underscores and hyphens", () => {
    expect(validateTmpFilePath("my_config-2.txt")).toBe("/tmp/my_config-2.txt");
  });

  it("rejects path traversal filenames", () => {
    expect(() => validateTmpFilePath("../../etc/passwd")).toThrow(/Invalid filename/);
  });

  it("throws on path traversal attempt targeting root", () => {
    expect(() => validateTmpFilePath("/etc/hosts")).toThrow(
      /Invalid filename/
    );
  });

  it("throws on names with forbidden chars (spaces, <, >)", () => {
    expect(() => validateTmpFilePath("bad name.txt")).toThrow(/Invalid filename/);
    expect(() => validateTmpFilePath("x<y.txt")).toThrow(/Invalid filename/);
  });

  it("throws on empty filename", () => {
    expect(() => validateTmpFilePath("")).toThrow(/Invalid filename/);
  });
});

// ── capArgs ───────────────────────────────────────────────────────────────

describe("capArgs", () => {
  it("trims trailing empty strings", () => {
    const result = capArgs(["a", "b", "", ""]);
    expect(result).toEqual(["a", "b"]);
    expect(result.length).toBe(2);
  });

  it("returns the same array when no trailing empties", () => {
    const input = ["a", "b", "c"];
    const result = capArgs(input);
    expect(result).toEqual(["a", "b", "c"]);
    // Should return a copy, not the same reference
    expect(result).not.toBe(input);
  });

  it("returns empty array when all elements are empty", () => {
    expect(capArgs(["", "", ""])).toEqual([]);
  });

  it("throws when result exceeds HESTIA_MAX_ARGS", () => {
    const tooMany = Array.from({ length: HESTIA_MAX_ARGS + 1 }, (_, i) => String(i));
    expect(() => capArgs(tooMany)).toThrow(/Too many arguments/);
  });

  it("accepts exactly HESTIA_MAX_ARGS arguments", () => {
    const args = Array.from({ length: HESTIA_MAX_ARGS }, (_, i) => String(i));
    expect(() => capArgs(args)).not.toThrow();
    expect(capArgs(args).length).toBe(HESTIA_MAX_ARGS);
  });
});

// ── gateCheck ─────────────────────────────────────────────────────────────

describe("gateCheck", () => {
  const fullCfg = {
    allowMutations: true,
    allowDestructive: true,
    allowSystem: true,
  };

  it("passes read-risk commands regardless of settings", () => {
    expect(gateCheck("read", { allowMutations: false, allowDestructive: false, allowSystem: false })).toBeNull();
  });

  it("blocks mutating when allowMutations is false", () => {
    const msg = gateCheck("mutating", { ...fullCfg, allowMutations: false });
    expect(msg).toBeTruthy();
    expect(msg).toContain("HESTIACP_ALLOW_MUTATIONS");
  });

  it("allows mutating when allowMutations is true", () => {
    expect(gateCheck("mutating", { ...fullCfg, allowMutations: true })).toBeNull();
  });

  it("blocks destructive when allowDestructive is false", () => {
    const msg = gateCheck("destructive", { ...fullCfg, allowDestructive: false });
    expect(msg).toBeTruthy();
    expect(msg).toContain("HESTIACP_ALLOW_DESTRUCTIVE");
  });

  it("allows destructive when allowDestructive is true", () => {
    expect(gateCheck("destructive", { ...fullCfg, allowDestructive: true })).toBeNull();
  });

  it("blocks system when allowSystem is false", () => {
    const msg = gateCheck("system", { ...fullCfg, allowSystem: false });
    expect(msg).toBeTruthy();
    expect(msg).toContain("HESTIACP_ALLOW_SYSTEM");
  });

  it("allows system when all gates are open", () => {
    expect(gateCheck("system", fullCfg)).toBeNull();
  });

  it("requires allowMutations for destructive and system", () => {
    const noMutations = { allowMutations: false, allowDestructive: true, allowSystem: true };
    expect(gateCheck("destructive", noMutations)).toContain("HESTIACP_ALLOW_MUTATIONS");
    expect(gateCheck("system", noMutations)).toContain("HESTIACP_ALLOW_MUTATIONS");
  });
});
