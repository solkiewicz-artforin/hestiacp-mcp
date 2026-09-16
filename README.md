# HestiaCP MCP Server

A typed, security-first [Model Context Protocol](https://modelcontextprotocol.io/) server for the real HestiaCP `v-*` command API. It uses the current `@modelcontextprotocol/server` v2 stdio transport and exposes an explicit allowlist rather than an arbitrary command executor.

## Requirements

- Node.js 20.18.1 or newer
- HestiaCP with REST API access enabled
- A dedicated HestiaCP access key and secret key
- HTTPS connectivity to the panel, normally on port 8083

Create a least-privilege access key on the HestiaCP host. Prefer a custom API profile containing only the commands you intend to expose; do not use `*` permissions in production:

```bash
sudo /usr/local/hestia/bin/v-add-access-key USER PROFILE_NAME "MCP integration" json
```

See the [HestiaCP REST API documentation](https://hestiacp.com/docs/server-administration/rest-api) for API enablement, IP allowlisting, profiles, and exit codes.

## Installation

```bash
npm install
npm run build
```

Run the built CLI:

```bash
HESTIACP_URL=https://panel.example.com:8083/api/ \
HESTIACP_ACCESS_KEY=your-access-id \
HESTIACP_SECRET_KEY=your-secret \
node dist/cli.js
```

The server communicates only over stdin/stdout. Diagnostics go to stderr so they cannot corrupt MCP JSON-RPC messages.

## Configuration

| Variable | Required | Default | Description |
|---|---:|---|---|
| `HESTIACP_URL` | yes | — | Full HestiaCP API URL. `/api/` is added when the URL has no path. |
| `HESTIACP_ACCESS_KEY` | yes | — | Dedicated access-key ID. |
| `HESTIACP_SECRET_KEY` | yes | — | Access-key secret. |
| `HESTIACP_TIMEOUT_MS` | no | `30000` | Request timeout, 1–120 seconds. |
| `HESTIACP_LONG_RUNNING_TIMEOUT_MS` | no | `900000` | Timeout for backups and certificate issuance, 30 seconds–1 hour. |
| `HESTIACP_MAX_RESPONSE_BYTES` | no | `1000000` | Maximum accepted response size. |
| `HESTIACP_TLS_REJECT_UNAUTHORIZED` | no | `true` | TLS certificate and hostname verification. Disabling is for isolated development only. |
| `HESTIACP_ALLOW_MUTATIONS` | no | `false` | Enables additive and state-changing tools. |
| `HESTIACP_ALLOW_DESTRUCTIVE` | no | `false` | Enables destructive tools; mutations must also be enabled. |

For a private CA, keep verification enabled and launch Node with `NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem`. The API URL may not contain embedded credentials. Cross-origin and same-origin HTTP redirects are rejected to prevent credential forwarding.

### MCP client configuration

Use an absolute path and pass secrets through the client's environment facility. Example configuration used by Claude Desktop and other stdio MCP clients:

```json
{
  "mcpServers": {
    "hestiacp": {
      "command": "node",
      "args": ["/absolute/path/to/hestiacp-mcp/dist/cli.js"],
      "env": {
        "HESTIACP_URL": "https://panel.example.com:8083/api/",
        "HESTIACP_ACCESS_KEY": "ACCESS_KEY_ID",
        "HESTIACP_SECRET_KEY": "SECRET_KEY"
      }
    }
  }
}
```

For a globally installed package, use `"command": "hestiacp-mcp"` and omit `args`.

## Tools

All tools map to commands present in the HestiaCP upstream `bin/` directory. Schemas preserve the exact positional order expected by `/api/`, including empty placeholders for later optional arguments.

**Read-only (enabled by default):**

- Users: `list_users`, `get_user`
- Web: `list_web_domains`, `get_web_domain`
- DNS: `list_dns_domains`, `get_dns_domain`, `list_dns_records`
- Mail: `list_mail_domains`, `get_mail_domain`, `list_mail_accounts`
- Databases and cron: `list_databases`, `get_database`, `list_cron_jobs`
- Backups and system: `list_user_backups`, `get_system_info`, `get_system_config`, `list_system_services`, `list_system_ips`. `get_system_config` forces JSON and returns only an explicit allowlist of non-sensitive fields; passwords, keys, SMTP credentials, and unknown future fields are excluded.

**Mutating (requires `HESTIACP_ALLOW_MUTATIONS=true`):**

- `add_user`, `add_web_domain`, `issue_web_certificate`
- `add_dns_domain`, `add_dns_record`
- `add_mail_domain`, `add_mail_account`
- `add_database`, `backup_user`, `unsuspend_user`

**Destructive/disruptive (requires both safety flags and `confirm: true`):**

- `suspend_user`, `add_cron_job` (cron commands are arbitrary shell execution)
- `delete_user`, `delete_web_domain`, `delete_dns_domain`, `delete_dns_record`
- `delete_mail_domain`, `delete_mail_account`, `delete_database`, `delete_cron_job`

Each MCP definition includes `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`. These annotations are advisory; the environment gates and HestiaCP access-key profile are the enforcement layers.

Example tool input:

```json
{
  "name": "add_dns_record",
  "arguments": {
    "user": "alice",
    "domain": "example.com",
    "record": "www",
    "type": "A",
    "value": "192.0.2.10",
    "ttl": 3600
  }
}
```

Destructive example:

```json
{
  "name": "delete_dns_record",
  "arguments": {
    "user": "alice",
    "domain": "example.com",
    "id": 12,
    "confirm": true
  }
}
```

## Docker

Build the image:

```bash
docker build -t hestiacp-mcp .
```

Stdio must remain attached, so run with `-i`. Prefer Docker secrets or an environment file with restrictive filesystem permissions:

```bash
docker run --rm -i --env-file /secure/path/hestiacp-mcp.env hestiacp-mcp
```

Mount a private CA read-only and set `NODE_EXTRA_CA_CERTS` when required.

## Security notes

- Use a dedicated non-admin access key, a restrictive HestiaCP API profile, server-side IP allowlisting, and firewall restrictions on port 8083.
- Keep TLS verification enabled. The permissive TLS settings in historical HestiaCP examples are not suitable for production.
- Mutation and deletion are off by default. Destructive tools also require a literal confirmation argument.
- Commands are allowlisted and validated; there is no generic `cmd` tool.
- Requests have bounded duration and response size, never retry mutations automatically, and reject redirects.
- Backups and certificate issuance use the separate long-running timeout. A timeout is reported as an unknown remote outcome; inspect HestiaCP state before retrying.
- Tool results include structured `ok`, `command`, `data` or sanitized error metadata (`httpStatus`, Hestia `exitCode`, `outcomeUnknown`) in addition to text for client compatibility.
- Access keys and password-named data are never intentionally logged. Avoid placing secrets directly in shell history or committed MCP configuration.
- HestiaCP command signatures are shell-script interfaces and can change between releases. Test upgrades against a staging panel before production rollout.

## Development

```bash
npm run lint
npm run typecheck
npm test
npm run build
# or all checks:
npm run validate
```

Tests use mocked HTTP responses and linked in-memory MCP transports; they do not contact a real HestiaCP server.

## Upstream references

- [HestiaCP REST API documentation](https://hestiacp.com/docs/server-administration/rest-api)
- [Official API examples](https://github.com/hestiacp/hestiacp-api-examples)
- [HestiaCP API endpoint implementation](https://github.com/hestiacp/hestiacp/blob/main/web/api/index.php)
- [HestiaCP command implementations](https://github.com/hestiacp/hestiacp/tree/main/bin)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

## Limitations

- Only the documented, verified subset above is exposed; HestiaCP has hundreds of additional `v-*` commands.
- The test suite mocks HestiaCP. Operators should run smoke tests against their exact supported HestiaCP version.
- Stdio is the only transport. Authentication and network exposure remain between this local process and HestiaCP; the MCP server itself does not listen on a network socket.
