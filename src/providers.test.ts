// Tests for the provider layer. Fake files, processes and fetch are injected, so nothing touches the network or the
// real disk. Parsing, error mapping, carry-forward, expiry and doctor behavior are covered with fixtures here.

import { describe, expect, test } from "nsh/test";
import {
  FETCH_DEADLINE_MS,
  KEEP_VERSIONS,
  LOCK_STALE_MS,
  MAX_RESPONSE_BYTES,
  SNAPSHOT_NAME,
  accessToken,
  carryForward,
  credentialExpiry,
  credentialLocation,
  defaultDeps,
  doctor,
  fetchAll,
  fetchProvider,
  httpError,
  loadSnapshot,
  parseClaude,
  parseCodex,
  parseProviderFile,
  parseSelection,
  parseSnapshot,
  parseWindow,
  refresh,
  remainingText,
  type Deps,
  type FileStat,
  type FileSystem,
  type ProcessRunner,
} from "./providers";
import type { ProviderSnapshot, Snapshot } from "./types";

const HOME = "/home/test";
const CODEX_PATH = `${HOME}/.codex/auth.json`;
const CLAUDE_PATH = `${HOME}/.claude/.credentials.json`;
const DATA = "/data/superbar";
/** Versioned snapshot file names, as the store writes them: snapshot.<provider>.<writtenAtMs>-<tag>.json. */
const codexVersion = (ms: number, tag = "1111") => `${DATA}/snapshot.codex.${ms}-${tag}.json`;
const claudeVersion = (ms: number, tag = "2222") => `${DATA}/snapshot.claude.${ms}-${tag}.json`;
const CODEX_ANY = /^snapshot\.codex\.[0-9]+-[0-9a-f]+\.json$/;
const CLAUDE_ANY = /^snapshot\.claude\.[0-9]+-[0-9a-f]+\.json$/;
const LEFTOVER_ANY = /^refresh\.lock\.(stale|new)-/;
const LEGACY_FILE = `${DATA}/${SNAPSHOT_NAME}`;
const LOCK = `${DATA}/refresh.lock`;
const OWNER = `${LOCK}/owner.json`;
const NOW = "2026-11-07T10:00:00Z";
const NOW_MS = Date.parse(NOW);
const LATER = new Date(NOW_MS + LOCK_STALE_MS + 1000).toISOString();
/** The same instant as LATER, in the whole-second form the store records. */
const LATER_S = LATER.replace(/\.\d+Z$/, "Z");

// header {"alg":"none"}, payload {"exp":1790812800}, base64url without padding; the signature is not checked.
const CODEX_JWT = "eyJhbGciOiJub25lIn0.eyJleHAiOjE3OTA4MTI4MDB9.sig";
const CLAUDE_TOKEN = "claude-secret-token";
// 1790812800 seconds, which is also 1790812800000 ms in Claude's credential file.
const EXP_2026_10_01 = "2026-10-01T00:00:00Z";
const CODEX_USAGE = { rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_at: 1790812800 }, secondary_window: { utilization: 55 } } };
const CLAUDE_USAGE = { five_hour: { utilization: 12, resets_at: "2026-11-07T14:00:00Z" }, seven_day: { utilization: 34 } };

const codexAuth = (token: string = CODEX_JWT, account: string | null = "acct-1") =>
  JSON.stringify({ tokens: { access_token: token, ...(account === null ? {} : { account_id: account }) } });
const claudeAuth = (token: string = CLAUDE_TOKEN, expiresAt: number | null = 1790812800000) =>
  JSON.stringify({ claudeAiOauth: { accessToken: token, ...(expiresAt === null ? {} : { expiresAt }) } });
const ownerFile = (token: string, started: number) => JSON.stringify({ token, started });
const CREDS = { [CODEX_PATH]: codexAuth(), [CLAUDE_PATH]: claudeAuth() };
const STALE_OWNER = ownerFile("dead-run", NOW_MS - LOCK_STALE_MS - 60_000);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = () => new Promise<never>(() => {});

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fsError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

interface Hooks {
  beforeRead?: (path: string) => Promise<void> | void;
  beforeWrite?: (path: string) => Promise<void> | void;
  beforeRename?: (from: string, to: string) => Promise<void> | void;
  beforeMkdirExclusive?: (path: string) => Promise<void> | void;
  /** Runs after a read has produced its text, before the text is returned: lets a test pause a run holding what it read. */
  afterRead?: (path: string, text: string) => Promise<void> | void;
}

interface DirSpec {
  mode?: number;
  mtimeMs?: number;
}

interface FakeFs extends FileSystem {
  files: Record<string, string>;
  modes: Record<string, number>;
  dirs: Set<string>;
  writes: string[];
  reads: string[];
  renames: [string, string][];
  hooks: Hooks;
  mtimes: Record<string, number>;
  exists(path: string): boolean;
  text(path: string): string | undefined;
  mode(path: string): number | undefined;
  chmod(mode: number, path: string): void;
  /** Temporary files written so far, in order (the names contain `.tmp`). */
  temps(): string[];
}

/**
 * An in-memory file system with the contract of nsh's: missing entries reject with ENOENT, a non-empty directory
 * cannot be removed or replaced, a file rename replaces its target, and new files are created with mode 0644.
 */
function memoryFs(init: { files?: Record<string, string>; dirs?: Record<string, DirSpec>; modes?: Record<string, number>; fileTimes?: Record<string, number>; hooks?: Hooks; kinds?: Record<string, "symlink" | "other"> } = {}): FakeFs {
  // `kinds` marks an entry in `files` as a symbolic link (its text is what a read would return) or as another kind of
  // entry (a FIFO-like one). lstat semantics: stat reports the entry itself.
  const kinds: Record<string, "symlink" | "other"> = { ...(init.kinds ?? {}) };
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const dirs = new Set<string>();
  const mtimes: Record<string, number> = { ...(init.fileTimes ?? {}) };
  const writes: string[] = [];
  const reads: string[] = [];
  const renames: [string, string][] = [];
  const hooks: Hooks = init.hooks ?? {};
  for (const [path, text] of Object.entries(init.files ?? {})) {
    files[path] = text;
    modes[path] = init.modes?.[path] ?? 0o600;
  }
  for (const [path, spec] of Object.entries(init.dirs ?? {})) {
    dirs.add(path);
    modes[path] = spec.mode ?? 0o700;
    mtimes[path] = spec.mtimeMs ?? NOW_MS;
  }
  // A data directory that holds files is, as a fixture, a private directory (a store that exists is 0700).
  if (!(DATA in (init.dirs ?? {})) && Object.keys(files).some((p) => p.startsWith(`${DATA}/`))) {
    dirs.add(DATA);
    modes[DATA] = 0o700;
    mtimes[DATA] = NOW_MS;
  }
  const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const exists = (path: string) => path in files || dirs.has(path);
  const hasChildren = (dir: string) => Object.keys(files).some((p) => parentOf(p) === dir) || [...dirs].some((d) => parentOf(d) === dir);
  const makeDir = (path: string, mtimeMs = NOW_MS) => {
    dirs.add(path);
    modes[path] = 0o755;
    mtimes[path] = mtimeMs;
  };

  const fs: FakeFs = {
    files,
    modes,
    dirs,
    writes,
    reads,
    renames,
    hooks,
    mtimes,
    exists,
    text: (path) => files[path],
    mode: (path) => modes[path],
    chmod(mode, path) {
      if (exists(path)) modes[path] = mode;
    },
    temps: () => writes.filter((w) => w.includes(".tmp")),
    async readText(path, maxBytes) {
      reads.push(path);
      await hooks.beforeRead?.(path);
      if (dirs.has(path)) throw fsError("EISDIR", path);
      if (!(path in files)) throw fsError("ENOENT", path);
      if (new TextEncoder().encode(files[path]).byteLength > maxBytes) throw fsError("EFBIG", path);
      const text = files[path];
      await hooks.afterRead?.(path, text);
      return text;
    },
    async writeText(path, text) {
      writes.push(path);
      await hooks.beforeWrite?.(path);
      files[path] = text;
      modes[path] = 0o644;
      mtimes[path] = NOW_MS;
    },
    async rename(from, to) {
      renames.push([from, to]);
      await hooks.beforeRename?.(from, to);
      if (!exists(from)) throw fsError("ENOENT", from);
      // As on POSIX (verified on nsh): a file is replaced; a non-empty directory is never replaced; an empty one is.
      if (to in files) {
        delete files[to];
        delete modes[to];
      }
      if (dirs.has(to)) {
        if (hasChildren(to)) throw fsError("ENOTEMPTY", to);
        dirs.delete(to);
        delete modes[to];
      }
      for (const p of Object.keys(files)) {
        if (!under(p, from)) continue;
        const next = to + p.slice(from.length);
        files[next] = files[p];
        modes[next] = modes[p];
        mtimes[next] = mtimes[p] ?? NOW_MS;
        delete files[p];
        delete modes[p];
      }
      for (const d of [...dirs]) {
        if (!under(d, from)) continue;
        dirs.delete(d);
        const next = to + d.slice(from.length);
        dirs.add(next);
        modes[next] = modes[d];
        mtimes[next] = mtimes[d];
      }
    },
    async mkdir(path) {
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current += `/${segment}`;
        if (!exists(current)) makeDir(current);
      }
    },
    async mkdirExclusive(path) {
      await hooks.beforeMkdirExclusive?.(path);
      if (exists(path)) return false;
      makeDir(path);
      return true;
    },
    async list(dir) {
      const names = [...Object.keys(files), ...dirs].filter((p) => parentOf(p) === dir);
      return names.map((p) => p.slice(dir.length + 1));
    },
    async unlink(path) {
      if (!(path in files)) throw fsError("ENOENT", path);
      delete files[path];
      delete modes[path];
    },
    async rmdir(path) {
      if (!dirs.has(path)) throw fsError("ENOENT", path);
      if (hasChildren(path)) throw fsError("ENOTEMPTY", path);
      dirs.delete(path);
      delete modes[path];
    },
    async stat(path): Promise<FileStat | null> {
      if (dirs.has(path)) return { kind: "dir", isDirectory: true, mode: modes[path], mtimeMs: mtimes[path] ?? NOW_MS };
      if (path in files) {
        const kind = kinds[path] ?? "file";
        return { kind, isDirectory: false, mode: modes[path], mtimeMs: mtimes[path] ?? NOW_MS };
      }
      return null;
    },
  };
  return fs;
}

/** Process runner fake. `chmod` applies, fails, reports success without changing anything, or hangs. */
function fakeRunner(state: FakeFs, behavior: "apply" | "fail" | "noop" | "hang", log: string[][]): ProcessRunner {
  return async (command, args) => {
    log.push([command, ...args]);
    if (command !== "chmod") return { code: 127 };
    if (behavior === "hang") return never();
    if (behavior === "fail") return { code: 1 };
    if (behavior === "apply") state.chmod(parseInt(args[0], 8), args[1]);
    return { code: 0 };
  };
}

const defaultReply = (url: string) => (url.includes("chatgpt.com") ? json(200, CODEX_USAGE) : json(200, CLAUDE_USAGE));

/** A reply that counts fetches in flight and can be held open. */
const counting = (state: { active: number; max: number }, gate?: Promise<void>) => async (url: string) => {
  state.active++;
  state.max = Math.max(state.max, state.active);
  if (gate) await gate;
  state.active--;
  return defaultReply(url);
};

interface WorldOptions {
  files?: Record<string, string>;
  dirs?: Record<string, DirSpec>;
  modes?: Record<string, number>;
  fileTimes?: Record<string, number>;
  kinds?: Record<string, "symlink" | "other">;
  hooks?: Hooks;
  reply?: (url: string, init: RequestInit) => Response | Promise<Response>;
  env?: Record<string, string | undefined>;
  /** `null` means HOME is not available. */
  home?: string | null;
  /** `null` means the host has no data directory. */
  dataDir?: string | null;
  now?: string;
  deadlineMs?: number;
  fs?: FakeFs;
  chmod?: "apply" | "fail" | "noop" | "hang";
  platform?: string;
}

/** Dependencies for one test, plus what the fake world saw: requests and processes. */
function world(options: WorldOptions = {}) {
  const fs =
    options.fs ??
    memoryFs({
      files: options.files ?? CREDS,
      dirs: options.dirs,
      modes: options.modes,
      fileTimes: options.fileTimes,
      kinds: options.kinds,
      hooks: options.hooks,
    });
  const calls: { url: string; headers: Record<string, string>; redirect: string | undefined; signal: AbortSignal | null | undefined }[] = [];
  const runs: string[][] = [];
  const reply = options.reply ?? defaultReply;
  const stampMs = Date.parse(options.now ?? NOW);
  const stampNew = async (path: string, op: () => Promise<unknown>) => {
    const existed = fs.exists(path);
    const result = await op();
    if (!existed && fs.exists(path)) fs.mtimes[path] = stampMs;
    return result;
  };
  const clocked: FakeFs = {
    ...fs,
    writeText: (path, text) => stampNew(path, () => fs.writeText(path, text)).then(() => undefined),
    mkdirExclusive: (path) => stampNew(path, () => fs.mkdirExclusive(path)) as Promise<boolean>,
    mkdir: async (path) => {
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current += `/${segment}`;
        await stampNew(current, () => fs.mkdir(current));
      }
    },
  };
  const deps: Partial<Deps> = {
    fs: clocked,
    fetch: async (url, init) => {
      calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect, signal: init.signal });
      return reply(url, init);
    },
    env: options.env ?? {},
    homeDir: options.home === undefined ? HOME : (options.home ?? undefined),
    dataDir: options.dataDir === undefined ? DATA : options.dataDir,
    now: () => new Date(options.now ?? NOW),
    deadlineMs: options.deadlineMs ?? 1000,
    run: fakeRunner(fs, options.chmod ?? "apply", runs),
    platform: options.platform ?? "linux",
  };
  return { deps, fs, calls, runs };
}

/** A provider file as the store writes it. */
function providerText(name: "codex" | "claude", value: Partial<ProviderSnapshot> = {}, writtenAt = "2026-11-07T09:00:00Z"): string {
  const base: ProviderSnapshot = {
    state: "fresh",
    last_success_at: "2026-11-07T09:00:00Z",
    windows: { primary: { label: "Session", used_percent: 42, reset_at: "2026-11-07T12:00:00Z", duration_seconds: 18000 }, secondary: null },
    error: null,
    expires_at: null,
  };
  return JSON.stringify({ schema_version: 1, provider: name, written_at: writtenAt, value: { ...base, ...value } });
}

/** The legacy combined snapshot.json, as the earlier single-file store wrote it. */
function legacySnapshot(overrides: Partial<Record<"codex" | "claude", Partial<ProviderSnapshot>>>): string {
  const base = (p: Partial<ProviderSnapshot>): ProviderSnapshot => ({
    state: "fresh",
    last_success_at: "2026-11-07T09:00:00Z",
    windows: { primary: { label: "Session", used_percent: 42, reset_at: "2026-11-07T12:00:00Z", duration_seconds: 18000 }, secondary: null },
    error: null,
    expires_at: null,
    ...p,
  });
  const snapshot: Snapshot = {
    schema_version: 1,
    generated_at: "2026-11-07T09:00:00Z",
    providers: { codex: base(overrides.codex ?? {}), claude: base(overrides.claude ?? {}) },
  };
  return JSON.stringify(snapshot);
}

/** Names of the committed versions of one provider in a fake file system (not temporary files). */
function versionsOf(fs: FakeFs, name: "codex" | "claude"): string[] {
  const pattern = name === "codex" ? CODEX_ANY : CLAUDE_ANY;
  return Object.keys(fs.files)
    .filter((p) => p.startsWith(`${DATA}/`))
    .map((p) => p.slice(DATA.length + 1))
    .filter((n) => pattern.test(n));
}

/** Leftover displaced or staging lock directories in a fake file system. */
function leftoversOf(fs: FakeFs): string[] {
  return [...fs.dirs].filter((d) => d.startsWith(`${DATA}/`) && LEFTOVER_ANY.test(d.slice(DATA.length + 1)));
}

async function until(cond: () => boolean, limitMs = 2000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > limitMs) throw new Error("condition not reached");
    await sleep(2);
  }
}

/** A deferred: a promise and the function that settles it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("provider response parsers", () => {
  test("Codex parser normalizes primary and secondary windows", () => {
    const windows = parseCodex(
      JSON.stringify({ rate_limit: { primary_window: { used_percent: 23, limit_window_seconds: 18000 }, secondary_window: { utilization: 55 } } }),
    );
    expect(windows.primary).toEqual({ label: "Session", used_percent: 23, reset_at: null, duration_seconds: 18000 });
    expect(windows.secondary).toEqual({ label: "Additional limit", used_percent: 55, reset_at: null, duration_seconds: null });
  });

  test("Claude parser names windows by length and fills their durations", () => {
    const windows = parseClaude('{"five_hour":{"utilization":12},"seven_day":{"utilization":34}}');
    expect(windows.primary).toEqual({ label: "5-hour", used_percent: 12, reset_at: null, duration_seconds: 18000 });
    expect(windows.secondary).toEqual({ label: "7-day", used_percent: 34, reset_at: null, duration_seconds: 604800 });
  });

  test("Codex numeric reset timestamp becomes UTC and invalid windows are rejected", () => {
    const windows = parseCodex(
      '{"rate_limit":{"primary_window":{"used_percent":25,"reset_at":1790812800},"secondary_window":{"used_percent":101}}}',
    );
    expect(windows.primary?.reset_at).toBe(EXP_2026_10_01);
    expect(windows.secondary).toBeNull();
  });

  test("a utilization outside 0..100 rejects the window even when used_percent is valid", () => {
    expect(parseWindow({ utilization: 150, used_percent: 10 }, "L", null)).toBeNull();
    expect(parseWindow({ utilization: -1 }, "L", null)).toBeNull();
  });

  test("a present resets_at wins over reset_at, even when it is null", () => {
    expect(parseWindow({ utilization: 1, resets_at: null, reset_at: "2026-11-08T00:00:00Z" }, "L", null)?.reset_at).toBeNull();
    expect(parseWindow({ utilization: 1, reset_at: "2026-11-08T00:00:00Z" }, "L", null)?.reset_at).toBe("2026-11-08T00:00:00Z");
  });

  test("a string reset is kept as given, and an invalid limit_window_seconds falls back", () => {
    expect(parseWindow({ utilization: 1, limit_window_seconds: 1.5 }, "L", 3600)?.duration_seconds).toBe(3600);
    expect(parseWindow({ utilization: 1, limit_window_seconds: 40000000 }, "L", 3600)?.duration_seconds).toBe(3600);
    expect(parseWindow({ utilization: 1, limit_window_seconds: 900 }, "L", 3600)?.duration_seconds).toBe(900);
  });

  test("a Codex body without rate_limit, or that is not JSON, is rejected", () => {
    expect(() => parseCodex("{}")).toThrow();
    expect(() => parseCodex("not json")).toThrow();
  });

  test("the saved snapshot reader ignores unknown fields from newer writers", () => {
    const bytes =
      '{"schema_version":1,"generated_at":"","future":{"x":1},"providers":{"codex":{"state":"fresh","expires_at":"2026-11-06T10:00:00Z","new_field":true,"windows":{}},"claude":{"state":"unavailable"}}}';
    const parsed = parseSnapshot(bytes);
    expect(parsed).not.toBeNull();
    expect(parsed?.providers.codex.expires_at).toBe("2026-11-06T10:00:00Z");
    expect(parsed?.providers.claude.state).toBe("unavailable");
  });

  test("the saved snapshot reader rejects other schema versions", () => {
    expect(parseSnapshot('{"schema_version":2,"providers":{}}')).toBeNull();
    expect(parseSnapshot("garbage")).toBeNull();
  });

  test("provider selection supports global and targeted refresh", () => {
    expect(parseSelection("all")).toBe("all");
    expect(parseSelection("codex")).toBe("codex");
    expect(parseSelection("claude")).toBe("claude");
    expect(() => parseSelection("unknown")).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("credential expiry", () => {
  test("Claude and Codex expiry come from credential fields without exposing the token", () => {
    expect(credentialExpiry(claudeAuth(), false)).toBe(EXP_2026_10_01);
    expect(credentialExpiry(codexAuth(), true)).toBe(EXP_2026_10_01);
  });

  test("a credential that records no expiry, or a token that is not a readable JWT, yields none", () => {
    expect(credentialExpiry(claudeAuth(CLAUDE_TOKEN, null), false)).toBeNull();
    expect(credentialExpiry(codexAuth("not-a-jwt"), true)).toBeNull();
    expect(credentialExpiry(codexAuth("a.!!!.c"), true)).toBeNull();
  });

  test("the access token is read only from its credential field", () => {
    expect(accessToken(JSON.parse(claudeAuth()), false)).toBe(CLAUDE_TOKEN);
    expect(accessToken(JSON.parse(codexAuth()), true)).toBe(CODEX_JWT);
    expect(accessToken(JSON.parse(claudeAuth("")), false)).toBeNull();
  });

  test("doctor expiry text is compact", () => {
    expect(remainingText(20 * 60)).toBe("20m");
    expect(remainingText(2 * 3600 + 14 * 60)).toBe("2h 14m");
    expect(remainingText(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(remainingText(30)).toBe("under 1m");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("CODEX_HOME and credential locations", () => {
  const codexOutside = "codex_home_outside_codex_dir";

  test("CODEX_HOME inside ~/.codex is read from there", async () => {
    const { deps, fs } = world({ env: { CODEX_HOME: `${HOME}/.codex/work` }, files: { [`${HOME}/.codex/work/auth.json`]: codexAuth() } });
    const provider = await fetchProvider("codex", deps);
    expect(provider.state).toBe("fresh");
    expect(fs.reads).toContain(`${HOME}/.codex/work/auth.json`);
  });

  test("CODEX_HOME outside ~/.codex is refused without reading it", async () => {
    const { deps, fs, calls } = world({ env: { CODEX_HOME: "/opt/codex" }, files: { "/opt/codex/auth.json": codexAuth() } });
    const provider = await fetchProvider("codex", deps);
    expect(provider.state).toBe("unavailable");
    expect(provider.error?.code).toBe("credentials_missing");
    expect(provider.error?.message).toContain("CODEX_HOME");
    expect(fs.reads).not.toContain("/opt/codex/auth.json");
    expect(calls).toHaveLength(0);
  });

  test("CODEX_HOME that escapes ~/.codex or is relative is refused", async () => {
    for (const env of [`${HOME}/.codex/../.ssh`, `${HOME}/.codexx`, "relative/dir", `${HOME}/.codex/./sub/../x`]) {
      const { deps, fs } = world({ env: { CODEX_HOME: env }, files: { [`${HOME}/.ssh/auth.json`]: codexAuth() } });
      const provider = await fetchProvider("codex", deps);
      expect(provider.error?.code).toBe("credentials_missing");
      expect(fs.reads).toHaveLength(0);
    }
  });

  test("CODEX_HOME is normalized before the read, and an empty one counts as unset", async () => {
    expect(credentialLocation(true, { env: { CODEX_HOME: `${HOME}/.codex/./work//` }, homeDir: HOME })).toEqual({ path: `${HOME}/.codex/work/auth.json` });
    expect(credentialLocation(true, { env: { CODEX_HOME: "" }, homeDir: HOME })).toEqual({ path: CODEX_PATH });
    expect(credentialLocation(true, { env: { CODEX_HOME: "/opt/x" }, homeDir: undefined })).toEqual({ problem: "home_unset" });
  });

  test("the Claude credential ignores CODEX_HOME", async () => {
    const { deps, fs } = world({ env: { CODEX_HOME: "/opt/codex" } });
    const provider = await fetchProvider("claude", deps);
    expect(provider.state).toBe("fresh");
    expect(fs.reads).toContain(CLAUDE_PATH);
  });

  test("doctor warns about a CODEX_HOME outside ~/.codex, and names the hint", async () => {
    const checks = await doctor(world({ env: { CODEX_HOME: "/opt/codex" } }).deps);
    expect(checks[1].status).toBe("warn");
    expect(checks[1].detail).toContain("CODEX_HOME points outside ~/.codex");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("error mapping", () => {
  test("HTTP statuses map to safe provider error categories", () => {
    expect(httpError(401).code).toBe("authentication_required");
    expect(httpError(403).code).toBe("access_denied");
    expect(httpError(429).code).toBe("rate_limited");
    expect(httpError(503).code).toBe("provider_server_error");
    expect(httpError(599).code).toBe("provider_server_error");
    expect(httpError(418).code).toBe("http_error");
  });

  test("an HTTP 401 fails the provider and keeps the expiry of its credential file", async () => {
    const { deps } = world({ reply: () => json(401, { error: "expired" }) });
    const provider = await fetchProvider("claude", deps);
    expect(provider.state).toBe("unavailable");
    expect(provider.error?.code).toBe("authentication_required");
    expect(provider.windows.primary).toBeNull();
    expect(provider.expires_at).toBe(EXP_2026_10_01);
  });

  test("an unexpected response body is response_invalid; one without usable windows too", async () => {
    expect((await fetchProvider("codex", world({ reply: () => json(200, "not json") }).deps)).error?.code).toBe("response_invalid");
    const empty = await fetchProvider("claude", world({ reply: () => json(200, { five_hour: { utilization: 150 } }) }).deps);
    expect(empty.error?.code).toBe("response_invalid");
    expect(empty.error?.message).toBe("Provider response contained no valid usage windows");
  });

  test("a response larger than the limit is refused while it streams", async () => {
    const huge = "x".repeat(MAX_RESPONSE_BYTES + 1);
    const provider = await fetchProvider("codex", world({ reply: () => json(200, huge) }).deps);
    expect(provider.error?.code).toBe("response_too_large");
  });

  test("a transport failure maps to network_error", async () => {
    const provider = await fetchProvider("codex", world({ reply: () => Promise.reject(new TypeError("fetch failed")) }).deps);
    expect(provider.error?.code).toBe("network_error");
    expect(provider.state).toBe("unavailable");
  });

  test("a stalled provider is cut off at the deadline as a timeout error", async () => {
    const stall = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const started = Date.now();
    await expect(fetchProvider("codex", world({ reply: stall, deadlineMs: 20 }).deps)).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the overall deadline is 35 seconds", () => {
    expect(FETCH_DEADLINE_MS).toBe(35000);
  });

  test("missing HOME fails with credentials_missing", async () => {
    const provider = await fetchProvider("codex", world({ home: null }).deps);
    expect(provider.error?.code).toBe("credentials_missing");
    expect(provider.error?.message).toBe("Credential file unavailable");
  });

  test("an unreadable credential file, an invalid one and one without a token each map to their own code", async () => {
    expect((await fetchProvider("codex", world({ files: {} }).deps)).error?.code).toBe("credentials_unavailable");
    expect((await fetchProvider("codex", world({ files: { [CODEX_PATH]: "{oops" } }).deps)).error?.code).toBe("credentials_invalid");
    const noToken = await fetchProvider("claude", world({ files: { [CLAUDE_PATH]: '{"claudeAiOauth":{"expiresAt":1790812800000}}' } }).deps);
    expect(noToken.error?.code).toBe("credentials_missing");
    expect(noToken.error?.message).toBe("Access token unavailable");
    expect(noToken.expires_at).toBe(EXP_2026_10_01);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("requests", () => {
  test("Codex uses the usage endpoint with the account header and no beta header", async () => {
    const { deps, calls } = world();
    const provider = await fetchProvider("codex", deps);
    expect(provider.state).toBe("fresh");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(calls[0].headers.authorization).toBe(`Bearer ${CODEX_JWT}`);
    expect(calls[0].headers["chatgpt-account-id"]).toBe("acct-1");
    expect(calls[0].headers["anthropic-beta"]).toBeUndefined();
    expect(calls[0].headers["user-agent"]).toBe("superbar/1.0");
    expect(calls[0].redirect).toBe("manual");
  });

  test("Claude uses the usage endpoint with the beta header and no account header", async () => {
    const { deps, calls } = world();
    await fetchProvider("claude", deps);
    expect(calls[0].url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(calls[0].headers.authorization).toBe(`Bearer ${CLAUDE_TOKEN}`);
    expect(calls[0].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(calls[0].headers["chatgpt-account-id"]).toBeUndefined();
  });

  test("a fresh Claude refresh records the window, its reset and the success time", async () => {
    const provider = await fetchProvider("claude", world().deps);
    expect(provider.state).toBe("fresh");
    expect(provider.last_success_at).toBe(NOW.replace(/\.\d+Z$/, "Z"));
    expect(provider.error).toBeNull();
    expect(provider.windows.primary).toEqual({ label: "5-hour", used_percent: 12, reset_at: "2026-11-07T14:00:00Z", duration_seconds: 18000 });
    expect(provider.windows.secondary).toEqual({ label: "7-day", used_percent: 34, reset_at: null, duration_seconds: 604800 });
    expect(provider.expires_at).toBe(EXP_2026_10_01);
  });

  test("no token value appears in the returned snapshot", async () => {
    const provider = await fetchProvider("codex", world().deps);
    const text = JSON.stringify(provider);
    expect(text).not.toContain(CODEX_JWT);
    expect(text).not.toContain(CLAUDE_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("carry-forward and fetchAll", () => {
  test("a failed refresh carries forward the last good usage and timestamp as stale", () => {
    const current: ProviderSnapshot = {
      state: "unavailable",
      last_success_at: null,
      windows: { primary: null, secondary: null },
      error: { code: "network_error", message: "Could not connect to provider" },
      expires_at: null,
    };
    const previous: ProviderSnapshot = {
      state: "fresh",
      last_success_at: "2026-10-31T10:00:00Z",
      windows: { primary: { label: "Session", used_percent: 42, reset_at: "2026-11-01T00:00:00Z", duration_seconds: null }, secondary: null },
      error: null,
      expires_at: null,
    };
    const result = carryForward(current, previous);
    expect(result.state).toBe("stale");
    expect(result.error?.code).toBe("network_error");
    expect(result.windows.primary?.used_percent).toBe(42);
    expect(result.windows.primary?.reset_at).toBe("2026-11-01T00:00:00Z");
    expect(result.last_success_at).toBe("2026-10-31T10:00:00Z");
  });

  test("carry-forward does nothing without a previous usable window, or for a fresh provider", () => {
    const failed: ProviderSnapshot = { state: "unavailable", last_success_at: null, windows: { primary: null, secondary: null }, error: null, expires_at: null };
    expect(carryForward(failed, failed).state).toBe("unavailable");
    expect(carryForward(failed, null).state).toBe("unavailable");
    const fresh: ProviderSnapshot = { ...failed, state: "fresh", windows: { primary: { label: "x", used_percent: 1, reset_at: null, duration_seconds: null }, secondary: null } };
    expect(carryForward(fresh, failed).state).toBe("fresh");
  });

  test("fetchAll fetches both providers in order and returns a snapshot without saving it", async () => {
    const { deps, calls, fs } = world();
    const snapshot = await fetchAll(deps);
    expect(snapshot.schema_version).toBe(1);
    expect(snapshot.providers.codex.state).toBe("fresh");
    expect(snapshot.providers.claude.state).toBe("fresh");
    expect(calls.map((c) => c.url)).toEqual(["https://chatgpt.com/backend-api/wham/usage", "https://api.anthropic.com/api/oauth/usage"]);
    expect(fs.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
const at = (hms: string) => `2026-11-07T${hms}Z`;
const msOf = (iso: string) => Date.parse(iso);

describe("the snapshot store: versioned files, never replaced", () => {
  test("refresh writes each provider as a new private version, and loadSnapshot reads both back", async () => {
    const w = world();
    expect((await refresh("all", w.deps)).status).toBe("ok");
    expect(versionsOf(w.fs, "codex")).toHaveLength(1);
    expect(versionsOf(w.fs, "claude")).toHaveLength(1);
    for (const n of [...versionsOf(w.fs, "codex"), ...versionsOf(w.fs, "claude")]) expect(w.fs.mode(`${DATA}/${n}`)).toBe(0o600);
    const loaded = await loadSnapshot(w.deps);
    expect(loaded?.providers.codex.state).toBe("fresh");
    expect(loaded?.providers.claude.state).toBe("fresh");
    expect(loaded?.generated_at).toBe(NOW);
    expect(w.fs.exists(LOCK)).toBe(false);
  });

  test("a failed provider is carried forward as stale from its newest valid version", async () => {
    const w = world({
      files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex") },
      reply: (url) => (url.includes("chatgpt.com") ? json(429, "{}") : json(200, CLAUDE_USAGE)),
    });
    const outcome = await refresh("all", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.snapshot.providers.codex.state).toBe("stale");
    expect(outcome.snapshot.providers.codex.error?.code).toBe("rate_limited");
    expect(outcome.snapshot.providers.codex.windows.primary?.used_percent).toBe(42);
    const loaded = await loadSnapshot(w.deps);
    expect(loaded?.providers.codex.state).toBe("stale");
    expect(loaded?.providers.claude.state).toBe("fresh");
  });

  test("a selective refresh writes only its own provider's versions, and the other provider's data is untouched", async () => {
    const claudeOld = claudeVersion(msOf(at("09:00:00")));
    const claudeText = providerText("claude", { windows: { primary: { label: "5-hour", used_percent: 77, reset_at: null, duration_seconds: 18000 }, secondary: null } });
    const w = world({ files: { ...CREDS, [claudeOld]: claudeText } });
    const outcome = await refresh("codex", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.snapshot.providers.claude.windows.primary?.used_percent).toBe(77);
    expect(w.fs.writes.some((p) => p.includes("snapshot.claude."))).toBe(false);
    expect(w.fs.text(claudeOld)).toBe(claudeText);
    expect(versionsOf(w.fs, "codex")).toHaveLength(1);
    expect(w.calls).toHaveLength(1);
  });

  test("refresh without a data directory fails before any request is made", async () => {
    const { deps, calls } = world({ dataDir: null });
    await expect(refresh("all", deps)).rejects.toMatchObject({ code: "data_dir_unavailable" });
    expect(calls).toHaveLength(0);
  });

  test("a corrupt newest version falls back to the next valid version, and corrupt files are skipped one by one", async () => {
    const good = codexVersion(msOf(at("09:00:00")));
    const corrupt = codexVersion(msOf(at("09:30:00")), "bad0");
    const w = world({ files: { ...CREDS, [good]: providerText("codex"), [corrupt]: "{not json" } });
    const loaded = await loadSnapshot(w.deps);
    expect(loaded?.providers.codex.state).toBe("fresh");
    expect(loaded?.providers.codex.last_success_at).toBe(at("09:00:00"));
    const doctored = await doctor(w.deps);
    expect(doctored[3].status).toBe("warn");
    expect(doctored[3].detail).toContain("1 ignored");
  });

  test("a version recorded later than the present does not win over a valid one", async () => {
    const valid = codexVersion(msOf(at("09:00:00")));
    const future = codexVersion(msOf(at("11:00:00")), "f00d");
    const w = world({ files: { ...CREDS, [valid]: providerText("codex"), [future]: providerText("codex", { last_success_at: at("11:00:00") }, at("11:00:00")) } });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
  });

  test("concurrent saves get distinct version names, and no name is ever written twice", async () => {
    const w = world();
    await refresh("codex", w.deps);
    await refresh("codex", w.deps);
    const names = versionsOf(w.fs, "codex");
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(new Set(w.fs.writes).size).toBe(w.fs.writes.length - w.fs.renames.length + new Set(w.fs.writes).size - new Set(w.fs.writes).size + 0 === 0 ? w.fs.writes.length : w.fs.writes.length);
  });

  test("a leftover temporary file of an interrupted save is swept only when old", async () => {
    const staleTemp = `${codexVersion(msOf(at("09:00:00")))}.00000000-0000-4000-8000-000000000000.tmp`;
    const freshTemp = `${claudeVersion(msOf(at("09:00:00")))}.11111111-1111-4111-8111-111111111111.tmp`;
    const w = world({
      files: { ...CREDS, [staleTemp]: "junk", [freshTemp]: "junk" },
      fileTimes: { [staleTemp]: NOW_MS - LOCK_STALE_MS - 60_000, [freshTemp]: NOW_MS },
    });
    expect((await refresh("all", w.deps)).status).toBe("ok");
    expect(w.fs.text(staleTemp)).toBeUndefined();
    expect(w.fs.text(freshTemp)).toBe("junk");
  });

  test("migration: the legacy snapshot.json is read once for carry-forward and is never written or deleted", async () => {
    const legacy = legacySnapshot({ codex: {} });
    const w = world({
      files: { ...CREDS, [LEGACY_FILE]: legacy },
      reply: (url) => (url.includes("chatgpt.com") ? json(429, "{}") : json(200, CLAUDE_USAGE)),
    });
    const outcome = await refresh("all", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.snapshot.providers.codex.state).toBe("stale");
    expect(outcome.snapshot.providers.codex.windows.primary?.used_percent).toBe(42);
    expect(outcome.snapshot.providers.claude.state).toBe("fresh");
    expect(w.fs.writes.some((p) => p === LEGACY_FILE)).toBe(false);
    expect(w.fs.text(LEGACY_FILE)).toBe(legacy);
  });

  test("loadSnapshot ignores the legacy snapshot.json until a refresh writes provider versions", async () => {
    const w = world({ files: { ...CREDS, [LEGACY_FILE]: legacySnapshot({}) } });
    expect(await loadSnapshot(w.deps)).toBeNull();
  });
});

describe("leftover lock directories", () => {
  test("displaced and staging lock directories are swept once older than the stale margin, and young ones are kept", async () => {
    const oldDir = `${DATA}/refresh.lock.stale-0000-1111`;
    const youngDir = `${DATA}/refresh.lock.new-2222-3333`;
    const w = world({
      files: CREDS,
      dirs: { [DATA]: { mode: 0o700 }, [oldDir]: { mode: 0o755, mtimeMs: NOW_MS - LOCK_STALE_MS - 60_000 }, [youngDir]: { mode: 0o755, mtimeMs: NOW_MS } },
    });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(w.fs.dirs.has(oldDir)).toBe(false);
    expect(w.fs.dirs.has(youngDir)).toBe(true);
  });
});

describe("hardening: malformed ranking fields never win on a guess", () => {
  test("a version with malformed recorded instants loses to a genuine success, even after a successful refresh", async () => {
    const bad = codexVersion(msOf(at("09:00:00")), "aaaa");
    const w = world({ files: { ...CREDS, [bad]: providerText("codex", { last_success_at: "zzzz" }, "zzzz") } });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(NOW);
    expect(w.fs.text(bad)).toBeUndefined(); // collection removes it as an untrusted regular file; it was never a success
  });

  test("a malformed last_success_at alone (valid written_at) never ranks above a genuine success", async () => {
    // written_at is valid and not in the future, so only the malformed ranking field can decide the outcome.
    const bad = codexVersion(msOf(at("09:30:00")), "bbbb");
    const w = world({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [bad]: providerText("codex", { last_success_at: "zzzz" }, at("09:30:00")) } });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
  });

  test("each malformed ranking field makes its version untrusted; the next valid version is used", async () => {
    const variants: Array<Partial<ProviderSnapshot> & { written?: string }> = [
      { last_success_at: "2026-13-45T00:00:00Z" },
      { last_success_at: "2026-11-07 10:00:00" },
      { last_success_at: "1999-12-31T23:59:59Z" },
      { last_success_at: "2101-01-01T00:00:00Z" },
      { last_success_at: 1790812800 as unknown as string },
      { last_success_at: "2026-02-30T10:00:00Z" },
      { written: "2026-02-30T10:00:00Z" },
      { written: "zzzz" },
    ];
    for (const variant of variants) {
      const bad = codexVersion(msOf(at("11:00:00")), "bbbb");
      const badText = providerText("codex", "written" in variant ? {} : { last_success_at: variant.last_success_at as string }, "written" in variant ? (variant.written as string) : at("11:00:00"));
      const w = world({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [bad]: badText } });
      expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
      expect((await doctor(w.deps))[3].status).toBe("warn");
    }
  });

  test("the numbers in file names are never used for ordering, and a huge or odd name cannot win", async () => {
    const w = world({
      files: {
        ...CREDS,
        [`${DATA}/snapshot.codex.99999999999999999999999999-aaaa.json`]: providerText("codex", { last_success_at: at("09:00:00") }, at("09:00:00")),
        [`${DATA}/snapshot.codex.1-bbbb.json`]: providerText("codex", { last_success_at: at("10:00:00") }, at("10:00:00")),
      },
    });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("10:00:00"));
  });

  test("garbage collection touches only exact-pattern regular files; sentinels with odd names survive", async () => {
    const sentinels = ["snapshot.codex.1e+21.json", "snapshot.codex.json", "snapshot.codex.NaN-aaaa.json", "snapshot.codex.-5-aaaa.json", "snapshot.codex.1.5-aaaa.json", "snapshot.codex.9-AAAA.json", "snapshot.codex.1-aaaa.json.bak"];
    const files: Record<string, string> = { ...CREDS };
    for (const n of sentinels) files[`${DATA}/${n}`] = `sentinel ${n}`;
    for (let i = 0; i < 5; i++) files[codexVersion(msOf(at(`09:0${i}:00`)), `${i}${i}7c`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    const w = world({ files });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    for (const n of sentinels) expect(w.fs.text(`${DATA}/${n}`)).toBe(`sentinel ${n}`);
    expect(versionsOf(w.fs, "codex")).toHaveLength(KEEP_VERSIONS);
  });
});

describe("hardening: entries that are not regular files are never read or removed", () => {
  test("a directory named like a version, with mode 0600, is skipped; a valid version still loads", async () => {
    const dirName = codexVersion(msOf(at("11:00:00")), "dddd");
    const w = world({
      files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex") },
      dirs: { [DATA]: { mode: 0o700 }, [dirName]: { mode: 0o600 } },
    });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
    expect(w.fs.reads).not.toContain(dirName);
    expect((await doctor(w.deps))[3].detail).toContain("1 ignored");
  });

  test("an injected EISDIR on the newest regular version falls back to the older valid one, and refresh still runs", async () => {
    const older = codexVersion(msOf(at("09:00:00")));
    const newer = codexVersion(msOf(at("10:30:00")), "eeee");
    const mem = memoryFs({ files: { ...CREDS, [older]: providerText("codex"), [newer]: providerText("codex", { last_success_at: at("10:30:00") }, at("10:30:00")) } });
    const eisdir: FakeFs = { ...mem, readText: async (path, maxBytes) => { if (path === newer) throw fsError("EISDIR", path); return mem.readText(path, maxBytes); } };
    const w = world({ fs: eisdir });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
    expect((await refresh("codex", w.deps)).status).toBe("ok");
  });

  test("a symbolic link named like a version is never followed, even when it would win", async () => {
    const link = codexVersion(msOf(at("11:00:00")), "1ab2");
    const w = world({
      files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [link]: providerText("codex", { last_success_at: at("11:00:00") }, at("11:00:00")), [`${DATA}/target.json`]: "target" },
      kinds: { [link]: "symlink" },
    });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
    expect(w.fs.reads).not.toContain(link);
    expect(w.fs.text(`${DATA}/target.json`)).toBe("target");
  });

  test("a FIFO-like entry named like a version is never read", async () => {
    const fifo = codexVersion(msOf(at("11:00:00")), "f1f0");
    const w = world({
      files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [fifo]: providerText("codex", { last_success_at: at("11:00:00") }, at("11:00:00")) },
      kinds: { [fifo]: "other" },
    });
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
    expect(w.fs.reads).not.toContain(fifo);
  });

  test("garbage collection never removes a directory or a symbolic link named like a version", async () => {
    const dirName = codexVersion(msOf(at("08:00:00")), "d1d1");
    const link = codexVersion(msOf(at("08:30:00")), "1ab1");
    const files: Record<string, string> = { ...CREDS, [link]: providerText("codex") };
    for (let i = 0; i < 4; i++) files[codexVersion(msOf(at(`09:0${i}:00`)), `${i}${i}6b`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    const w = world({ files, dirs: { [DATA]: { mode: 0o700 }, [dirName]: { mode: 0o600 } }, kinds: { [link]: "symlink" } });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(w.fs.dirs.has(dirName)).toBe(true);
    expect(w.fs.text(link)).toBeDefined();
  });

  test("one unreadable version never aborts a refresh or the load; a failed stat of one entry is the same", async () => {
    const bad = codexVersion(msOf(at("10:00:00")), "ba1d");
    const mem = memoryFs({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [bad]: providerText("codex", { last_success_at: at("10:00:00") }, at("10:00:00")) } });
    const denied: FakeFs = { ...mem, readText: async (path, maxBytes) => { if (path === bad) throw fsError("ERR_ACCESS_DENIED", path); return mem.readText(path, maxBytes); } };
    const w = world({ fs: denied });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect((await loadSnapshot(w.deps))?.providers.codex.state).toBe("fresh");
    const fresh = memoryFs({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex"), [bad]: providerText("codex", { last_success_at: at("10:00:00") }, at("10:00:00")) } });
    const statFails: FakeFs = { ...fresh, stat: async (path) => { if (path === bad) throw fsError("EIO", path); return fresh.stat(path); } };
    expect((await loadSnapshot(world({ fs: statFails }).deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
  });
});

describe("retention wording and the clock-rollback limitation", () => {
  test("doctor describes retention as policy, and warns when more files than the policy allows are present", async () => {
    const seven: Record<string, string> = { ...CREDS };
    for (let i = 0; i < 7; i++) seven[codexVersion(msOf(at(`09:0${i}:00`)), `${i}${i}e1`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    const behind = await doctor(world({ files: seven }).deps);
    expect(behind[3].status).toBe("warn");
    expect(behind[3].detail).toContain("retention policy keeps up to 3 valid versions (cleanup is best effort)");
    expect(behind[3].detail).toContain("cleanup has not kept up");
    const three: Record<string, string> = { ...CREDS };
    for (let i = 0; i < 3; i++) three[codexVersion(msOf(at(`09:0${i}:00`)), `${i}${i}5a`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    expect((await doctor(world({ files: three }).deps))[3].status).toBe("ok");
  });

  test("a clock rollback keeps a newer recorded success until time catches up (accepted limitation)", async () => {
    const w = world({ now: at("10:01:00") });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    const rolled = world({ fs: w.fs, now: at("10:00:00") });
    expect((await refresh("codex", rolled.deps)).status).toBe("ok");
    expect((await loadSnapshot(rolled.deps))?.providers.codex.last_success_at).toBe(at("10:01:00"));
  });

  test("a version recorded more than five minutes ahead of the present does not win", async () => {
    const w = world({ files: { ...CREDS, [codexVersion(msOf(at("10:10:00")))]: providerText("codex", { last_success_at: at("10:10:00") }, at("10:10:00")) } });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(NOW);
  });
});

describe("garbage collection: newest versions kept, only own names touched", () => {
  test("after a commit, the newest three versions are kept and the chosen one is never removed", async () => {
    const files: Record<string, string> = { ...CREDS };
    for (let i = 0; i < 6; i++) files[codexVersion(msOf(at(`09:0${i}:00`)), `a${i}aa`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    const w = world({ files });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(versionsOf(w.fs, "codex")).toHaveLength(KEEP_VERSIONS);
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(NOW);
  });

  test("collection touches only files of its own name pattern", async () => {
    const files: Record<string, string> = { ...CREDS, [LEGACY_FILE]: legacySnapshot({}), [`${DATA}/snapshot.codex.json`]: "old fixed name", [`${DATA}/snapshot.codex.notes.txt`]: "notes", [`${DATA}/other.json`]: "other" };
    for (let i = 0; i < 5; i++) files[codexVersion(msOf(at(`09:0${i}:00`)), `b${i}bb`)] = providerText("codex", { last_success_at: at(`09:0${i}:00`) }, at(`09:0${i}:00`));
    const w = world({ files });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(versionsOf(w.fs, "codex")).toHaveLength(KEEP_VERSIONS);
    expect(w.fs.text(LEGACY_FILE)).toBeDefined();
    expect(w.fs.text(`${DATA}/snapshot.codex.json`)).toBe("old fixed name");
    expect(w.fs.text(`${DATA}/snapshot.codex.notes.txt`)).toBe("notes");
    expect(w.fs.text(`${DATA}/other.json`)).toBe("other");
  });

  test("corrupt versions are removed by collection, and a valid newest version is never removed", async () => {
    const files: Record<string, string> = { ...CREDS, [codexVersion(msOf(at("09:50:00")), "c0ff")]: "garbage" };
    const w = world({ files });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(w.fs.text(`${DATA}/snapshot.codex.${msOf(at("09:50:00"))}-c0ff.json`)).toBeUndefined();
    expect((await loadSnapshot(w.deps))?.providers.codex.state).toBe("fresh");
  });
});

describe("a late rename can only add an old version", () => {
  test("Sol's late-rename repro: A's issued rename lands after B's newer success; the loaded snapshot is B's, and the late version is collected later", async () => {
    const shared = memoryFs({ files: CREDS });
    const issued = gate();
    const release = gate();
    let paused = false;
    shared.hooks.beforeRename = async (_from, to) => {
      if (!paused && CODEX_ANY.test(to.slice(DATA.length + 1))) {
        paused = true;
        issued.open(); // A's rename is issued and stalls
        await release.promise;
      }
    };
    const a = world({ fs: shared, now: at("10:00:00"), deadlineMs: 50 });
    const runA = refresh("codex", a.deps);
    await issued.promise;
    await expect(runA).rejects.toMatchObject({ code: "timeout" }); // A times out and releases its lock
    expect(shared.exists(LOCK)).toBe(false);
    const b = world({ fs: shared, now: at("10:00:10") });
    expect((await refresh("codex", b.deps)).status).toBe("ok");
    release.open(); // A's rename lands now, adding its older version
    await sleep(20);
    expect(versionsOf(shared, "codex")).toHaveLength(2);
    expect((await loadSnapshot(b.deps))?.providers.codex.last_success_at).toBe(at("10:00:10"));
    // Later commits collect the late version: after two more refreshes, the newest three remain and A's is gone.
    for (const t of ["10:00:20", "10:00:30"]) {
      expect((await refresh("codex", world({ fs: shared, now: at(t) }).deps)).status).toBe("ok");
    }
    expect(versionsOf(shared, "codex")).toHaveLength(KEEP_VERSIONS);
    expect(versionsOf(shared, "codex").some((n) => n.startsWith(`snapshot.codex.${msOf(at("10:00:00"))}-`))).toBe(false);
    expect((await loadSnapshot(b.deps))?.providers.codex.last_success_at).toBe(at("10:00:30"));
  });

  test("Sol's late-rename repro for a failed refresh: a late stale version never replaces a newer success", async () => {
    const shared = memoryFs({ files: CREDS });
    const first = world({ fs: shared, now: at("10:00:00") });
    expect((await refresh("codex", first.deps)).status).toBe("ok");
    const issued = gate();
    const release = gate();
    let paused = false;
    shared.hooks.beforeRename = async (_from, to) => {
      if (!paused && CODEX_ANY.test(to.slice(DATA.length + 1))) {
        paused = true;
        issued.open();
        await release.promise;
      }
    };
    const a = world({ fs: shared, now: at("10:00:05"), deadlineMs: 50, reply: (url) => (url.includes("chatgpt.com") ? json(429, "{}") : json(200, CLAUDE_USAGE)) });
    const runA = refresh("codex", a.deps);
    await issued.promise;
    await expect(runA).rejects.toMatchObject({ code: "timeout" });
    const b = world({ fs: shared, now: at("10:00:10") });
    expect((await refresh("codex", b.deps)).status).toBe("ok");
    release.open();
    await sleep(20);
    expect((await loadSnapshot(b.deps))?.providers.codex.state).toBe("fresh");
    expect((await loadSnapshot(b.deps))?.providers.codex.last_success_at).toBe(at("10:00:10"));
  });
});

describe("directory privacy is verified on read too", () => {
  test("a 0600 version under a 0777 directory is not trusted", async () => {
    const w = world({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex") }, dirs: { [DATA]: { mode: 0o777 } } });
    expect(await loadSnapshot(w.deps)).toBeNull();
    const checks = await doctor(w.deps);
    expect(checks[0].status).toBe("warn");
    expect(checks[3].status).toBe("warn");
    expect(checks[3].detail).toContain("not a private directory");
  });

  test("a refresh restores the directory to 0700 before saving, and then reads trust it again", async () => {
    const w = world({ files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex") }, dirs: { [DATA]: { mode: 0o777 } } });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(w.fs.mode(DATA)).toBe(0o700);
    expect((await loadSnapshot(w.deps))?.providers.codex.state).toBe("fresh");
  });
});

describe("the best-effort lock: busy while held, broken when stale", () => {
  test("a second refresh while one holds the lock is busy and makes no request; the next succeeds", async () => {
    const pending = gate();
    const w = world({ reply: async (url) => { await pending.promise; return defaultReply(url); } });
    const first = refresh("all", w.deps);
    const second = await refresh("all", w.deps);
    expect(second.status).toBe("busy");
    expect(w.calls).toHaveLength(1);
    pending.open();
    expect((await first).status).toBe("ok");
    expect((await refresh("all", w.deps)).status).toBe("ok");
  });

  test("a fresh lock, one whose start time is in the future, and one just inside the stale margin are all respected", async () => {
    for (const owner of [ownerFile("live-run", NOW_MS - 10_000), ownerFile("future-run", NOW_MS + 24 * 3600 * 1000), ownerFile("young-run", NOW_MS - (LOCK_STALE_MS - 1000))]) {
      const w = world({ files: { ...CREDS, [OWNER]: owner }, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755 } } });
      expect((await refresh("all", w.deps)).status).toBe("busy");
      expect(w.fs.text(OWNER)).toBe(owner);
      expect(w.calls).toHaveLength(0);
    }
  });

  test("a stale lock is broken and the refresh proceeds, leaving no lock, staging or displaced directory behind", async () => {
    const w = world({ files: { ...CREDS, [OWNER]: STALE_OWNER }, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755 } } });
    expect((await refresh("all", w.deps)).status).toBe("ok");
    expect(w.fs.exists(LOCK)).toBe(false);
    expect(w.fs.text(OWNER)).toBeUndefined();
    expect(leftoversOf(w.fs)).toHaveLength(0);
  });

  test("a lock with no readable owner ages from its directory time", async () => {
    const partial = { ...CREDS, [OWNER]: '{"token":' };
    const fresh = world({ files: partial, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755, mtimeMs: NOW_MS } } });
    expect((await refresh("all", fresh.deps)).status).toBe("busy");
    const old = world({ files: partial, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755, mtimeMs: NOW_MS - LOCK_STALE_MS - 60_000 } } });
    expect((await refresh("all", old.deps)).status).toBe("ok");
  });

  test("release leaves a lock whose owner is now another run", async () => {
    const pending = gate();
    const w = world({ reply: async (url) => { await pending.promise; return defaultReply(url); } });
    const run = refresh("all", w.deps);
    await until(() => w.fs.exists(OWNER));
    w.fs.files[OWNER] = ownerFile("someone-else", NOW_MS);
    pending.open();
    expect((await run).status).toBe("ok");
    expect(w.fs.exists(LOCK)).toBe(true);
    expect(w.fs.text(OWNER)).toBe(ownerFile("someone-else", NOW_MS));
  });

  test("a failed owner write leaves neither a lock nor a staging directory behind", async () => {
    const w = world({
      hooks: {
        beforeWrite: (path) => {
          if (path.includes(".new-") && path.endsWith("/owner.json")) throw fsError("EIO", path);
        },
      },
    });
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "EIO" });
    expect(w.fs.exists(LOCK)).toBe(false);
    expect(leftoversOf(w.fs)).toHaveLength(0);
  });
});

describe("races: no data is lost in any interleaving; overlap is possible and not bounded", () => {
  // Overlap is possible and, in theory, not bounded under crashed-owner and clock-step races. These tests assert what
  // the design does guarantee: each provider's newest success is stored, and no displaced lock directory is left behind.

  test("the reviewer's interleaving: B observes the lock stale and pauses; A replaces it and runs; B resumes and C attempts", async () => {
    const shared = memoryFs({ files: { ...CREDS, [OWNER]: STALE_OWNER }, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755 } } });
    const seen = { observed: false, aInFetch: false, moved: false };
    const bObserve = gate();
    const bResume = gate();
    const bMoved = gate();
    const bMovedResume = gate();
    // B pauses holding the stale owner it has just read: it is judged stale, then A replaces the lock.
    shared.hooks.afterRead = async (path) => {
      if (path === OWNER && !seen.observed) {
        seen.observed = true;
        bObserve.open();
        await bResume.promise;
      }
    };
    shared.hooks.beforeRead = async (path) => {
      if (seen.aInFetch && !seen.moved && path.includes(".stale-") && path.endsWith("/owner.json")) {
        seen.moved = true;
        bMoved.open();
        await bMovedResume.promise;
      }
    };
    const gA = gate();
    const gC = gate();
    const b = world({ fs: shared, now: LATER });
    const a = world({
      fs: shared,
      now: LATER,
      reply: async (url) => {
        seen.aInFetch = true;
        await gA.promise;
        return defaultReply(url);
      },
    });
    const runB = refresh("all", b.deps);
    await bObserve.promise;
    const runA = refresh("codex", a.deps);
    await until(() => a.calls.length === 1);
    bResume.open(); // B resumes: its rename moves A's live lock away
    await bMoved.promise;
    const c = world({
      fs: shared,
      now: LATER,
      reply: async (url) => {
        await gC.promise;
        return defaultReply(url);
      },
    });
    const runC = refresh("claude", c.deps);
    await until(() => c.calls.length === 1);
    bMovedResume.open(); // B finds A's owner, tries to put the lock back (C holds the path now), and gives up
    expect((await runB).status).toBe("busy");
    gA.open();
    gC.open();
    expect((await runA).status).toBe("ok");
    expect((await runC).status).toBe("ok");
    const loaded = await loadSnapshot(b.deps);
    expect(loaded?.providers.codex.last_success_at).toBe(LATER_S);
    expect(loaded?.providers.claude.last_success_at).toBe(LATER_S);
    expect(leftoversOf(shared)).toHaveLength(0);
    // After the dust settles, a much later refresh finds nothing to sweep.
    expect((await refresh("codex", world({ fs: shared, now: new Date(NOW_MS + 2 * LOCK_STALE_MS).toISOString() }).deps)).status).toBe("ok");
    expect(leftoversOf(shared)).toHaveLength(0);
  });

  test("a timed-out release resumes after its lock was replaced: no data is lost, and no displaced directory is left behind", async () => {
    const shared = memoryFs({ files: CREDS });
    const seen = { releasing: false, aRenamed: false, restoreCheck: false };
    const aAtRename = gate();
    const aRelease = gate();
    const aRestoreAtCheck = gate();
    const aRestoreGate = gate();
    shared.hooks.beforeRename = async (from) => {
      if (from === LOCK && !seen.releasing) {
        seen.releasing = true;
        aAtRename.open(); // A's release has checked that the lock is its own, and pauses before renaming it away
        await aRelease.promise;
        seen.aRenamed = true;
      }
    };
    shared.hooks.beforeRead = async (path) => {
      if (seen.aRenamed && !seen.restoreCheck && path.includes(".stale-") && path.endsWith("/owner.json")) {
        seen.restoreCheck = true;
        aRestoreAtCheck.open(); // A has moved the lock and pauses before checking whose it moved
        await aRestoreGate.promise;
      }
    };
    const gB = gate();
    const gC = gate();
    const a = world({ fs: shared, deadlineMs: 20, reply: () => never() });
    const runA = refresh("all", a.deps);
    await aAtRename.promise;
    const b = world({ fs: shared, now: LATER, reply: async (url) => { await gB.promise; return defaultReply(url); } });
    const runB = refresh("codex", b.deps);
    await until(() => b.calls.length === 1);
    aRelease.open(); // A's late rename now moves B's live lock
    await aRestoreAtCheck.promise;
    const c = world({ fs: shared, now: LATER, reply: async (url) => { await gC.promise; return defaultReply(url); } });
    const runC = refresh("claude", c.deps);
    await until(() => c.calls.length === 1);
    aRestoreGate.open(); // A finds B's owner, tries to put the lock back (fails: C holds the path), and discards it
    await expect(runA).rejects.toMatchObject({ code: "timeout" });
    expect(leftoversOf(shared)).toHaveLength(0);
    gB.open();
    gC.open();
    expect((await runB).status).toBe("ok");
    expect((await runC).status).toBe("ok");
    const loaded = await loadSnapshot(b.deps);
    expect(loaded?.providers.codex.last_success_at).toBe(LATER_S);
    expect(loaded?.providers.claude.last_success_at).toBe(LATER_S);
    expect((await refresh("codex", world({ fs: shared, now: new Date(NOW_MS + 2 * LOCK_STALE_MS).toISOString() }).deps)).status).toBe("ok");
    expect(leftoversOf(shared)).toHaveLength(0);
  });

  test("a displaced lock whose restore loses is discarded at once, not left for a later sweep", async () => {
    // B judges the stale lock and pauses. A replaces it and stays alive. B then displaces A's live lock. C takes the
    // vacant path. B's attempt to put A's lock back loses, and the displaced copy must be gone as soon as B returns.
    const shared = memoryFs({ files: { ...CREDS, [OWNER]: STALE_OWNER }, dirs: { [DATA]: { mode: 0o700 }, [LOCK]: { mode: 0o755 } } });
    const seen = { observed: false, aInFetch: false, moved: false };
    const bObserve = gate();
    const bResume = gate();
    const bMoved = gate();
    const bMovedResume = gate();
    shared.hooks.afterRead = async (path) => {
      if (path === OWNER && !seen.observed) {
        seen.observed = true;
        bObserve.open();
        await bResume.promise;
      }
    };
    shared.hooks.beforeRead = async (path) => {
      if (seen.aInFetch && !seen.moved && path.includes(".stale-") && path.endsWith("/owner.json")) {
        seen.moved = true;
        bMoved.open();
        await bMovedResume.promise;
      }
    };
    const gA = gate();
    const gC = gate();
    const b = world({ fs: shared, now: LATER });
    const a = world({ fs: shared, now: LATER, reply: async (url) => { seen.aInFetch = true; await gA.promise; return defaultReply(url); } });
    const runB = refresh("all", b.deps);
    await bObserve.promise;
    const runA = refresh("codex", a.deps);
    await until(() => a.calls.length === 1);
    bResume.open();
    await bMoved.promise; // B has displaced A's live lock and is about to judge it
    const c = world({ fs: shared, now: LATER, reply: async (url) => { await gC.promise; return defaultReply(url); } });
    const runC = refresh("claude", c.deps);
    await until(() => c.calls.length === 1);
    bMovedResume.open();
    expect((await runB).status).toBe("busy");
    expect(leftoversOf(shared)).toHaveLength(0); // discarded at once, before any sweep
    gA.open();
    gC.open();
    expect((await runA).status).toBe("ok");
    expect((await runC).status).toBe("ok");
  });
});

describe("privacy: the store is 0700 and each version file 0600, verified before saving", () => {
  test("modes are applied: the data directory 0700, each temporary file 0600 before its rename, each version 0600", async () => {
    const w = world();
    expect((await refresh("all", w.deps)).status).toBe("ok");
    expect(w.runs).toContainEqual(["chmod", "700", DATA]);
    const temps = w.fs.temps();
    expect(temps).toHaveLength(2);
    for (const temp of temps) expect(w.runs).toContainEqual(["chmod", "600", temp]);
    expect(w.fs.mode(DATA)).toBe(0o700);
    for (const n of versionsOf(w.fs, "codex")) expect(w.fs.mode(`${DATA}/${n}`)).toBe(0o600);
  });

  test("a chmod that fails stops the save: nothing is written, and the snapshot is returned in memory only", async () => {
    const w = world({ chmod: "fail" });
    const outcome = await refresh("all", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.storage?.error.code).toBe("storage_insecure");
    expect(outcome.storage?.persisted).toBe(false);
    expect(outcome.snapshot.providers.codex.state).toBe("fresh");
    expect(versionsOf(w.fs, "codex")).toHaveLength(0);
    expect(w.fs.temps()).toHaveLength(0);
  });

  test("a chmod that reports success but leaves the temporary file's mode unchanged is not persisted, and the file is removed", async () => {
    const w = world({ chmod: "noop", dirs: { [DATA]: { mode: 0o700 } } });
    const outcome = await refresh("all", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.storage?.error.code).toBe("storage_insecure");
    expect(versionsOf(w.fs, "codex")).toHaveLength(0);
    expect(Object.keys(w.fs.files).filter((p) => p.includes(".tmp"))).toHaveLength(0);
  });

  test("Windows skips chmod and does not check modes: the versions are saved", async () => {
    const w = world({ platform: "windows", chmod: "fail" });
    const outcome = await refresh("all", w.deps);
    if (outcome.status !== "ok") throw new Error("expected ok");
    expect(outcome.storage).toBeUndefined();
    expect(w.runs).toHaveLength(0);
    expect(versionsOf(w.fs, "codex")).toHaveLength(1);
  });

  test("loadSnapshot distrusts a version that is not private, and shows the other provider", async () => {
    const codexV = codexVersion(msOf(at("09:00:00")));
    const w = world({ files: { ...CREDS, [codexV]: providerText("codex"), [claudeVersion(msOf(at("09:00:00")))]: providerText("claude") }, modes: { [codexV]: 0o644 } });
    const loaded = await loadSnapshot(w.deps);
    expect(loaded?.providers.codex.error?.code).toBe("snapshot_untrusted");
    expect(loaded?.providers.claude.state).toBe("fresh");
  });

  test("loadSnapshot returns null when no version is trusted", async () => {
    const codexV = codexVersion(msOf(at("09:00:00")));
    const w = world({ files: { ...CREDS, [codexV]: providerText("codex") }, modes: { [codexV]: 0o644 } });
    expect(await loadSnapshot(w.deps)).toBeNull();
  });

  test("doctor reports the chosen version, the count and the modes", async () => {
    const v1 = codexVersion(msOf(at("09:00:00")));
    const v2 = codexVersion(msOf(at("09:30:00")), "2222");
    const open = await doctor(world({ dirs: { [DATA]: { mode: 0o755 } }, files: { ...CREDS, [v1]: providerText("codex"), [v2]: providerText("codex", { last_success_at: at("09:30:00") }, at("09:30:00")) } }).deps);
    expect(open[0].status).toBe("warn");
    expect(open[0].detail).toContain("0755");
    // In a directory that is not 0700 nothing is trusted, so the provider check reports that instead.
    expect(open[3].status).toBe("warn");
    expect(open[3].detail).toContain("not a private directory");
    const secure = await doctor(world({ dirs: { [DATA]: { mode: 0o700 } }, files: { ...CREDS, [v1]: providerText("codex"), [v2]: providerText("codex", { last_success_at: at("09:30:00") }, at("09:30:00")) } }).deps);
    expect(secure[0]).toEqual({ name: "data_dir", status: "ok", detail: `${DATA} is private (mode 0700)` });
    expect(secure[3].status).toBe("ok");
    expect(secure[3].detail).toContain(`chose the version written ${at("09:30:00")}`);
    expect(secure[3].detail).toContain("2 valid version(s)");
    expect(secure[3].detail).toContain("private (mode 0600)");
    expect(secure[4].status).toBe("ok");
    expect(secure[4].detail).toContain("no claude snapshot saved yet");
  });
});

describe("deadline: the whole refresh is bounded, and an abandoned run writes nothing", () => {
  test("a credential read that stalls past the deadline settles at the deadline, makes no request later, and releases the lock", async () => {
    const hooks: Hooks = { beforeRead: (path) => (path === CODEX_PATH ? sleep(80) : undefined) };
    const w = world({ hooks, deadlineMs: 5 });
    const started = Date.now();
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(60);
    expect(w.fs.exists(LOCK)).toBe(false);
    await sleep(150);
    expect(w.calls).toHaveLength(0);
    expect(versionsOf(w.fs, "codex")).toHaveLength(0);
  });

  test("a stalled version read settles at the deadline and releases the lock; the next refresh is not busy", async () => {
    const v = codexVersion(msOf(at("09:00:00")));
    const hooks: Hooks = { beforeRead: (path) => (path === v ? never() : undefined) };
    const w = world({ hooks, deadlineMs: 20, files: { ...CREDS, [v]: providerText("codex") } });
    const started = Date.now();
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(w.fs.exists(LOCK)).toBe(false);
    w.fs.hooks.beforeRead = undefined;
    expect((await refresh("all", w.deps)).status).toBe("ok");
  });

  test("a stalled write settles at the deadline, releases the lock, and the late write never becomes a version", async () => {
    const old = codexVersion(msOf(at("09:00:00")));
    const hooks: Hooks = { beforeWrite: (path) => (path.includes(".tmp") ? sleep(150) : undefined) };
    const w = world({ hooks, deadlineMs: 20, files: { ...CREDS, [old]: providerText("codex") } });
    await expect(refresh("codex", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(w.fs.exists(LOCK)).toBe(false);
    await sleep(250);
    expect(w.fs.temps()).toHaveLength(1); // the late write landed in its temporary file ...
    expect(w.fs.renames.some(([, to]) => CODEX_ANY.test(to.slice(DATA.length + 1)))).toBe(false); // ... and was never renamed to a version
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:00:00"));
  });

  test("a stalled chmod settles at the deadline, releases the lock, and saves nothing", async () => {
    const w = world({ chmod: "hang", deadlineMs: 20 });
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(w.fs.exists(LOCK)).toBe(false);
    expect(versionsOf(w.fs, "codex")).toHaveLength(0);
  });

  test("a stalled provider request settles the refresh at the deadline and releases the lock", async () => {
    const w = world({ reply: () => never(), deadlineMs: 20 });
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(w.fs.exists(LOCK)).toBe(false);
    expect(versionsOf(w.fs, "codex")).toHaveLength(0);
  });

  test("a stalled staging mkdir settles at the deadline, and no request is made", async () => {
    const w = world({ deadlineMs: 20, hooks: { beforeMkdirExclusive: (path) => (path.includes(".new-") ? never() : undefined) } });
    await expect(refresh("all", w.deps)).rejects.toMatchObject({ code: "timeout" });
    expect(w.calls).toHaveLength(0);
    expect(w.fs.exists(LOCK)).toBe(false);
  });
});

describe("loadSnapshot", () => {
  test("returns null without saved snapshots, and makes no provider request", async () => {
    const { deps, calls } = world({ files: CREDS });
    expect(await loadSnapshot(deps)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("replaces saved expiry with the live credential expiry, and keeps it when the file has none", async () => {
    const w = world({
      files: { [CODEX_PATH]: codexAuth(), [codexVersion(msOf(at("09:00:00")))]: providerText("codex", { expires_at: "2020-01-01T00:00:00Z" }), [claudeVersion(msOf(at("09:00:00")))]: providerText("claude", { expires_at: "2026-09-01T00:00:00Z" }) },
    });
    const snapshot = await loadSnapshot(w.deps);
    expect(snapshot?.providers.codex.expires_at).toBe(EXP_2026_10_01);
    expect(snapshot?.providers.claude.expires_at).toBe("2026-09-01T00:00:00Z");
    expect(w.calls).toHaveLength(0);
  });

  test("a snapshot is not loaded without a data directory", async () => {
    expect(await loadSnapshot(world({ dataDir: null }).deps)).toBeNull();
  });
});

describe("newest success wins for one provider", () => {
  test("an older successful result is stored as an extra version, and loadSnapshot still shows the newer stored success", async () => {
    let clock = at("09:59:30");
    const stored = codexVersion(msOf(at("09:59:40")));
    const w = world({ files: { ...CREDS, [stored]: providerText("codex", { last_success_at: at("09:59:40") }, at("09:59:40")) } });
    w.deps.now = () => new Date(clock);
    const originalRun = w.deps.run!;
    // The fetch completes at 09:59:30; the save runs at 09:59:45, after the newer success (09:59:40) was stored.
    w.deps.run = async (command, args) => {
      clock = at("09:59:45");
      return originalRun(command, args);
    };
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect(versionsOf(w.fs, "codex")).toHaveLength(2);
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:59:40"));
  });

  test("a stored success later than the present (a clock stepped back) does not freeze the store", async () => {
    const w = world({ files: { ...CREDS, [codexVersion(msOf(at("11:00:00")))]: providerText("codex", { last_success_at: at("11:00:00") }, at("11:00:00")) } });
    expect((await refresh("codex", w.deps)).status).toBe("ok");
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(NOW);
  });

  test("a failed refresh never hides a newer success stored meanwhile", async () => {
    const pending = gate();
    const w = world({
      files: { ...CREDS, [codexVersion(msOf(at("09:00:00")))]: providerText("codex") },
      reply: async (url) => {
        if (url.includes("chatgpt.com")) {
          await pending.promise;
          return json(429, "{}");
        }
        return json(200, CLAUDE_USAGE);
      },
    });
    const run = refresh("codex", w.deps);
    await until(() => w.calls.length === 1);
    // Meanwhile a newer successful refresh has stored a fresher codex version.
    w.fs.files[codexVersion(msOf(at("09:59:40")), "9999")] = providerText("codex", { last_success_at: at("09:59:40") }, at("09:59:40"));
    w.fs.modes[codexVersion(msOf(at("09:59:40")), "9999")] = 0o600;
    pending.open();
    expect((await run).status).toBe("ok");
    expect((await loadSnapshot(w.deps))?.providers.codex.last_success_at).toBe(at("09:59:40"));
  });
});

describe("runtime defaults", () => {
  test("default dependencies are built without touching the network or the disk", () => {
    const deps = defaultDeps();
    expect(deps.deadlineMs).toBe(FETCH_DEADLINE_MS);
    expect(typeof deps.fetch).toBe("function");
    expect(typeof deps.run).toBe("function");
    expect(typeof deps.platform).toBe("string");
  });
});
