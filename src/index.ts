#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { safeError } from "./redact.js";
import { loadConfig } from "./config.js";
import { createServer } from "./tools.js";
import { HestiaClient } from "./client.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const client = new HestiaClient(config);
  const server = createServer(client, config);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const forcedExit = setTimeout(() => {
      console.error(`Forced shutdown after ${signal}`);
      process.exit(1);
    }, 10_000);
    forcedExit.unref();

    try {
      await server.close();
      await client.close();
      clearTimeout(forcedExit);
      process.exit(0);
    } catch (error) {
      clearTimeout(forcedExit);
      console.error(
        `Shutdown after ${signal} failed: ${safeError(error)}`
      );
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  console.error("hestiacp-mcp ready on stdio");
}

// Re-export for programmatic MCP integration
export { createServer } from "./tools.js";
export type { HestiaClient } from "./client.js";
export type { Config } from "./config.js";
