#!/usr/bin/env node
import { main } from "./index.js";
import { safeError } from "./redact.js";

main().catch((error: unknown) => {
  console.error(`Fatal: ${safeError(error)}`);
  process.exitCode = 1;
});
