import { describe, expect, it } from "vitest";
import type { CommandEntry } from "../src/generated/commands.js";
import {
  HESTIA_MAX_ARGS,
  validateTmpFileArgs,
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

// ── validateTmpFileArgs ──────────────────────────────────────────────────

describe("validateTmpFileArgs", () => {
  it("accepts alphanumeric filenames", () => {
    expect(validateTmpFileArgs("data.txt")).toBe("/tmp/data.txt");
  });

  it("accepts dotfiles", () => {
    expect(validateTmpFileArgs(".htaccess")).toBe("/tmp/.htaccess");
    expect(validateTmpFileArgs(".env")).toBe("/tmp/.env");
  });

  it("accepts filenames with underscores and hyphens", () => {
    expect(validateTmpFileArgs("my_config-2.txt")).toBe("/tmp/my_config-2.txt");
  });

  it("rejects path traversal filenames", () => {
    expect(() => validateTmpFileArgs("../../etc/passwd")).toThrow(/Invalid filename/);
  });

  it("throws on path traversal attempt targeting root", () => {
    expect(() => validateTmpFileArgs("/etc/hosts")).toThrow(
      /Invalid filename/
    );
  });

  it("throws on names with forbidden chars (spaces, <, >)", () => {
    expect(() => validateTmpFileArgs("bad name.txt")).toThrow(/Invalid filename/);
    expect(() => validateTmpFileArgs("x<y.txt")).toThrow(/Invalid filename/);
  });

  it("throws on empty filename", () => {
    expect(() => validateTmpFileArgs("")).toThrow(/Invalid filename/);
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