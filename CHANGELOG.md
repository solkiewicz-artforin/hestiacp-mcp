# Changelog

## [Unreleased]

## [2.0.0] - 2025-01-01

### Changed
- `v-unsuspend-*` commands are now classified `mutating` (they restore access, not destroy data).
- `safeError(null | undefined)` returns `""`; strings are scrubbed and objects JSON-stringified (M1).
- Error `structuredContent` and text are passed through `redact()` (M3, H6).
- `HESTIACP_ALLOW_MANAGEMENT` falls back to `HESTIACP_ALLOW_MUTATIONS` only when unset (`??`, H4).
- `CommandEntry.argMap` removed (H10); regenerate catalogs and migrate custom code that read it.
- `_generatedSchema` is canonical; `generatedSchema` kept as a deprecated alias (H9).
- Generator: `--risk-overrides` flag (alias `--riskOverrides`), JSON audit lines, shared `resolveRisk` helper.
- Startup emits `[astartup]` with effective profile and gates.
- MAX_ARGS lives in `src/constants.ts` (`HESTIA_MAX_ARGS`); tmp-file size check uses UTF-8 byte length.

### Added
- `--force` flag on `scripts/generate-commands.mjs` to allow risk downgrades (warning emitted when used).
- Audit signals (`console.warn`) in `sanitizeDescription` when code fences, `javascript:` URIs, or double-brace patterns are found and modified.
- Shared `src/generated/constants.json` configuration file for `MAX_ARGS` (used by both generator and runtime).
- `validateTmpFileArgs()` helper that validates safe temp-file names — now allows dot-files (`.htaccess`, `.env`).
- `capArgs()` shared helper in `src/tools.ts` for trailing-trim + MAX_ARGS validation.
- Startup schema validation in `createServer()` that logs warnings for any broken tool schemas.
- `_generatedSchema()` exported for test use.
- `redact()` now applied to `structuredContent` in all error responses (handcrafted and generated tool handlers).
- Smoke test in `tests/generated.test.ts`: `safeParse({})` assertions for all command entry schemas.
- CHANGELOG.md (this file).

### Changed
- **BREAKING**: `src/generated/handcrafted-commands.json` moved to `src/commands/handcrafted-commands.json`.
  **Migration**: if your codebase imports or references `src/generated/handcrafted-commands.json`
  directly, update the path to `src/commands/handcrafted-commands.json`.  The file format is
  unchanged — only the location differs.  Downstream tools (including `scripts/generate-commands.mjs`)
  automatically pick up the new location, so no additional configuration is required.
- Test in `tests/generated.test.ts` now compares `HANDCRAFTED_COMMANDS` against the actual JSON file import, not a self-referential computation.
- `sanitizeDescription` now handles CRLF line endings (`/(\r?\n){3,}/g`).
- `sanitizeDescription` inline comments consolidated into a single clear doc-comment block.
- `validateTmpFileArgs` error messages now truncate filenames (uses `JSON.stringify` + 100-char limit).
- All `JSON.parse` calls in `scripts/generate-commands.mjs` now log the raw error object for debuggability.

### Fixed
- Tautological test in `tests/generated.test.ts` — `HANDCRAFTED_COMMANDS` comparison now validates against JSON file.
- Validate-tmp-file regex now permits leading dots (`.htaccess`, `.env` filenames).
- `safeError(null)` and `safeError(undefined)` now return `"Unknown error"` instead of `""` — prevents empty error messages in telemetry and logs.

### Removed
- `resolveJsonModule: true` from `tsconfig.json` (unnecessary with `with { type: "json" }` import assertions).
- `argMap` from `CommandEntry` type (previously reverted; confirmed clean).