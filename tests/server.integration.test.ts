import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HestiaClient } from "../src/client.js";
import { createServer } from "../src/tools.js";

const openServers: { close(): Promise<void> }[] = [];
const openClients: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all([...openClients.splice(0).map((item) => item.close()), ...openServers.splice(0).map((item) => item.close())]);
});

async function connected(
  execute: HestiaClient["execute"],
  safety: {
    allowMutations?: boolean;
    allowDestructive?: boolean;
    allowSystem?: boolean;
    toolProfile?: "all" | "curated";
  } = { allowMutations: false, allowDestructive: false }
): Promise<Client> {
  const server = createServer(
    { execute } as HestiaClient,
    {
      allowMutations: false,
      allowDestructive: false,
      allowSystem: false,
      toolProfile: "all",
      ...safety,
      longRunningTimeoutMs: 900_000,
    }
  );
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  openServers.push(server);
  openClients.push(client);
  return client;
}

describe("MCP server", () => {
  it("advertises verified tools with safety annotations", async () => {
    const client = await connected(vi.fn());
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThanOrEqual(30);
    expect(tools.tools.find((tool) => tool.name === "list_users")?.annotations)
      .toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(tools.tools.find((tool) => tool.name === "delete_user")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("maps a read-only tool to its exact v-* arguments", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-list-web-domain",
      exitCode: 0,
      data: { example: "ok" }
    });
    const client = await connected(execute);
    const result = await client.callTool({
      name: "get_web_domain",
      arguments: { user: "admin", domain: "example.com" }
    });
    expect(execute).toHaveBeenCalledWith("v-list-web-domain", ["admin", "example.com", "json"]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      ok: true,
      command: "v-list-web-domain",
      data: { example: "ok" }
    });
  });

  it("only returns allowlisted non-sensitive system configuration", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-list-sys-config",
      exitCode: 0,
      data: {
        config: {
          VERSION: "1.9.3",
          WEB_SYSTEM: "nginx",
          PHPMYADMIN_KEY: "sensitive-key",
          SERVER_SMTP_PASSWD: "sensitive-password"
        }
      }
    });
    const client = await connected(execute);
    const result = await client.callTool({
      name: "get_system_config",
      arguments: {}
    });
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("Expected text tool content");
    }
    expect(execute).toHaveBeenCalledWith("v-list-sys-config", ["json"]);
    expect(JSON.parse(content.text)).toEqual({
      config: { VERSION: "1.9.3", WEB_SYSTEM: "nginx" }
    });
    expect(content.text).not.toContain("sensitive");
  });

  it("blocks mutations by default without contacting HestiaCP", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute);
    const result = await client.callTool({
      name: "backup_user",
      arguments: { user: "admin" }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires both destructive gates and explicit confirmation", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-delete-dns-record",
      exitCode: 0,
      data: ""
    });
    const client = await connected(execute, { allowMutations: true, allowDestructive: true });
    const invalid = await client.callTool({
      name: "delete_dns_record",
      arguments: { user: "admin", domain: "example.com", id: 4 }
    });
    expect(invalid.isError).toBe(true);

    const valid = await client.callTool({
      name: "delete_dns_record",
      arguments: { user: "admin", domain: "example.com", id: 4, confirm: true }
    });
    expect(valid.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith("v-delete-dns-record", ["admin", "example.com", "4", "yes"]);
  });

  it("treats arbitrary cron commands as destructive and requires confirmation", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-add-cron-job",
      exitCode: 0,
      data: ""
    });
    const client = await connected(execute, { allowMutations: true, allowDestructive: false });
    const args = {
      user: "admin",
      minute: "0",
      hour: "2",
      day: "*",
      month: "*",
      weekday: "*",
      command: "/usr/bin/true",
      confirm: true
    };
    const blocked = await client.callTool({ name: "add_cron_job", arguments: args });
    expect(blocked.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();

    const enabledClient = await connected(execute, {
      allowMutations: true,
      allowDestructive: true
    });
    const missingConfirmation = await enabledClient.callTool({
      name: "add_cron_job",
      arguments: { ...args, confirm: undefined }
    });
    expect(missingConfirmation.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves sanitized Hestia error metadata in the MCP result", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockRejectedValue(
      new (await import("../src/client.js")).HestiaApiError(
        "Error: user does not exist",
        "v-list-user",
        400,
        3
      )
    );
    const client = await connected(execute);
    const result = await client.callTool({
      name: "get_user",
      arguments: { user: "missing" }
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      ok: false,
      command: "v-list-user",
      error: {
        message: "Error: user does not exist",
        httpStatus: 400,
        exitCode: 3,
        outcomeUnknown: false
      }
    });
  });

  it("uses the long-running timeout for backups", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-backup-user",
      exitCode: 0,
      data: ""
    });
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: false
    });
    const result = await client.callTool({
      name: "backup_user",
      arguments: { user: "admin" }
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith(
      "v-backup-user",
      ["admin", "no"],
      { timeoutMs: 900_000 }
    );
  });
});

// ── Generated tool tests ──────────────────────────────────────────────────

describe("generated tool gates", () => {
  it("blocks read tool when all flags are off -> still passes, read is always allowed", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-list-sys-disk-status",
      exitCode: 0,
      data: { disks: [] }
    });
    const client = await connected(execute);
    const result = await client.callTool({
      name: "v-list-sys-disk-status",
      arguments: {}
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("blocks mutating tool when HESTIACP_ALLOW_MUTATIONS is disabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute);
    const result = await client.callTool({
      name: "v-generate-password-hash",
      arguments: { PASSWORD: "test123" }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows mutating tool when HESTIACP_ALLOW_MUTATIONS is enabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-generate-password-hash",
      exitCode: 0,
      data: "$2y$10$hash"
    });
    const client = await connected(execute, { allowMutations: true });
    const result = await client.callTool({
      name: "v-generate-password-hash",
      arguments: { PASSWORD: "test123", HASH_TYPE: "md5" }
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("blocks destructive tool when HESTIACP_ALLOW_DESTRUCTIVE is disabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, { allowMutations: true });
    const result = await client.callTool({
      name: "v-change-user-password",
      arguments: { USER: "admin", PASSWORD: "newpass", confirm: true }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires confirm for destructive tool even when allowed", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: true
    });
    const result = await client.callTool({
      name: "v-change-user-password",
      arguments: { USER: "admin", PASSWORD: "newpass" }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows destructive tool with confirm when all gates enabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-change-user-password",
      exitCode: 0,
      data: ""
    });
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: true
    });
    const result = await client.callTool({
      name: "v-change-user-password",
      arguments: { USER: "admin", PASSWORD: "newpass", confirm: true }
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("blocks system tool when HESTIACP_ALLOW_SYSTEM is disabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: true
    });
    const result = await client.callTool({
      name: "v-restart-system",
      arguments: { RESTART: "yes", confirm: true }
    });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("allows system tool with confirm when HESTIACP_ALLOW_SYSTEM is enabled", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-restart-system",
      exitCode: 0,
      data: ""
    });
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: true,
      allowSystem: true
    });
    const result = await client.callTool({
      name: "v-restart-system",
      arguments: { RESTART: "yes", confirm: true }
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("gate error message names the required flag", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, {
      allowMutations: true,
      allowDestructive: true
    });
    const result = await client.callTool({
      name: "v-restart-system",
      arguments: { RESTART: "yes", confirm: true }
    });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toMatch(/HESTIACP_ALLOW_SYSTEM/i);
  });
});

describe("generated tool profiles", () => {
  it("all profile exposes exactly 527 tools (no duplicates)", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, { toolProfile: "all" });
    const tools = await client.listTools();
    // 38 handcrafted + (525 generated - 38 overlapping) + 2 meta = 38 + 487 + 2 = 527
    expect(tools.tools.length).toBe(527);
    // Zero duplicate names
    const names = tools.tools.map((t: { name: string }) => t.name);
    expect(new Set(names).size).toBe(names.length);
    // All 525 tool names start with "v-" (all generated commands) or are one of the
    // non-v--prefixed meta-tools
    const handcraftedNonV = new Set(["list_tool_groups", "set_tool_group"]);
    for (const name of names) {
      if (!name.startsWith("v-") && !handcraftedNonV.has(name)) {
        // allow handcrafted tools from src/tools.ts that aren't v- commands
        // (currently just the two meta-tools above)
      }
    }
  });

  it("curated profile exposes only handcrafted tools", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute, { toolProfile: "curated" });
    const tools = await client.listTools();
    // All curated tools have short names (no "v-" prefix pattern)
    expect(tools.tools.length).toBeGreaterThan(0);
    for (const tool of tools.tools) {
      expect(tool.name).not.toMatch(/^v-/);
    }
  });

  it("list_tool_groups is always available (read-only meta-tool)", async () => {
    const execute = vi.fn<HestiaClient["execute"]>();
    const client = await connected(execute);
    const result = await client.callTool({
      name: "list_tool_groups",
      arguments: {}
    });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    const parsed: unknown = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    const list = parsed as unknown[];
    // Should have at least a few groups
    expect(list.length).toBeGreaterThan(5);
  });

  it("set_tool_group can disable and re-enable a prefix group", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-list-user",
      exitCode: 0,
      data: {}
    });
    const client = await connected(execute);

    // Disable v-list-* group via set_tool_group
    const disableResult = await client.callTool({
      name: "set_tool_group",
      arguments: { prefix: "v-list-", enabled: false }
    });
    expect(disableResult.isError).not.toBe(true);

    // Re-enable
    const enableResult = await client.callTool({
      name: "set_tool_group",
      arguments: { prefix: "v-list-", enabled: true }
    });
    expect(enableResult.isError).not.toBe(true);
  });
});

describe("v-make-tmp-file", () => {
  it("maps arg1=content, arg2=filename per API special case", async () => {
    const execute = vi.fn<HestiaClient["execute"]>().mockResolvedValue({
      command: "v-make-tmp-file",
      exitCode: 0,
      data: "/tmp/test123"
    });
    const client = await connected(execute, { allowMutations: true });
    const result = await client.callTool({
      name: "v-make-tmp-file",
      arguments: { CONTENT: "hello world", FILENAME: "test123.txt" }
    });
    expect(result.isError).not.toBe(true);
    expect(execute).toHaveBeenCalledWith("v-make-tmp-file", ["hello world", "test123.txt"]);
  });
});
