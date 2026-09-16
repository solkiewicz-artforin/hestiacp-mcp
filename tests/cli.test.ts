import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("packaged CLI", () => {
  it.skipIf(process.platform === "win32")(
    "runs through an npm-style symlink",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "hestiacp-mcp-"));
      const executable = join(directory, "hestiacp-mcp");
      try {
        symlinkSync(resolve("dist/cli.js"), executable);
        const result = spawnSync(executable, {
          encoding: "utf8",
          env: { PATH: process.env.PATH ?? "" },
          input: ""
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("Invalid HestiaCP configuration");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
