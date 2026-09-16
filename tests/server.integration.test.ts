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
  safety = { allowMutations: false, allowDestructive: false }
): Promise<Client> {
  const server = createServer(
    { execute } as HestiaClient,
    { ...safety, longRunningTimeoutMs: 900_000 }
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
