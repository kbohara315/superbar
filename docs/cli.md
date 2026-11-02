# CLI reference

The `superbar` executable fetches provider usage into a local runtime snapshot or prints the current snapshot as JSON. The GNOME extension invokes the same executable for provider refreshes.

## Commands

```sh
superbar fetch --format json
superbar fetch --provider codex --format json
superbar fetch --provider claude --format json
superbar status --format json
```

`fetch` refreshes both providers. `--provider codex` and `--provider claude` refresh only the selected provider and preserve the other provider's saved data. Fetch prints the resulting snapshot as JSON and writes it to the runtime store. `status` prints the saved snapshot without contacting providers; it fails if no valid snapshot is available.

The snapshot uses schema version 1 and contains provider states (`fresh`, `stale`, or `unavailable`), last-success timestamps, usage windows, and safe error metadata. A failed refresh carries forward previous usage as stale data when available. The extension validates the snapshot before displaying it.

## Credentials and network access

The CLI reads existing local CLI credentials; it does not provide a login flow or write credential files. Codex credentials are read from `$CODEX_HOME/auth.json` when `CODEX_HOME` is set, otherwise `~/.codex/auth.json`. Claude Code credentials are read from `~/.claude/.credentials.json`. The CLI uses the access tokens in those files to make authenticated requests to OpenAI and Anthropic usage endpoints. It does not independently refresh expired tokens; renew a session through the corresponding CLI's authentication flow.

The provider endpoints are upstream integrations and are not guaranteed stable public APIs. Provider behavior and returned data may change. The fetch worker has a 35-second overall deadline for its provider requests and local work.

## Snapshot and privacy

The snapshot and lock file live under `$XDG_RUNTIME_DIR/superbar/`. `XDG_RUNTIME_DIR` must be an absolute, private directory owned by the current user; Superbar creates and verifies the `superbar` subdirectory and restricts snapshot files to the current user. Reads and writes are bounded and coordinated with a lock.

The snapshot contains usage data and timestamps. Do not share credentials, raw provider responses, snapshots, or diagnostic output without checking for personal information first.
