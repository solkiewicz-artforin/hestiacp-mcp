# Changelog

## [Unreleased]

### Added
- `--force` flag on `scripts/generate-commands.mjs` to allow risk downgrades (warning emitted when used).
- Audit signals (`console.warn`) in `sanitizeDescription` when code fences, `javascript:` URIs, or double-brace patterns are found and modified.
- Shared `src/generated/constants.json` configuration file for `MAX_ARGS` (used by both generator and runtime).
- `validateTmpFileArgs()` helper that validates safe temp-file names — now allows dot-files (`.htaccess`, `.env`).
- `capArgs()` shared helper in `src/tools.ts` for trailing-trim + MAX_ARGS validation.
- Startup schema validation in `createServer()` that logs warnings for any broken tool schemas.
- `__generatedSchema()` exported for test use.
- `redact()` now applied to `structuredContent` in all error responses (handcrafted and generated tool handlers).
- Smoke test in `tests/generated.test.ts`: `safeParse({})` assertions for all command entry schemas.
- CHANGELOG.md (this file).

### Changed
- **BREAKING**: `src/generated/handcrafted-commands.json` moved to `src/commands/handcrafted-commands.json`.
- Test in `tests/generated.test.ts` now compares `HANDCRAFTED_COMMANDS` against the actual JSON file import, not a self-referential computation.
- `sanitizeDescription` now handles CRLF line endings (`/(\r?\n){3,}/g`).
- `sanitizeDescription` inline comments consolidated into a single clear doc-comment block.
- `validateTmpFileArgs` error messages now truncate filenames (uses `JSON.stringify` + 100-char limit).
- All `JSON.parse` calls in `scripts/generate-commands.mjs` now log the raw error object for debuggability.

### Fixed
- Tautological test in `tests/generated.test.ts` — `HANDCRAFTED_COMMANDS` comparison now validates against JSON file.
- Validate-tmp-file regex now permits leading dots (`.htaccess`, `.env` filenames).

### Removed
- `resolveJsonModule: true` from `tsconfig.json` (unnecessary with `with { type: "json" }` import assertions).
- `argMap` from `CommandEntry` type (previously reverted; confirmed clean).