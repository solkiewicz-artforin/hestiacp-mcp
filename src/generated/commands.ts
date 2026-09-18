/**
 * Auto-generated typed wrapper for the command catalog.
 * Runtime reads from the JSON file, no network access.
 *
 * Regenerate: npm run generate:commands -- --upstream /path/to/hestia
 */

import catalog from "./commands.json" with { type: "json" };

/** A single argument for a command */
export type CommandArg = {
  name: string;
  optional: boolean;
  kind: string;
}

/** Risk classification for a command */
export type RiskClass = "read" | "mutating" | "destructive" | "system";

/** A single command entry from the generated catalog */
export type CommandEntry = {
  name: string;
  command: string;
  description: string;
  args: CommandArg[];
  risk: RiskClass;
  notes: string;
  usage_example: string;
  stdin: boolean;
  fileArg: boolean;
  /** Optional map from parameter names to positional argument indices (0-based).
   *  Used when HestiaCP positional binding differs from the catalog arg order. */
  argMap?: Record<string, number>;
}

/** The full catalog structure (deterministic — no timestamps or paths) */
export type CommandCatalog = {
  total: number;
  handcrafted_count: number;
  auto_register_count: number;
  risk_counts: Record<RiskClass, number>;
  commands: CommandEntry[];
}

// Cast through unknown — the JSON is validated at codegen time
const typed = catalog as unknown as CommandCatalog;

export const commandCatalog: Readonly<CommandCatalog> = typed;
export const allCommands: readonly Readonly<CommandEntry>[] = typed.commands;
export default commandCatalog;