# CLI reference

The `superbar` executable fetches provider usage into a local runtime snapshot or prints the current snapshot as JSON. The GNOME extension invokes the same executable for provider refreshes.

## Commands

```sh
superbar fetch --format json
superbar fetch --provider codex --format json
superbar fetch --provider claude --format json
superbar status --format json
superbar status --line
superbar status --line --show used
superbar doctor
superbar doctor --format json
```

`fetch` refreshes both providers. `--provider codex` and `--provider claude` refresh only the selected provider and preserve the other provider's saved data. Fetch prints the resulting snapshot as JSON and writes it to the runtime store. `status` prints the saved snapshot without contacting providers; it fails if no valid snapshot is available.

`status --line` prints one plain-text line for status bars. By default it shows remaining usage, matching the extension, for example `cx 58% left 5h · cl 29% left 5h`. `--show used` prints used usage instead, for example `cx 42% 5h · cl 71% 5h`. `--show` applies only with `--line`; any other value is rejected. Each provider shows its tightest usable window (the lowest remaining, which is the highest used), followed by that window's length (`5h`, `7d`). A provider without a usable value shows `—`. Note that this differs from the extension pill, which shows only the 5-hour (primary) window and marks a weekly-driven red with `wk!`. The line is unchanged and still picks the tightest window. The snapshot itself always stores used percentages; the display mode is applied only when printing.

`superbar fetch` exits with status 75 when another refresh already holds the runtime lock. The extension reports this as `Refresh busy`. Any other failure exits non-zero.

`superbar status` reads the credential files locally to refresh each provider's `expires_at` (no network, and no token is printed). It is still a read of the saved snapshot otherwise.

`superbar doctor` checks, without contacting any provider and without creating or changing anything: that `XDG_RUNTIME_DIR` is absolute, owned by you and private, and whether the `superbar` directory exists yet (a missing one is reported as normal, since `fetch` creates it), and that each credential file exists, parses, contains an access token, and when it records one, when that token expires. Text output shows one line per check, prefixed with `[ok]`, `[warn]`, or `[fail]`. `--format json` prints `{"checks": [{"name", "status", "detail"}]}`. Doctor exits 1 when a check fails; a missing credential file or an expired token is a warning. It never prints token values, and it does not refresh or change anything.

The snapshot uses schema version 1 and contains provider states (`fresh`, `stale`, or `unavailable`), last-success timestamps, usage windows, and safe error metadata. A failed refresh carries forward previous usage as stale data when available. The extension validates the snapshot before displaying it.

Snapshot fields added after version 1 are optional and additive:

- `expires_at` on each provider: the access token's expiry as a UTC ISO 8601 timestamp, read from the credential file (Claude `expiresAt`, or the `exp` claim of the Codex token) when the snapshot is written. It is `null` when the file records none. The token itself is never stored in the snapshot. Because a CLI renews its token on its own, this saved value can be older than the file; `superbar status` therefore replaces it with the live expiry from the credential file whenever that file yields one, and keeps the saved value only when the file is missing or has none. The `status` output is never older than the file.
- `duration_seconds` on Claude windows: `18000` for `five_hour` and `604800` for `seven_day`, the lengths those windows are named for.

Compatibility: this CLI ignores snapshot fields it does not know, so later additive fields are safe to read. CLI builds from before this change parse snapshots strictly; they fail on `expires_at` (and `status` then reports no snapshot, and a refresh drops carried-forward data). Install the CLI and extension together.

## Credentials and network access

The CLI reads existing local CLI credentials; it does not provide a login flow or write credential files. Codex credentials are read from `$CODEX_HOME/auth.json` when `CODEX_HOME` is set, otherwise `~/.codex/auth.json`. Claude Code credentials are read from `~/.claude/.credentials.json`. The CLI uses the access tokens in those files to make authenticated requests to OpenAI and Anthropic usage endpoints. It does not refresh expired tokens and never writes credential files; renew a session through the corresponding CLI's authentication flow. Token expiry is read from the credential file for display only; the token value is never printed or saved.

The provider endpoints are upstream integrations and are not guaranteed stable public APIs. Provider behavior and returned data may change. The fetch worker has a 35-second overall deadline for its provider requests and local work.

## Snapshot and privacy

The snapshot and lock file live under `$XDG_RUNTIME_DIR/superbar/`. `XDG_RUNTIME_DIR` must be an absolute, private directory owned by the current user; Superbar creates and verifies the `superbar` subdirectory and restricts snapshot files to the current user. Reads and writes are bounded and coordinated with a lock.

The snapshot contains usage data and timestamps. Do not share credentials, raw provider responses, snapshots, or diagnostic output without checking for personal information first.
