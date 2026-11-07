// Provider layer of Superbar on nsh. Port of the Zig CLI's fetch, parse, carry-forward, expiry and doctor logic
// (../../src/main.zig and ../../src/store.zig). It reads the local CLI credentials, asks the Codex and Claude usage
// endpoints for the current windows, and keeps its snapshots as versioned files in ${dataDir}
// (snapshot.<provider>.<writtenAtMs>-<tag>.json; see the Snapshot store section).
//
// Secrets: a token value is only ever placed in a request header. It is never returned, stored, logged, or put in an
// error message. Only the access-token expiry leaves the credential file.
//
// Deadline: every refresh, read, save and request runs inside one watchdog (withRun). When the deadline passes the
// run is abandoned: its promise rejects with a timeout, and no later step of it can touch the disk or the network.
// An operation already in flight at the deadline may still finish, but nothing starts after it.
//
// Concurrency: correctness does not depend on the lock. Every save commits a new, uniquely named version of one
// provider's snapshot, and a committed file is never replaced, so no save can overwrite another's data. A reader
// chooses the newest success among the valid versions. The lock (${dataDir}/refresh.lock) is a best-effort guard against
// duplicate provider requests; overlap is possible and, in theory, not bounded under crashed-owner and clock-step
// races. Overlap can only cost duplicate provider requests. See the Lock section.
//
// Privacy: on POSIX hosts the data directory must be 0700 and each version 0600, both verified: before a save, and on
// every read (a snapshot under a directory that is not private is not trusted). Ownership is not checked, because
// nsh's stat exposes no uid. If modes cannot be verified, nothing is saved and the result carries storage_insecure.
// On Windows, per-user ACLs apply and the modes are not checked.
//
// Entries: every candidate is examined with lstat. Only a regular file is read, so a directory, a symbolic link, a
// FIFO or another special entry named like a version is skipped, never followed and never read. Each candidate is
// handled on its own, so one unreadable or malformed entry never aborts a load or a refresh. Cleanup removes only
// regular files whose basename matches the exact pattern, using the basename as listed. A symbolic link at such a name
// is left alone: it is never followed and never removed.

import * as fs from "fs/promises";
import os from "os";
import process from "process";
import { randomUUID } from "crypto";
import type { DoctorCheck, ProviderError, ProviderName, ProviderSnapshot, ProviderState, Snapshot, UsageWindow } from "./types";
import { credentialExpiryIso } from "./model";

export const MAX_CREDENTIAL_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_BYTES = 256 * 1024;
// Overall budget for one refresh, from the start of the lock to the save, as the Zig fetch worker's deadline.
export const FETCH_DEADLINE_MS = 35_000;
// A lock older than the deadline plus this margin cannot belong to a live run, so it is broken. The margin is large
// so that a wall-clock step forward of less than two minutes cannot make a live lock look stale.
export const LOCK_STALE_MS = FETCH_DEADLINE_MS + 120_000;
// How long a release or cleanup may take. Past this the lock is left for the stale rule.
export const RELEASE_GRACE_MS = 5_000;
/** The earlier single-file snapshot name. Read only as the carry-forward source for migration; never written. */
export const SNAPSHOT_NAME = "snapshot.json";
export const LOCK_NAME = "refresh.lock";
const OWNER_NAME = "owner.json";

const PROVIDERS: readonly ProviderName[] = ["codex", "claude"];
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_BETA = "oauth-2025-04-20";
const USER_AGENT = "superbar/1.0";
const MAX_WINDOW_SECONDS = 31536000;
const MAX_EPOCH_SECONDS = 253402300799; // 9999-12-31T23:59:59Z, as the Zig epoch conversion bounds it
const CODEX_HOME_MESSAGE = "CODEX_HOME must point inside ~/.codex, the only Codex directory the app sandbox can read";
const STORAGE_INSECURE: ProviderError = {
  code: "storage_insecure",
  message: "The snapshot could not be stored with private permissions, so it was not saved",
};

export type Selection = "all" | ProviderName;
/**
 * What a refresh resolved to. `storage` is present only when the snapshot was kept in memory and not saved, because
 * its private permissions could not be enforced and verified. Its absence means the snapshot was saved.
 */
export type RefreshOutcome =
  | { status: "ok"; snapshot: Snapshot; storage?: { persisted: false; error: ProviderError } }
  | { status: "busy" };

export interface Windows {
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
}

export class SuperbarError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SuperbarError";
  }
}

function timeoutError(): SuperbarError {
  return new SuperbarError("timeout", "The refresh did not finish before its deadline");
}

function codeOf(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Injectable dependencies. Production code uses nsh's fs/promises, fetch and process; tests substitute fakes.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What an entry is. `stat` has lstat semantics: a symbolic link is reported as "symlink" and is never followed, and
 * "other" covers devices, FIFOs and sockets.
 */
export interface FileStat {
  kind: "file" | "dir" | "symlink" | "other";
  isDirectory: boolean;
  /** Permission bits and type, as lstat reports them. */
  mode: number;
  mtimeMs: number;
}

export interface FileSystem {
  /** Reads UTF-8 text. Rejects with code `ENOENT` when missing and `EFBIG` when larger than `maxBytes`. */
  readText(path: string, maxBytes: number): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Creates a directory and any missing parents. */
  mkdir(path: string): Promise<void>;
  /** Creates one directory. Resolves `false` when it already exists, so a lock taken by mkdir is exclusive. */
  mkdirExclusive(path: string): Promise<boolean>;
  /** Names directly inside a directory. */
  list(dir: string): Promise<string[]>;
  unlink(path: string): Promise<void>;
  /** Removes one empty directory. */
  rmdir(path: string): Promise<void>;
  /** `null` when the entry does not exist. */
  stat(path: string): Promise<FileStat | null>;
}

/** Runs a command without a shell. Resolves with its exit code; rejects when it cannot run. */
export type ProcessRunner = (command: string, args: string[]) => Promise<{ code?: number | null }>;

export interface Deps {
  fs: FileSystem;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** Environment variables nsh exposes (only granted names are present). */
  env: Record<string, string | undefined>;
  /** The user's home directory, the root of `~/.codex` and `~/.claude`. */
  homeDir: string | undefined;
  /** `process.dataDir`: where the snapshot and the lock live. `null` when the host has none. */
  dataDir: string | null;
  now: () => Date;
  deadlineMs: number;
  run: ProcessRunner;
  /** `process.platform`. Anything but `windows` is POSIX, where modes are enforced. */
  platform: string;
}

const realFs: FileSystem = {
  async readText(path, maxBytes) {
    const info = await fs.stat(path);
    if (info.size > maxBytes) throw Object.assign(new Error("file is too large"), { code: "EFBIG" });
    const text = await fs.readFile(path, "utf8");
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw Object.assign(new Error("file is too large"), { code: "EFBIG" });
    }
    return text;
  },
  writeText: (path, text) => fs.writeFile(path, text),
  rename: (from, to) => fs.rename(from, to),
  mkdir: (path) => fs.mkdir(path, { recursive: true }),
  async mkdirExclusive(path) {
    try {
      await fs.mkdir(path);
      return true;
    } catch (err) {
      if (codeOf(err) === "EEXIST") return false;
      throw err;
    }
  },
  list: (dir) => fs.readdir(dir),
  unlink: (path) => fs.unlink(path),
  rmdir: (path) => fs.rmdir(path),
  async stat(path) {
    try {
      // lstat: a symbolic link is described, never followed.
      const info = await fs.lstat(path);
      const kind = info.isSymbolicLink() ? "symlink" : info.isFile() ? "file" : info.isDirectory() ? "dir" : "other";
      return { kind, isDirectory: info.isDirectory(), mode: info.mode, mtimeMs: info.mtimeMs };
    } catch (err) {
      if (codeOf(err) === "ENOENT") return null;
      throw err;
    }
  },
};

export function defaultDeps(): Deps {
  const env = { ...process.env };
  return {
    fs: realFs,
    fetch: (url, init) => fetch(url, init),
    env,
    homeDir: env.HOME ? env.HOME : homeFromOs(),
    dataDir: process.dataDir ?? null,
    now: () => new Date(),
    deadlineMs: FETCH_DEADLINE_MS,
    run: (command, args) => process.run(command, args),
    platform: process.platform,
  };
}

function homeFromOs(): string | undefined {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

function resolveDeps(overrides?: Partial<Deps>): Deps {
  return { ...defaultDeps(), ...overrides };
}

function isPosix(deps: Pick<Deps, "platform">): boolean {
  return deps.platform !== "windows";
}

/** Whether a stat result has the expected permission bits. Always true where modes are not enforced (Windows). */
function modeIs(info: FileStat, expected: number, deps: Pick<Deps, "platform">): boolean {
  return !isPosix(deps) || (info.mode & 0o777) === expected;
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

// ---------------------------------------------------------------------------------------------------------------------
// Watchdog: one deadline for the whole operation.
// ---------------------------------------------------------------------------------------------------------------------

export interface Run {
  /** Aborted at the deadline. Passed to fetch, so a request is cut off as well. */
  readonly signal: AbortSignal;
  /** True once the deadline has passed. A run never becomes un-abandoned. */
  readonly abandoned: boolean;
  /** Runs one side effect or read, unless the run is abandoned; then it rejects without calling `op`. */
  call<T>(op: () => Promise<T>): Promise<T>;
  /** Throws a timeout when the run is abandoned. */
  check(): void;
}

/**
 * Runs `body` under a deadline. The result is body's, or a timeout error when the deadline passes first. At the
 * deadline the run is marked abandoned, which stops every later `call` before it starts.
 */
async function withRun<T>(deps: Deps, body: (run: Run) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const state = { abandoned: false };
  const startedAt = Date.now();
  // The timer abandons the run at the deadline. Every step also compares elapsed time with the deadline, so a run that
  // was frozen (and so resumed after its timer was due) refuses its next step before the timer has had its turn.
  const abandon = () => {
    state.abandoned = true;
    controller.abort();
  };
  const expired = () => state.abandoned || Date.now() - startedAt >= deps.deadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      abandon();
      reject(timeoutError());
    }, deps.deadlineMs);
  });
  deadline.catch(() => undefined); // a deadline that nobody awaits must not be an unhandled rejection
  const run: Run = {
    signal: controller.signal,
    get abandoned() {
      if (expired()) abandon();
      return state.abandoned;
    },
    async call<R>(op: () => Promise<R>): Promise<R> {
      if (run.abandoned) throw timeoutError();
      return await Promise.race([op(), deadline]);
    },
    check() {
      if (run.abandoned) throw timeoutError();
    },
  };
  try {
    return await Promise.race([body(run), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A failure of a call that belongs to an abandoned run, or a timeout, which the run reports as its own timeout. */
function isDeadlineFailure(err: unknown, run: Run): boolean {
  return run.abandoned || codeOf(err) === "timeout";
}

/** Runs `op` for at most `ms` and never throws. Used for release and cleanup, which must not hang the refresh. */
async function bounded(op: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([op().catch(() => undefined), limit]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON helpers. Responses and credentials are untrusted, so every field is type-checked before use.
// ---------------------------------------------------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objectField(v: unknown, name: string): unknown {
  return isObject(v) ? v[name] : undefined;
}

/** A finite JSON number field, or null. */
function numberField(v: unknown, name: string): number | null {
  const x = objectField(v, name);
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** A non-empty string field, or null, as the Zig `fieldString` returns. */
function stringField(v: unknown, name: string): string | null {
  const x = objectField(v, name);
  return typeof x === "string" && x !== "" ? x : null;
}

/** Epoch seconds as `YYYY-MM-DDTHH:MM:SSZ` (UTC, whole seconds), or null outside the supported range. */
export function epochIso(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_EPOCH_SECONDS) return null;
  return new Date(Math.floor(seconds) * 1000).toISOString().slice(0, 19) + "Z";
}

// ---------------------------------------------------------------------------------------------------------------------
// Parsers: provider response bodies to usage windows.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * One usage window. `utilization` (or `used_percent`) is the used percentage and must be 0..100, else the window is
 * rejected. The reset is `resets_at` (or `reset_at`): a string is kept as given, a number is epoch seconds.
 * `limit_window_seconds` gives the duration when it is a whole number of seconds up to one year; otherwise the
 * fallback duration applies.
 */
export function parseWindow(v: unknown, label: string, fallbackDuration: number | null): UsageWindow | null {
  const percent = numberField(v, "utilization") ?? numberField(v, "used_percent");
  if (percent === null || percent < 0 || percent > 100) return null;
  // A present resets_at wins even when it is null, as the Zig `field` lookup does.
  const resetValue = isObject(v) && Object.hasOwn(v, "resets_at") ? v.resets_at : objectField(v, "reset_at");
  const resetAt = typeof resetValue === "string" ? resetValue : typeof resetValue === "number" ? epochIso(resetValue) : null;
  const limit = numberField(v, "limit_window_seconds");
  const duration =
    limit !== null && limit >= 0 && limit <= MAX_WINDOW_SECONDS && Number.isInteger(limit) ? limit : fallbackDuration;
  return { label, used_percent: percent, reset_at: resetAt, duration_seconds: duration };
}

/** Codex usage: `rate_limit.primary_window` and `rate_limit.secondary_window`. Throws when the body is not usable JSON. */
export function parseCodex(body: string): Windows {
  const root: unknown = JSON.parse(body);
  if (!isObject(root) || !("rate_limit" in root)) throw new Error("rate_limit missing");
  const rate = root.rate_limit;
  return {
    primary: parseWindow(objectField(rate, "primary_window"), "Session", null),
    secondary: parseWindow(objectField(rate, "secondary_window"), "Additional limit", null),
  };
}

/** Claude usage: `five_hour` and `seven_day`, whose lengths are known even when the body omits them. */
export function parseClaude(body: string): Windows {
  const root: unknown = JSON.parse(body);
  return {
    primary: parseWindow(objectField(root, "five_hour"), "5-hour", 5 * 3600),
    secondary: parseWindow(objectField(root, "seven_day"), "7-day", 7 * 24 * 3600),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Credentials: location, token, expiry. A token value only ever leaves this section as a request header.
// ---------------------------------------------------------------------------------------------------------------------

/** Lexically normalizes an absolute POSIX path. Returns null for relative paths and for any `..` segment. */
function normalizeAbsolute(path: string): string | null {
  if (!path.startsWith("/")) return null;
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    parts.push(segment);
  }
  return "/" + parts.join("/");
}

export type CredentialLocation = { path: string } | { problem: "home_unset" | "codex_home_outside_codex_dir" };

/**
 * Where a provider's credential file is.
 *
 * Codex: `$CODEX_HOME/auth.json` when CODEX_HOME is set and non-empty, else `~/.codex/auth.json`. The sandbox only
 * reads files under `~/.codex` and `~/.claude` (nsh.json's fs.read roots are static), so a CODEX_HOME outside
 * `~/.codex` is refused rather than read from somewhere the sandbox does not grant. It is never silently replaced by
 * `~/.codex`, which could be another account.
 *
 * Claude: `~/.claude/.credentials.json`. CODEX_HOME does not apply.
 */
export function credentialLocation(codex: boolean, deps: Pick<Deps, "env" | "homeDir">): CredentialLocation {
  const home = deps.homeDir ? normalizeAbsolute(deps.homeDir) : null;
  if (!codex) {
    if (home === null) return { problem: "home_unset" };
    return { path: `${home === "/" ? "" : home}/.claude/.credentials.json` };
  }
  const codexHome = deps.env.CODEX_HOME;
  if (codexHome !== undefined && codexHome !== "") {
    if (home === null) return { problem: "home_unset" };
    const root = `${home === "/" ? "" : home}/.codex`;
    const normalized = normalizeAbsolute(codexHome);
    if (normalized === null || !(normalized === root || normalized.startsWith(`${root}/`))) {
      return { problem: "codex_home_outside_codex_dir" };
    }
    return { path: `${normalized === "/" ? "" : normalized}/auth.json` };
  }
  if (home === null) return { problem: "home_unset" };
  return { path: `${home === "/" ? "" : home}/.codex/auth.json` };
}

/** The access token from credential file text, or null. Codex: `tokens.access_token`; Claude: `claudeAiOauth.accessToken`. */
export function accessToken(root: unknown, codex: boolean): string | null {
  return codex
    ? stringField(objectField(root, "tokens"), "access_token")
    : stringField(objectField(root, "claudeAiOauth"), "accessToken");
}

/**
 * When the access token expires, as a UTC ISO timestamp in whole seconds, or null when the file records none. Claude
 * stores milliseconds in `claudeAiOauth.expiresAt`; the Codex token is a JWT whose `exp` claim is read. Only the
 * expiry is returned.
 */
export function credentialExpiry(text: string, codex: boolean): string | null {
  const iso = credentialExpiryIso(text, codex);
  if (iso === null) return null;
  return epochIso(Date.parse(iso) / 1000);
}

// ---------------------------------------------------------------------------------------------------------------------
// Error mapping: failures become a safe code and a fixed message, never the upstream body.
// ---------------------------------------------------------------------------------------------------------------------

/** The error for a non-200 HTTP status. */
export function httpError(status: number): ProviderError {
  if (status === 401) return { code: "authentication_required", message: "Provider rejected authentication; sign-in may have expired" };
  if (status === 403) return { code: "access_denied", message: "Provider denied access to usage data" };
  if (status === 429) return { code: "rate_limited", message: "Provider rate limit reached" };
  if (status >= 500 && status <= 599) return { code: "provider_server_error", message: "Provider is temporarily unavailable" };
  return { code: "http_error", message: "Provider returned an unexpected HTTP status" };
}

function unavailable(error: ProviderError, expiresAt: string | null = null): ProviderSnapshot {
  return {
    state: "unavailable",
    last_success_at: null,
    windows: { primary: null, secondary: null },
    error,
    expires_at: expiresAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Carry-forward: a failed refresh keeps the last good usage, marked stale.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * When `current` did not refresh and `previous` had usable windows, returns `current` marked `stale` with previous
 * usage and its last-success time. The error of `current` is kept, so the reason for staleness stays visible.
 */
export function carryForward(current: ProviderSnapshot, previous: ProviderSnapshot | null): ProviderSnapshot {
  if (current.state === "fresh" || previous === null) return current;
  const { primary, secondary } = previous.windows;
  if (primary === null && secondary === null) return current;
  return {
    ...current,
    state: "stale",
    last_success_at: previous.last_success_at,
    windows: { primary, secondary },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------------------------------------------------

class BodyTooLarge extends Error {
  constructor() {
    super("response body is too large");
    this.name = "BodyTooLarge";
  }
}

/** Reads a response body, failing as soon as it exceeds `maxBytes`. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLarge();
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function requestHeaders(token: string, account: string | null, claude: boolean): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (account !== null) headers["chatgpt-account-id"] = account;
  if (claude) headers["anthropic-beta"] = CLAUDE_BETA;
  headers["user-agent"] = USER_AGENT;
  return headers;
}

function nowIso(deps: Deps): string {
  const iso = epochIso(Math.floor(deps.now().getTime() / 1000));
  if (iso === null) throw new SuperbarError("clock_unavailable", "System clock is outside the supported range");
  return iso;
}

/**
 * One provider's refresh, with no carry-forward. Provider failures are returned as snapshots. A deadline failure
 * throws, because the whole run has then been abandoned.
 */
async function fetchOne(name: ProviderName, run: Run, deps: Deps): Promise<ProviderSnapshot> {
  const codex = name === "codex";
  const location = credentialLocation(codex, deps);
  if ("problem" in location) {
    const message = location.problem === "codex_home_outside_codex_dir" ? CODEX_HOME_MESSAGE : "Credential file unavailable";
    return unavailable({ code: "credentials_missing", message });
  }
  let text: string;
  try {
    text = await run.call(() => deps.fs.readText(location.path, MAX_CREDENTIAL_BYTES));
  } catch (err) {
    if (isDeadlineFailure(err, run)) throw timeoutError();
    return unavailable({ code: "credentials_unavailable", message: "Could not read credential file" });
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return unavailable({ code: "credentials_invalid", message: "Credential file is invalid" });
  }
  // From here on the expiry is known, so every outcome reports it.
  const expiresAt = credentialExpiry(text, codex);
  const fail = (code: string, message: string) => unavailable({ code, message }, expiresAt);

  const token = accessToken(root, codex);
  if (token === null) return fail("credentials_missing", "Access token unavailable");
  const account = codex ? stringField(objectField(root, "tokens"), "account_id") : null;
  run.check();

  let status: number;
  let body: string;
  try {
    const response = await run.call(() =>
      deps.fetch(codex ? CODEX_USAGE_URL : CLAUDE_USAGE_URL, {
        method: "GET",
        headers: requestHeaders(token, account, !codex),
        // Redirects are not followed, so the bearer token is never sent to another host.
        redirect: "manual",
        signal: run.signal,
      }),
    );
    status = response.status;
    body = await run.call(() => readBoundedBody(response, MAX_RESPONSE_BYTES));
  } catch (err) {
    if (isDeadlineFailure(err, run)) throw timeoutError();
    if (err instanceof BodyTooLarge) return fail("response_too_large", "Provider response exceeded the size limit");
    return fail("network_error", "Could not connect to provider");
  }
  if (status !== 200) {
    const error = httpError(status);
    return fail(error.code, error.message);
  }

  let windows: Windows;
  try {
    windows = codex ? parseCodex(body) : parseClaude(body);
  } catch {
    return fail("response_invalid", "Provider response was invalid");
  }
  if (windows.primary === null && windows.secondary === null) {
    return fail("response_invalid", "Provider response contained no valid usage windows");
  }
  return { state: "fresh", last_success_at: nowIso(deps), windows, error: null, expires_at: expiresAt };
}

/** Refreshes one provider. No carry-forward and no persistence. Rejects with a timeout at the deadline. */
export async function fetchProvider(name: ProviderName, overrides?: Partial<Deps>): Promise<ProviderSnapshot> {
  const deps = resolveDeps(overrides);
  return withRun(deps, (run) => fetchOne(name, run, deps));
}

/** Refreshes both providers. Fetches only: nothing is persisted and nothing is carried forward. */
export async function fetchAll(overrides?: Partial<Deps>): Promise<Snapshot> {
  const deps = resolveDeps(overrides);
  return withRun(deps, async (run) => {
    const generatedAt = nowIso(deps);
    const providers = {} as Record<ProviderName, ProviderSnapshot>;
    for (const name of PROVIDERS) providers[name] = await fetchOne(name, run, deps);
    return { schema_version: 1, generated_at: generatedAt, providers };
  });
}

export function parseSelection(value: string): Selection {
  if (value === "all" || value === "codex" || value === "claude") return value;
  throw new SuperbarError("invalid_provider", `Unknown provider "${value}"`);
}

function snapshotDir(deps: Deps): string {
  if (deps.dataDir === null) {
    throw new SuperbarError("data_dir_unavailable", "This host has no data directory for the snapshot");
  }
  return deps.dataDir;
}

/** How a function reaches the disk: through a run's watchdog, or directly for cleanup that must finish. */
type Call = <T>(op: () => Promise<T>) => Promise<T>;
const direct: Call = (op) => op();

// ---------------------------------------------------------------------------------------------------------------------
// Snapshot store: versioned files, never replaced.
//
//   ${dataDir}/snapshot.<provider>.<writtenAtMs>-<tag>.json, each holding
//   { "schema_version": 1, "provider": "<name>", "written_at": "<UTC ISO>", "value": <ProviderSnapshot> }
//
// A save writes a uniquely named temporary file, restricts it (POSIX: 0600, verified), and renames it to a NEW unique
// name. A committed file is never replaced, so a rename can only add a version. When saves complete in any order, or
// one lands late, every version is still there and the reader chooses among them.
//
// Ordering: a recorded instant is a wall-clock time written inside the file. Its validity is checked (the exact UTC
// form, a real calendar date, a year from 2000 to 2100), and it is compared as a number. A version whose ranking fields
// are malformed is untrusted. File names are never used for ordering. The newest is judged by the recorded instants
// (last_success_at, then written_at, then the basename as a deterministic tie-break), not by the order of requests.
// Accepted limitation: after a clock rollback, a version recorded up to five minutes in the future still ranks as the
// newest, so a newer recorded success is kept until time catches up. A version recorded further ahead does not win.
//
// Reading: every trusted version of a provider is considered. A version is trusted when the data directory is a
// directory with mode 0700 (POSIX), the file is private (0600, verified), and it parses with the right schema and
// provider. The chosen version is the newest success: the highest recorded last_success_at, then the latest written_at,
// then the name. A version recorded later than the present, beyond a small skew, is not preferred. Corrupt or untrusted
// versions are skipped one by one, so a corrupt newest version falls back to the next valid one.
//
// Garbage collection: after a commit, the newest KEEP_VERSIONS trusted versions of that provider are kept, and every
// other file with this exact name pattern is deleted. The same ordering picks the chosen version, so collection never
// removes it. A late write that lands after a collection is an extra old version, which the next collection removes.
//
// Migration: the earlier combined ${dataDir}/snapshot.json is read only as the carry-forward source for a provider that
// has no trusted version yet. It is never written and never deleted. Doctor reports it.
//
// Ownership: nsh's stat exposes no uid, so the owner of the data directory is not checked. Only its mode is.
// ---------------------------------------------------------------------------------------------------------------------

const LOCK_LEFTOVER = /^refresh\.lock\.(stale|new)-[0-9a-f-]+$/;
export const KEEP_VERSIONS = 3;
/** Doctor warns when more files than this are present: cleanup is failing repeatedly. */
const RETENTION_WARN_ABOVE = 2 * KEEP_VERSIONS;
const FUTURE_SKEW_MS = 5 * 60_000;
const LEGACY_SNAPSHOT_NAME = "snapshot.json";

function versionPattern(name: ProviderName): RegExp {
  return new RegExp(`^snapshot\\.${name}\\.([0-9]+)-([0-9a-f]+)\\.json$`);
}

/** Temporary files of saves, in the current and the earlier naming. Swept only when old. */
const TEMP_PATTERN = /^snapshot\.(codex|claude)\.(?:[0-9]+-[0-9a-f]+\.)?json\.[0-9a-f-]+\.tmp$|^snapshot\.json\.[0-9a-f-]+\.tmp$/;

function versionPath(deps: Deps, name: ProviderName, ms: number, tag: string): string {
  return `${snapshotDir(deps)}/snapshot.${name}.${ms}-${tag}.json`;
}

function storedWindow(v: unknown): UsageWindow | null {
  const percent = numberField(v, "used_percent");
  const label = objectField(v, "label");
  if (percent === null || percent < 0 || percent > 100 || typeof label !== "string") return null;
  const reset = objectField(v, "reset_at");
  const duration = objectField(v, "duration_seconds");
  return {
    label,
    used_percent: percent,
    reset_at: typeof reset === "string" ? reset : null,
    duration_seconds: typeof duration === "number" ? duration : null,
  };
}

const INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MIN_INSTANT_MS = Date.UTC(2000, 0, 1);
const MAX_INSTANT_MS = Date.UTC(2101, 0, 1);

/**
 * A recorded timestamp as a number of milliseconds, or null when it is not one: the exact UTC form, a real calendar
 * date (it must round-trip through Date), and a year from 2000 to 2100. Ranking only ever compares these numbers.
 */
export function instantOf(text: string): number | null {
  if (!INSTANT_TEXT.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms < MIN_INSTANT_MS || ms >= MAX_INSTANT_MS) return null;
  return new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19) ? ms : null;
}

function storedProvider(v: unknown): ProviderSnapshot | null {
  const state = objectField(v, "state");
  if (state !== "fresh" && state !== "stale" && state !== "unavailable") return null;
  const windows = objectField(v, "windows");
  const error = objectField(v, "error");
  const lastSuccess = objectField(v, "last_success_at");
  // A malformed ranking field makes the whole provider invalid; it is never ranked by a guess.
  if (lastSuccess !== undefined && lastSuccess !== null && (typeof lastSuccess !== "string" || instantOf(lastSuccess) === null)) {
    return null;
  }
  const expires = objectField(v, "expires_at");
  const errorCode = objectField(error, "code");
  const errorMessage = objectField(error, "message");
  return {
    state: state as ProviderState,
    last_success_at: typeof lastSuccess === "string" ? lastSuccess : null,
    windows: { primary: storedWindow(objectField(windows, "primary")), secondary: storedWindow(objectField(windows, "secondary")) },
    error: typeof errorCode === "string" && typeof errorMessage === "string" ? { code: errorCode, message: errorMessage } : null,
    expires_at: typeof expires === "string" ? expires : null,
  };
}

/** The legacy combined snapshot, as the earlier single-file store wrote it. Returns null when it is not usable. */
export function parseSnapshot(text: string): Snapshot | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (objectField(root, "schema_version") !== 1) return null;
  const providers = objectField(root, "providers");
  const codex = storedProvider(objectField(providers, "codex"));
  const claude = storedProvider(objectField(providers, "claude"));
  if (codex === null || claude === null) return null;
  const generated = objectField(root, "generated_at");
  return {
    schema_version: 1,
    generated_at: typeof generated === "string" ? generated : "",
    providers: { codex, claude },
  };
}

/** One version file: when it was written, and the provider's snapshot. */
export interface StoredProvider {
  written_at: string;
  value: ProviderSnapshot;
}

export function parseProviderFile(text: string, name: ProviderName): StoredProvider | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (objectField(root, "schema_version") !== 1 || objectField(root, "provider") !== name) return null;
  const value = storedProvider(objectField(root, "value"));
  const writtenAt = objectField(root, "written_at");
  if (value === null || typeof writtenAt !== "string" || instantOf(writtenAt) === null) return null;
  return { written_at: writtenAt, value };
}

type FileState<T> = { kind: "absent" } | { kind: "untrusted" } | { kind: "trusted"; value: T };

/**
 * Reads one stored file. Absent when there is none. Untrusted when it is not private (POSIX) or does not parse; an
 * untrusted file is skipped, not an error. Any other per-entry failure (an access denial, EISDIR, a failed stat) also
 * makes that entry untrusted and never aborts the load; ENOENT counts as absent, and only a `timeout` error (the run's
 * deadline) propagates.
 */
async function readStoredFile<T>(run: Run, deps: Deps, path: string, parse: (text: string) => T | null): Promise<FileState<T>> {
  let info: FileStat | null;
  try {
    info = await run.call(() => deps.fs.stat(path));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return { kind: "untrusted" };
  }
  if (info === null) return { kind: "absent" };
  // A directory, symbolic link, FIFO or any other non-regular entry is never read.
  if (info.kind !== "file" || !modeIs(info, 0o600, deps)) return { kind: "untrusted" };
  let text: string;
  try {
    text = await run.call(() => deps.fs.readText(path, MAX_SNAPSHOT_BYTES));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    if (codeOf(err) === "ENOENT") return { kind: "absent" };
    // Any other failure (EISDIR, EFBIG, an access denial) affects this entry only.
    return { kind: "untrusted" };
  }
  const value = parse(text);
  return value === null ? { kind: "untrusted" } : { kind: "trusted", value };
}

/**
 * Whether the data directory may be trusted: a directory with mode 0700 on POSIX. Its owner is not checked, because
 * nsh's stat exposes no uid. While it is not trusted, no stored file is read as a snapshot.
 */
async function storeTrusted(run: Run, deps: Deps): Promise<boolean> {
  let info: FileStat | null;
  try {
    info = await run.call(() => deps.fs.stat(snapshotDir(deps)));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return false;
  }
  if (info === null || info.kind !== "dir") return false;
  return !isPosix(deps) || (info.mode & 0o777) === 0o700;
}

interface Version {
  /** The basename as listed; it matched the exact pattern. */
  name: string;
  path: string;
  written_at: string;
  /** Recorded instants, as numbers. Ordering uses only these, never the file name. */
  written_ms: number;
  last_ms: number | null;
  value: ProviderSnapshot;
}

interface Entry {
  /** The basename as listed, for entries that matched the exact pattern. */
  name: string;
  kind: FileStat["kind"] | "vanished";
}

interface Scan {
  /** Every listed name of this provider's exact pattern, with what it is. */
  entries: Entry[];
  /** Valid, private, regular version files, with their recorded instants. */
  trusted: Version[];
  /** Entries that were not used: not regular files, not private, not parsable, or unreadable. */
  untrusted: number;
  /** The directory listing failed with this code; nothing was read. */
  listError: string | null;
}

async function scanVersions(run: Run, deps: Deps, name: ProviderName): Promise<Scan> {
  const dir = snapshotDir(deps);
  let names: string[];
  try {
    names = await run.call(() => deps.fs.list(dir));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return { entries: [], trusted: [], untrusted: 0, listError: codeOf(err) ?? "error" };
  }
  const pattern = versionPattern(name);
  const matching = names.filter((n) => pattern.test(n));
  if (matching.length === 0) return { entries: [], trusted: [], untrusted: 0, listError: null };
  const dirOk = await storeTrusted(run, deps);
  const entries: Entry[] = [];
  const trusted: Version[] = [];
  let untrusted = 0;
  for (const n of matching) {
    const path = `${dir}/${n}`;
    let kind: Entry["kind"];
    try {
      const info = await run.call(() => deps.fs.stat(path));
      kind = info === null ? "vanished" : info.kind;
    } catch (err) {
      if (codeOf(err) === "timeout") throw err;
      kind = "other";
    }
    if (kind === "vanished") continue;
    entries.push({ name: n, kind });
    if (!dirOk || kind !== "file") {
      untrusted++;
      continue;
    }
    const state = await readStoredFile(run, deps, path, (text) => parseProviderFile(text, name));
    if (state.kind !== "trusted") {
      untrusted++;
      continue;
    }
    trusted.push({
      name: n,
      path,
      written_at: state.value.written_at,
      written_ms: instantOf(state.value.written_at) ?? 0,
      last_ms: state.value.value.last_success_at === null ? null : instantOf(state.value.value.last_success_at),
      value: state.value.value,
    });
  }
  return { entries, trusted, untrusted, listError: null };
}

function isFutureVersion(v: Version, nowMs: number): boolean {
  const limit = nowMs + FUTURE_SKEW_MS;
  return v.written_ms > limit || (v.last_ms !== null && v.last_ms > limit);
}

/**
 * Versions best first: not-future before future, then the newest recorded success, then the latest recorded write,
 * then the basename as a deterministic tie-break among identical recorded instants. The ordering is by the recorded
 * wall-clock instants, not by request order and not by file names.
 */
function ranked(versions: Version[], nowMs: number): Version[] {
  return [...versions].sort((a, b) => {
    const fa = isFutureVersion(a, nowMs);
    const fb = isFutureVersion(b, nowMs);
    if (fa !== fb) return fa ? 1 : -1;
    const la = a.last_ms ?? Number.NEGATIVE_INFINITY;
    const lb = b.last_ms ?? Number.NEGATIVE_INFINITY;
    if (la !== lb) return la < lb ? 1 : -1;
    if (a.written_ms !== b.written_ms) return a.written_ms < b.written_ms ? 1 : -1;
    if (a.name !== b.name) return a.name < b.name ? 1 : -1;
    return 0;
  });
}

/** Runs chmod on `path`, then verifies the mode bits. False when either fails. */
async function restrict(run: Run, deps: Deps, path: string, mode: number): Promise<boolean> {
  try {
    const out = await run.call(() => deps.run("chmod", [mode.toString(8), path]));
    if (out.code !== 0) return false;
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return false;
  }
  const info = await run.call(() => deps.fs.stat(path));
  return info !== null && modeIs(info, mode, deps);
}

/** Deletes temporary files of interrupted saves that are older than the stale margin. */
async function sweepTemporaries(run: Run, deps: Deps, dir: string): Promise<void> {
  let names: string[];
  try {
    names = await run.call(() => deps.fs.list(dir));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return;
  }
  for (const name of names) {
    if (!TEMP_PATTERN.test(name)) continue;
    try {
      const info = await run.call(() => deps.fs.stat(`${dir}/${name}`));
      if (info !== null && info.kind === "file" && deps.now().getTime() - info.mtimeMs > LOCK_STALE_MS) {
        await run.call(() => deps.fs.unlink(`${dir}/${name}`));
      }
    } catch (err) {
      if (codeOf(err) === "timeout") throw err;
    }
  }
}

/** Keeps the newest KEEP_VERSIONS trusted versions and deletes the other files of this provider's pattern. */
async function collectGarbage(run: Run, deps: Deps, name: ProviderName): Promise<void> {
  const dir = snapshotDir(deps);
  const scan = await scanVersions(run, deps, name);
  if (scan.trusted.length === 0 || !(await storeTrusted(run, deps))) return;
  const keep = new Set(ranked(scan.trusted, deps.now().getTime()).slice(0, KEEP_VERSIONS).map((v) => v.name));
  for (const entry of scan.entries) {
    // Only a listed regular file whose basename matches the exact pattern. unlink never follows a link, so even a
    // link that appeared since the listing is removed as a link and its target is never touched.
    if (entry.kind !== "file" || keep.has(entry.name) || !versionPattern(name).test(entry.name)) continue;
    try {
      await run.call(() => deps.fs.unlink(`${dir}/${entry.name}`));
    } catch (err) {
      if (codeOf(err) === "timeout") throw err;
    }
  }
}

/**
 * Saves one provider's snapshot as a new version. The file is written to a temporary name, restricted to 0600 on POSIX
 * (verified), then renamed to a new unique name. Nothing is replaced. On POSIX the store directory is restricted to 0700
 * before anything is written. If a mode cannot be enforced, nothing is saved. Returns the storage error, or null.
 */
async function saveProvider(run: Run, deps: Deps, name: ProviderName, value: ProviderSnapshot): Promise<ProviderError | null> {
  const dir = snapshotDir(deps);
  await run.call(() => deps.fs.mkdir(dir));
  if (isPosix(deps) && !(await restrict(run, deps, dir, 0o700))) return STORAGE_INSECURE;
  await sweepTemporaries(run, deps, dir);
  const writtenAt = nowIso(deps);
  const path = versionPath(deps, name, deps.now().getTime(), randomUUID().replace(/-/g, ""));
  const json = JSON.stringify({ schema_version: 1, provider: name, written_at: writtenAt, value });
  if (new TextEncoder().encode(json).byteLength > MAX_SNAPSHOT_BYTES) {
    throw new SuperbarError("snapshot_too_large", "The snapshot exceeds its size limit");
  }
  const temp = `${path}.${randomUUID()}.tmp`;
  await run.call(() => deps.fs.writeText(temp, json));
  if (isPosix(deps) && !(await restrict(run, deps, temp, 0o600))) {
    await bounded(() => deps.fs.unlink(temp), RELEASE_GRACE_MS);
    return STORAGE_INSECURE;
  }
  // The rename is one call, so an abandoned run cannot start it. It adds a new name and replaces nothing.
  await run.call(() => deps.fs.rename(temp, path));
  // Only after a commit: collection failures are not a failed save.
  try {
    await collectGarbage(run, deps, name);
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
  }
  return null;
}

/** The live expiry from a provider's credential file, or null when the file is missing, unreadable or records none. */
async function liveExpiry(name: ProviderName, run: Run, deps: Deps): Promise<string | null> {
  const location = credentialLocation(name === "codex", deps);
  if ("problem" in location) return null;
  try {
    return credentialExpiry(await run.call(() => deps.fs.readText(location.path, MAX_CREDENTIAL_BYTES)), name === "codex");
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return null;
  }
}

/** A provider with nothing usable stored. The code tells "never saved" from "saved but not trusted". */
function missingProvider(untrusted: boolean): ProviderSnapshot {
  return unavailable(
    untrusted
      ? { code: "snapshot_untrusted", message: "The saved snapshot is not private and was ignored" }
      : { code: "snapshot_missing", message: "No saved snapshot. Use the panel menu to refresh." },
  );
}

/** The provider's previous snapshot for carry-forward: its chosen version, else the legacy file's copy (read-once). */
async function previousFor(run: Run, deps: Deps, name: ProviderName): Promise<ProviderSnapshot | null> {
  const scan = await scanVersions(run, deps, name);
  if (scan.trusted.length > 0) return ranked(scan.trusted, deps.now().getTime())[0].value;
  const legacyPath = `${snapshotDir(deps)}/${LEGACY_SNAPSHOT_NAME}`;
  const legacy = (await storeTrusted(run, deps))
    ? await readStoredFile(run, deps, legacyPath, parseSnapshot)
    : (await run.call(() => deps.fs.stat(legacyPath))) === null
      ? ({ kind: "absent" } as const)
      : ({ kind: "untrusted" } as const);
  return legacy.kind === "trusted" ? legacy.value.providers[name] : null;
}

/**
 * The saved snapshot, or null when no provider has a trusted version. Each chosen provider's `expires_at` is replaced
 * by the live expiry from its credential file when that file yields one, so the expiry is never older than the file.
 * The legacy combined file is not used here. No network access.
 */
export async function loadSnapshot(overrides?: Partial<Deps>): Promise<Snapshot | null> {
  const deps = resolveDeps(overrides);
  if (deps.dataDir === null) return null;
  return withRun(deps, async (run) => {
    const nowMs = deps.now().getTime();
    const providers = {} as Record<ProviderName, ProviderSnapshot>;
    const chosen: ProviderName[] = [];
    let newest: { ms: number; iso: string } | null = null;
    for (const name of PROVIDERS) {
      const scan = await scanVersions(run, deps, name);
      if (scan.trusted.length > 0) {
        const best = ranked(scan.trusted, nowMs)[0];
        providers[name] = best.value;
        chosen.push(name);
        if (newest === null || best.written_ms > newest.ms) newest = { ms: best.written_ms, iso: best.written_at };
      } else {
        providers[name] = missingProvider(scan.entries.length > 0);
      }
    }
    if (chosen.length === 0) return null;
    for (const name of chosen) {
      const live = await liveExpiry(name, run, deps);
      if (live !== null) providers[name].expires_at = live;
    }
    return { schema_version: 1, generated_at: newest?.iso ?? "", providers };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Lock: a best-effort guard against duplicate provider requests. It is not a correctness mechanism.
//
// What it does: a refresh creates ${dataDir}/refresh.lock by renaming a staging directory that already holds
// owner.json = {token, started} (rename refuses a non-empty target, so the lock is never overwritten and is never
// empty). A refresh that finds a fresh lock returns busy. A lock older than LOCK_STALE_MS is stale and is renamed away.
// A start time in the future counts as fresh, so a clock step backwards can only make a lock last longer. Release
// renames the lock away only when its owner is still this run's token.
//
// What it guarantees, in plain words:
//   - In the normal case, one refresh at a time: a second refresh returns busy and makes no request.
//   - Otherwise overlap is possible, and in theory it is not bounded: several runs can hold observations of the same
//     stale owner and displace each other's locks, under crashed-owner or clock-step races. Overlap can only cost
//     duplicate provider requests.
//   - Stored data is always consistent regardless, because commits are versioned and never replace each other (see the
//     store section). An overlap cannot lose a stored success, and cannot leave a half-written file.
// Leftover lock directories (displaced or staged) are swept once they are older than LOCK_STALE_MS.
// ---------------------------------------------------------------------------------------------------------------------

interface Owner {
  token: string;
  started: number;
}

type LockState = { kind: "gone" } | { kind: "owned"; token: string; age: number } | { kind: "unowned"; mtimeMs: number; age: number };

function isStale(age: number): boolean {
  return age > LOCK_STALE_MS;
}

async function readOwner(call: Call, deps: Deps, lockDir: string): Promise<Owner | null> {
  let text: string;
  try {
    text = await call(() => deps.fs.readText(`${lockDir}/${OWNER_NAME}`, 4096));
  } catch (err) {
    if (codeOf(err) === "ENOENT") return null;
    throw err;
  }
  let owner: unknown;
  try {
    owner = JSON.parse(text);
  } catch {
    return null;
  }
  const token = objectField(owner, "token");
  const started = numberField(owner, "started");
  return typeof token === "string" && token !== "" && started !== null ? { token, started } : null;
}

async function lockState(call: Call, deps: Deps, lockDir: string): Promise<LockState> {
  const info = await call(() => deps.fs.stat(lockDir));
  if (info === null) return { kind: "gone" };
  const now = deps.now().getTime();
  // A symbolic link or other non-directory at the lock path is never read as an owner.
  if (info.kind !== "dir") return { kind: "unowned", mtimeMs: info.mtimeMs, age: now - info.mtimeMs };
  const owner = await readOwner(call, deps, lockDir);
  if (owner !== null) return { kind: "owned", token: owner.token, age: now - owner.started };
  return { kind: "unowned", mtimeMs: info.mtimeMs, age: now - info.mtimeMs };
}

/** Removes a directory we created (a staging or displaced lock). Never throws. */
async function discardDir(deps: Deps, path: string): Promise<void> {
  let info: FileStat | null;
  try {
    info = await deps.fs.stat(path);
  } catch {
    return;
  }
  if (info === null) return;
  // A symbolic link is removed as a link. Its target is never touched, and nothing is removed inside it.
  if (info.kind === "symlink") {
    try {
      await deps.fs.unlink(path);
    } catch {
      // Already gone.
    }
    return;
  }
  // Anything other than a directory that we created is left alone.
  if (info.kind !== "dir") return;
  try {
    await deps.fs.unlink(`${path}/${OWNER_NAME}`);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
  try {
    await deps.fs.rmdir(path);
  } catch (err) {
    if (codeOf(err) !== "ENOENT") throw err;
  }
}

/**
 * Renames a stale lock away under a unique name, then judges what was moved. If the moved lock is fresh (another run
 * replaced the stale one meanwhile), it is put back when the path is free. Whatever is not put back is discarded.
 */
async function breakStaleLock(run: Run, deps: Deps, dir: string, lockDir: string): Promise<void> {
  const parked = `${dir}/${LOCK_NAME}.stale-${randomUUID()}`;
  try {
    await run.call(() => deps.fs.rename(lockDir, parked));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return; // already moved by someone else
  }
  const moved = await lockState(run.call, deps, parked);
  if (moved.kind !== "gone" && !isStale(moved.age)) {
    try {
      await run.call(() => deps.fs.rename(parked, lockDir));
      return;
    } catch (err) {
      if (codeOf(err) === "timeout") throw err;
      // The path is taken: the displaced lock is not held any more. Discard it below.
    }
  }
  await bounded(() => discardDir(deps, parked), RELEASE_GRACE_MS);
}

/** Takes the lock for `token`, or returns false when a fresh lock is held. */
async function acquireLock(run: Run, deps: Deps, token: string): Promise<boolean> {
  const dir = snapshotDir(deps);
  await run.call(() => deps.fs.mkdir(dir));
  const lockDir = `${dir}/${LOCK_NAME}`;
  const staging = `${dir}/${LOCK_NAME}.new-${token}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await run.call(() => deps.fs.mkdirExclusive(staging));
      await run.call(() => deps.fs.writeText(`${staging}/${OWNER_NAME}`, JSON.stringify({ token, started: deps.now().getTime() })));
      await run.call(() => deps.fs.rename(staging, lockDir));
      return true;
    } catch (err) {
      await bounded(() => discardDir(deps, staging), RELEASE_GRACE_MS);
      if (codeOf(err) === "timeout") throw err;
      if (codeOf(err) !== "EEXIST" && codeOf(err) !== "ENOTEMPTY") throw err;
    }
    const state = await lockState(run.call, deps, lockDir);
    if (state.kind === "gone") continue;
    if (!isStale(state.age)) return false;
    await breakStaleLock(run, deps, dir, lockDir);
  }
  return false;
}

/** Releases the lock if its owner is still `token`, and discards this run's staging directory. Never throws. */
async function releaseLock(token: string, deps: Deps): Promise<void> {
  const dir = snapshotDir(deps);
  const lockDir = `${dir}/${LOCK_NAME}`;
  await bounded(async () => {
    const owner = await readOwner(direct, deps, lockDir);
    if (owner === null || owner.token !== token) return;
    const parked = `${dir}/${LOCK_NAME}.stale-${randomUUID()}`;
    await deps.fs.rename(lockDir, parked);
    const moved = await readOwner(direct, deps, parked);
    if (moved !== null && moved.token !== token) {
      try {
        await deps.fs.rename(parked, lockDir);
        return;
      } catch {
        // The path is taken; the displaced lock is discarded below.
      }
    }
    await discardDir(deps, parked);
  }, RELEASE_GRACE_MS);
  await bounded(() => discardDir(deps, `${dir}/${LOCK_NAME}.new-${token}`), RELEASE_GRACE_MS);
}

/** Discards leftover displaced and staging lock directories that are older than the stale margin. Under the lock. */
async function sweepLockLeftovers(run: Run, deps: Deps): Promise<void> {
  const dir = snapshotDir(deps);
  let names: string[];
  try {
    names = await run.call(() => deps.fs.list(dir));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return;
  }
  for (const name of names) {
    if (!LOCK_LEFTOVER.test(name)) continue;
    try {
      const info = await run.call(() => deps.fs.stat(`${dir}/${name}`));
      if (info !== null && deps.now().getTime() - info.mtimeMs > LOCK_STALE_MS) await discardDir(deps, `${dir}/${name}`);
    } catch (err) {
      if (codeOf(err) === "timeout") throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Refreshes the selected providers, each as a new version, under the best-effort lock and the deadline. A refresh that
 * finds a fresh lock returns `{ status: "busy" }` and changes nothing (the Zig CLI's exit status 75). A refresh past its
 * deadline rejects with a `timeout` error. When a provider's snapshot cannot be kept private, the result still carries
 * the snapshot, with `storage` set.
 */
export async function refresh(selection: Selection = "all", overrides?: Partial<Deps>): Promise<RefreshOutcome> {
  const deps = resolveDeps(overrides);
  const token = randomUUID();
  try {
    return await withRun<RefreshOutcome>(deps, async (run) => {
      if (!(await acquireLock(run, deps, token))) return { status: "busy" };
      run.check();
      await sweepLockLeftovers(run, deps);
      const providers = {} as Record<ProviderName, ProviderSnapshot>;
      let storageError: ProviderError | null = null;
      for (const name of PROVIDERS) {
        const prior = await previousFor(run, deps, name);
        if (selection !== "all" && selection !== name) {
          providers[name] = prior ?? unavailable({ code: "not_fetched", message: "Provider was not refreshed yet" });
          continue;
        }
        const value = carryForward(await fetchOne(name, run, deps), prior);
        run.check();
        const error = await saveProvider(run, deps, name, value);
        storageError = storageError ?? error;
        providers[name] = value;
      }
      const snapshot: Snapshot = { schema_version: 1, generated_at: nowIso(deps), providers };
      if (storageError !== null) return { status: "ok", snapshot, storage: { persisted: false, error: storageError } };
      return { status: "ok", snapshot };
    });
  } finally {
    // Always attempted: release removes only a lock whose owner is this token.
    if (deps.dataDir !== null) await releaseLock(token, deps);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Doctor: local checks only. Nothing is created, refreshed or printed beyond the checks' details.
// ---------------------------------------------------------------------------------------------------------------------

/** Human duration for token expiry: `20m`, `2h 14m`, `3d 4h`. */
export function remainingText(seconds: number): string {
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m`;
  return "under 1m";
}

async function dataDirCheck(run: Run, deps: Deps): Promise<DoctorCheck> {
  const name = "data_dir";
  const dir = deps.dataDir;
  if (dir === null) return { name, status: "fail", detail: "process.dataDir is not available on this host" };
  let info: FileStat | null;
  try {
    info = await run.call(() => deps.fs.stat(dir));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return { name, status: "fail", detail: `cannot inspect ${dir} (${codeOf(err) ?? "error"})` };
  }
  if (info === null) return { name, status: "ok", detail: `${dir} does not exist yet (a refresh creates it)` };
  if (!info.isDirectory) return { name, status: "fail", detail: `${dir} is not a directory` };
  if (!isPosix(deps)) return { name, status: "ok", detail: "per-user permissions apply on this host; mode not checked" };
  if (modeIs(info, 0o700, deps)) return { name, status: "ok", detail: `${dir} is private (mode 0700)` };
  return {
    name,
    status: "warn",
    detail: `${dir} has mode ${formatMode(info.mode)}, expected 0700; snapshots are ignored until it is 0700 (the next refresh restricts it)`,
  };
}

async function providerFileCheck(run: Run, deps: Deps, name: ProviderName): Promise<DoctorCheck> {
  const checkName = `snapshot_${name}`;
  if (deps.dataDir === null) return { name: checkName, status: "warn", detail: "no data directory, so no snapshot is kept" };
  if (!(await storeTrusted(run, deps))) {
    return {
      name: checkName,
      status: "warn",
      detail: "the data directory is not a private directory (mode 0700); snapshots are ignored until it is",
    };
  }
  let scan: Scan;
  try {
    scan = await scanVersions(run, deps, name);
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return { name: checkName, status: "fail", detail: `cannot inspect the ${name} snapshots (${codeOf(err) ?? "error"})` };
  }
  if (scan.listError !== null) {
    return { name: checkName, status: "warn", detail: `cannot list the data directory (${scan.listError}); ${name} snapshots cannot be read` };
  }
  const total = scan.entries.length;
  if (total === 0) return { name: checkName, status: "ok", detail: `no ${name} snapshot saved yet` };
  if (scan.trusted.length === 0) {
    return {
      name: checkName,
      status: "warn",
      detail: `${total} ${name} snapshot entr(y/ies), none valid and private; they are ignored until the next refresh of ${name}`,
    };
  }
  const best = ranked(scan.trusted, deps.now().getTime())[0];
  const ignored = total - scan.trusted.length;
  // The retention policy keeps up to KEEP_VERSIONS valid versions. Cleanup is best effort: its failures are ignored,
  // so a count above RETENTION_WARN_ABOVE means cleanup has not kept up.
  const cleanupBehind = total > RETENTION_WARN_ABOVE;
  return {
    name: checkName,
    status: ignored > 0 || cleanupBehind ? "warn" : "ok",
    detail:
      `${name}: chose the version written ${best.written_at} (last success ${best.value.last_success_at ?? "none"}); ` +
      `${scan.trusted.length} valid version(s) present, ${ignored} ignored; ` +
      `retention policy keeps up to ${KEEP_VERSIONS} valid versions (cleanup is best effort)` +
      (cleanupBehind ? `; ${total} files are present, more than ${RETENTION_WARN_ABOVE}, so cleanup has not kept up` : "") +
      "; " +
      (isPosix(deps) ? "private (mode 0600)" : "per-user permissions apply on this host"),
  };
}

async function legacyCheck(run: Run, deps: Deps): Promise<DoctorCheck> {
  if (deps.dataDir === null) return { name: "legacy_snapshot", status: "ok", detail: "no data directory" };
  let info: FileStat | null;
  try {
    info = await run.call(() => deps.fs.stat(`${snapshotDir(deps)}/${LEGACY_SNAPSHOT_NAME}`));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    return { name: "legacy_snapshot", status: "fail", detail: `cannot inspect the legacy snapshot (${codeOf(err) ?? "error"})` };
  }
  if (info === null) return { name: "legacy_snapshot", status: "ok", detail: "no legacy snapshot.json" };
  const codex = await scanVersions(run, deps, "codex");
  const claude = await scanVersions(run, deps, "claude");
  const superseded = codex.trusted.length > 0 && claude.trusted.length > 0;
  return {
    name: "legacy_snapshot",
    status: "ok",
    detail: superseded
      ? "legacy snapshot.json is superseded by the versioned provider files and is no longer read; it can be deleted"
      : "legacy snapshot.json is read only as carry-forward for a provider with no valid version; it is never written",
  };
}

async function credentialCheck(name: ProviderName, run: Run, deps: Deps, nowSeconds: number): Promise<DoctorCheck> {
  const codex = name === "codex";
  const checkName = codex ? "codex_credentials" : "claude_credentials";
  const location = credentialLocation(codex, deps);
  if ("problem" in location) {
    if (location.problem === "codex_home_outside_codex_dir") {
      return {
        name: checkName,
        status: "warn",
        detail: "CODEX_HOME points outside ~/.codex, which the app sandbox cannot read; move the credentials under ~/.codex or unset CODEX_HOME",
      };
    }
    return { name: checkName, status: "fail", detail: "HOME is not set" };
  }
  const path = location.path;
  let text: string;
  try {
    text = await run.call(() => deps.fs.readText(path, MAX_CREDENTIAL_BYTES));
  } catch (err) {
    if (codeOf(err) === "timeout") throw err;
    if (codeOf(err) === "ENOENT") return { name: checkName, status: "warn", detail: `no credential file at ${path}` };
    return { name: checkName, status: "fail", detail: `cannot read ${path}` };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { name: checkName, status: "fail", detail: `${path} is not valid JSON` };
  }
  if (accessToken(root, codex) === null) {
    return { name: checkName, status: "warn", detail: "no access token; sign in with the CLI again" };
  }
  const expiresAt = credentialExpiry(text, codex);
  if (expiresAt === null) {
    return { name: checkName, status: "ok", detail: "readable, access token present, no expiry recorded" };
  }
  const remaining = Math.floor(Date.parse(expiresAt) / 1000) - nowSeconds;
  if (remaining <= 0) {
    return {
      name: checkName,
      status: "warn",
      detail: `access token expired ${remainingText(-remaining)} ago; sign in with the CLI again`,
    };
  }
  return {
    name: checkName,
    status: "ok",
    detail: `readable, access token present, expires in ${remainingText(remaining)}`,
  };
}

/** The local setup checks, as `superbar doctor` reports them. Values are checked for presence and expiry only. */
export async function doctor(overrides?: Partial<Deps>): Promise<DoctorCheck[]> {
  const deps = resolveDeps(overrides);
  return withRun(deps, async (run) => {
    const nowSeconds = Math.floor(deps.now().getTime() / 1000);
    return [
      await dataDirCheck(run, deps),
      await credentialCheck("codex", run, deps, nowSeconds),
      await credentialCheck("claude", run, deps, nowSeconds),
      await providerFileCheck(run, deps, "codex"),
      await providerFileCheck(run, deps, "claude"),
      await legacyCheck(run, deps),
    ];
  });
}
