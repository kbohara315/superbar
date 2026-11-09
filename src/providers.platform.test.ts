// Providers on Windows and macOS: where the credential files are, how CODEX_HOME is judged, how the home directory is
// found, how paths under the data folder are written, and how the refresh lock behaves where Windows refuses a rename
// of a directory onto an existing one with "access denied". All of it is checked against fakes using nsh's platform
// names ("windows", "macos", "linux"); none of it ran on a real Windows or macOS host.

import { expect, test } from "nsh/test";
import { childPath, credentialLocation, homeDirectory, LOCK_NAME, refresh } from "./providers";
import type { Deps, FileStat } from "./providers";

const WIN_HOME = "C:\\Users\\me";
const MAC_HOME = "/Users/me";

test("windows: the credential files are under the drive home, written with backslashes", () => {
    const deps = { env: {}, homeDir: WIN_HOME, platform: "windows" };
    expect(credentialLocation(true, deps)).toEqual({ path: "C:\\Users\\me\\.codex\\auth.json" });
    expect(credentialLocation(false, deps)).toEqual({ path: "C:\\Users\\me\\.claude\\.credentials.json" });
});

test("windows: a home written with slashes, with a trailing slash, or in the verbatim form gives the same files", () => {
    for (const home of ["C:/Users/me", "C:\\Users\\me\\", "\\\\?\\C:\\Users\\me", "c:\\Users\\me"]) {
        const found = credentialLocation(true, { env: {}, homeDir: home, platform: "windows" });
        expect(found).toEqual({ path: `${home.toLowerCase().startsWith("c:") ? home.slice(0, 2) : "C:"}\\Users\\me\\.codex\\auth.json` });
    }
});

test("windows: a share home works, and a rooted or drive-relative home is not a home", () => {
    expect(credentialLocation(false, { env: {}, homeDir: "\\\\srv\\users\\me", platform: "windows" })).toEqual({
        path: "\\\\srv\\users\\me\\.claude\\.credentials.json",
    });
    expect(credentialLocation(false, { env: {}, homeDir: "\\\\?\\UNC\\srv\\users\\me", platform: "windows" })).toEqual({
        path: "\\\\srv\\users\\me\\.claude\\.credentials.json",
    });
    for (const home of ["\\Users\\me", "C:Users", "/Users/me", "Users\\me", "C:\\Users\\..\\x", "\\\\srv", "C:", "c:", "\\\\?\\C:"]) {
        expect(credentialLocation(true, { env: {}, homeDir: home, platform: "windows" })).toEqual({ problem: "home_unset" });
    }
});

test("windows: CODEX_HOME inside ~/.codex is used (case-blind, either separator); outside or with .. is refused", () => {
    const at = (value: string) => credentialLocation(true, { env: { CODEX_HOME: value }, homeDir: WIN_HOME, platform: "windows" });
    expect(at("C:\\Users\\me\\.codex")).toEqual({ path: "C:\\Users\\me\\.codex\\auth.json" });
    expect(at("c:/users/ME/.CODEX/work/")).toEqual({ path: "c:\\users\\ME\\.CODEX\\work\\auth.json" });
    expect(at("\\\\?\\C:\\Users\\me\\.codex\\work")).toEqual({ path: "C:\\Users\\me\\.codex\\work\\auth.json" });
    for (const outside of ["D:\\codex", "C:\\Users\\me\\.codexx", "C:\\Users\\me", "C:\\Users\\other\\.codex", "C:\\Users\\me\\.codex\\..\\x", ".codex", "/Users/me/.codex"]) {
        expect(at(outside)).toEqual({ problem: "codex_home_outside_codex_dir" });
    }
    // An empty CODEX_HOME is unset.
    expect(at("")).toEqual({ path: "C:\\Users\\me\\.codex\\auth.json" });
});

test("windows: CODEX_HOME spellings Windows reads differently are refused; ordinary names, verbatim and share forms still work", () => {
  const at = (value: string, homeDir = WIN_HOME) => credentialLocation(true, { env: { CODEX_HOME: value }, homeDir, platform: "windows" });
  const refused = { problem: "codex_home_outside_codex_dir" };
  const under = "C:\\Users\\me\\.codex\\";
  for (const bad of [
    `${under}work:stream`, // an alternate data stream
    `${under}work::$DATA`,
    `${under}work.`, // Windows drops a trailing dot or space, so this names `work`
    `${under}work `,
    `${under}work...`,
    `${under}CON`, // reserved device names, with or without an extension, any case
    `${under}nul.txt`,
    `${under}Com1`,
    `${under}CONIN$`, // the console input and output devices
    `${under}conout$`,
    `${under}ConOut$.log`,
    `${under}x\\LPT9.log\\y`,
    `${under}a<b`,
    `${under}a|b`,
    `${under}what?`,
    `${under}star*`,
    `${under}q"uote`,
    `${under}ctl\u0001`,
    "\\\\.\\C:\\Users\\me\\.codex", // the device namespace
    "\\\\.\\UNC\\srv\\users\\me\\.codex",
    "\\\\?\\GLOBALROOT\\Device\\x\\Users\\me\\.codex",
    "\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\Users\\me\\.codex",
    "\\\\?\\UNC\\.\\C:\\Users\\me\\.codex",
    "C:\\Users\\me\\.codex\\work\\..\\..\\x",
  ]) {
    expect(at(bad)).toEqual(refused);
  }
  // Valid forms are kept (names that merely contain dots, spaces or device-like words).
  for (const good of ["work.v2", "my project", "console", "com10", "a.b.c", ".hidden", "auxiliary", "nul-x", "conin", "conin$x", "xconout$"]) {
    expect(at(`${under}${good}`)).toEqual({ path: `${under}${good}\\auth.json` });
  }
  expect(at("\\\\?\\C:\\Users\\me\\.codex\\w v2")).toEqual({ path: "C:\\Users\\me\\.codex\\w v2\\auth.json" });
  const shareHome = "\\\\srv\\users$\\me";
  expect(at("\\\\srv\\users$\\me\\.codex\\w", shareHome)).toEqual({ path: "\\\\srv\\users$\\me\\.codex\\w\\auth.json" });
  expect(at("\\\\?\\UNC\\srv\\users$\\me\\.codex", shareHome)).toEqual({ path: "\\\\srv\\users$\\me\\.codex\\auth.json" });
  // The home itself is not screened (it is the host's own answer); the device namespace is never a home.
  // A drive root is a fine home (`C:\\`, `C:/`); a bare drive is the drive's current directory, which is no fixed place.
  expect(credentialLocation(false, { env: {}, homeDir: "C:\\", platform: "windows" })).toEqual({ path: "C:\\.claude\\.credentials.json" });
  expect(credentialLocation(true, { env: { CODEX_HOME: "C:" }, homeDir: WIN_HOME, platform: "windows" })).toEqual(refused);
  expect(credentialLocation(false, { env: {}, homeDir: "\\\\.\\C:\\Users\\me", platform: "windows" })).toEqual({ problem: "home_unset" });
  expect(credentialLocation(false, { env: {}, homeDir: "C:\\Users\\me.", platform: "windows" })).toEqual({
    path: "C:\\Users\\me.\\.claude\\.credentials.json",
  });
});

test("posix: the Windows screen does not apply: a colon or a trailing dot in a CODEX_HOME name is a plain name", () => {
  const at = (value: string) => credentialLocation(true, { env: { CODEX_HOME: value }, homeDir: MAC_HOME, platform: "macos" });
  expect(at("/Users/me/.codex/a:b")).toEqual({ path: "/Users/me/.codex/a:b/auth.json" });
  expect(at("/Users/me/.codex/w.")).toEqual({ path: "/Users/me/.codex/w./auth.json" });
  expect(at("/Users/me/.codex/CON")).toEqual({ path: "/Users/me/.codex/CON/auth.json" });
  expect(credentialLocation(true, { env: { CODEX_HOME: "/home/me/.codex/x?" }, homeDir: "/home/me" })).toEqual({ path: "/home/me/.codex/x?/auth.json" });
});

test("windows: the environment variable's name is matched without regard to case, as Windows does; elsewhere it is exact", () => {
    const home = "C:\\Users\\me\\.codex\\work";
    expect(credentialLocation(true, { env: { Codex_Home: home }, homeDir: WIN_HOME, platform: "windows" })).toEqual({ path: `${home}\\auth.json` });
    expect(credentialLocation(true, { env: { Codex_Home: "/Users/me/.codex/work" }, homeDir: MAC_HOME, platform: "macos" })).toEqual({
        path: "/Users/me/.codex/auth.json",
    });
});

test("macos: the files are under /Users/<name>; CODEX_HOME must be inside ~/.codex, compared exactly", () => {
    const at = (value?: string) => credentialLocation(true, { env: value === undefined ? {} : { CODEX_HOME: value }, homeDir: MAC_HOME, platform: "macos" });
    expect(at()).toEqual({ path: "/Users/me/.codex/auth.json" });
    expect(credentialLocation(false, { env: {}, homeDir: MAC_HOME, platform: "macos" })).toEqual({ path: "/Users/me/.claude/.credentials.json" });
    expect(at("/Users/me/.codex/work//")).toEqual({ path: "/Users/me/.codex/work/auth.json" });
    expect(at("/Users/me/.Codex")).toEqual({ problem: "codex_home_outside_codex_dir" });
    expect(at("/Users/me")).toEqual({ problem: "codex_home_outside_codex_dir" });
    expect(at("/Users/me/.codex/../x")).toEqual({ problem: "codex_home_outside_codex_dir" });
    expect(at("C:\\Users\\me\\.codex")).toEqual({ problem: "codex_home_outside_codex_dir" });
});

test("without a platform the POSIX rules apply, as on Linux (the original behaviour)", () => {
    expect(credentialLocation(true, { env: {}, homeDir: "/home/me" })).toEqual({ path: "/home/me/.codex/auth.json" });
    expect(credentialLocation(true, { env: {}, homeDir: "/" })).toEqual({ path: "/.codex/auth.json" });
    expect(credentialLocation(true, { env: {}, homeDir: WIN_HOME })).toEqual({ problem: "home_unset" });
});

test("the home directory is the host's own first, then HOME, then USERPROFILE", () => {
    const env = { HOME: "/from/home", USERPROFILE: "C:\\from\\profile" };
    expect(homeDirectory(env, () => "/host/home")).toBe("/host/home");
    const none = () => {
        throw new Error("no home configured");
    };
    expect(homeDirectory(env, none)).toBe("/from/home");
    expect(homeDirectory({ USERPROFILE: env.USERPROFILE }, none)).toBe("C:\\from\\profile");
    expect(homeDirectory({ HOME: "" }, () => "")).toBeUndefined();
    expect(homeDirectory({}, none)).toBeUndefined();
});

test("child paths: POSIX joins with /; Windows keeps the folder's own separator, and a verbatim folder never gets a /", () => {
    expect(childPath("/data", "a.json", "linux")).toBe("/data/a.json");
    expect(childPath("/Users/me/Library/Application Support/x", "a.json", "macos")).toBe("/Users/me/Library/Application Support/x/a.json");
    expect(childPath("C:\\data", "a.json", "windows")).toBe("C:\\data\\a.json");
    expect(childPath("C:\\data\\", "a.json", "windows")).toBe("C:\\data\\a.json");
    expect(childPath("\\\\?\\C:\\data", "a.json", "windows")).toBe("\\\\?\\C:\\data\\a.json");
    expect(childPath("C:/data", "a.json", "windows")).toBe("C:/data/a.json");
});

// ----- the lock on Windows ----------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-11-09T10:00:00Z");
const DATA = "C:\\data";

// A directory-and-file fake with backslash paths. `windowsRename`: renaming a directory onto an existing entry fails
// with EACCES, as Windows does (POSIX would fail with ENOTEMPTY or EEXIST).
function windowsFs(
  options: {
    lock?: "fresh" | "stale";
    /** A lock directory that has no owner file (broken), instead of one with an owner. */
    unowned?: boolean;
    refuseRename?: boolean;
    /** An error to throw from a rename (before it is tried), or null. */
    failRename?: (from: string, to: string) => Error | null;
    /** An error to throw from mkdirExclusive / writeText for a path under the lock's staging name, or null. */
    failMkdirExclusive?: (path: string) => Error | null;
    failWrite?: (path: string) => Error | null;
    /**
     * A rename that is still in flight: when it returns a promise, the rename takes effect only once that settles (a
     * rejection fails it). Until then Windows keeps the source in use: removing or writing under it is a sharing violation.
     */
    hangRename?: (from: string, to: string) => Promise<void> | null;
    /** The data folder and its separator: the Windows default, or a POSIX folder. */
    posix?: boolean;
  } = {},
) {
  const data = options.posix ? "/data" : DATA;
  const sep = options.posix ? "/" : "\\";
  const entries = new Map<string, { kind: "dir" | "file"; text?: string; mtimeMs: number }>();
  const renames: string[] = [];
  const inFlight = new Set<string>();
  const inUse = (path: string) => [...inFlight].some((from) => path === from || path.startsWith(`${from}${sep}`));
  entries.set(data, { kind: "dir", mtimeMs: NOW });
  if (options.lock) {
    const started = options.lock === "fresh" ? NOW - 1000 : NOW - 10 * 60_000;
    entries.set(`${data}${sep}${LOCK_NAME}`, { kind: "dir", mtimeMs: started });
    if (!options.unowned) {
      entries.set(`${data}${sep}${LOCK_NAME}\\owner.json`, { kind: "file", text: JSON.stringify({ token: "other", started }), mtimeMs: started });
    }
  }
  const fail = (code: string, path: string) => Object.assign(new Error(`${code} ${path}`), { code });
  const stat = (path: string): FileStat | null => {
    const entry = entries.get(path);
    return entry ? { kind: entry.kind, isDirectory: entry.kind === "dir", mode: 0o666, mtimeMs: entry.mtimeMs } : null;
  };
  const fs: Deps["fs"] = {
    async readText(path) {
      const entry = entries.get(path);
      if (!entry || entry.kind !== "file") throw fail("ENOENT", path);
      return entry.text ?? "";
    },
    async writeText(path, text) {
      if (inUse(path)) throw new Error("The process cannot access the file because it is being used by another process. (os error 32)");
      const failure = options.failWrite?.(path);
      if (failure) throw failure;
      entries.set(path, { kind: "file", text, mtimeMs: NOW });
    },
    async rename(from, to) {
      renames.push(`${from} -> ${to}`);
      const failure = options.failRename?.(from, to);
      if (failure) throw failure;
      const gate = options.hangRename?.(from, to);
      if (gate) {
        inFlight.add(from);
        try {
          await gate;
        } finally {
          inFlight.delete(from);
        }
      }
      const entry = entries.get(from);
      if (!entry) throw fail("ENOENT", from);
      if (options.refuseRename || entries.has(to)) throw fail("EACCES", to);
      for (const key of [...entries.keys()]) {
        if (key === from || key.startsWith(`${from}${sep}`)) {
          entries.set(`${to}${key.slice(from.length)}`, entries.get(key)!);
          entries.delete(key);
        }
      }
    },
    async mkdir(path) {
      if (!entries.has(path)) entries.set(path, { kind: "dir", mtimeMs: NOW });
    },
    async mkdirExclusive(path) {
      const failure = options.failMkdirExclusive?.(path);
      if (failure) throw failure;
      if (entries.has(path)) return false;
      entries.set(path, { kind: "dir", mtimeMs: NOW });
      return true;
    },
    async list(dir) {
      const prefix = `${dir}${sep}`;
      return [...entries.keys()].filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes(sep)).map(key => key.slice(prefix.length));
    },
    async unlink(path) {
      if (inUse(path)) throw new Error("The process cannot access the file because it is being used by another process. (os error 32)");
      if (!entries.delete(path)) throw fail("ENOENT", path);
    },
    async rmdir(path) {
      if (inUse(path)) throw new Error("The process cannot access the file because it is being used by another process. (os error 32)");
      entries.delete(path);
    },
    async stat(path) {
      return stat(path);
    },
  };
  return { fs, entries, renames, data };
}

function windowsDeps(fs: Deps["fs"], requests: string[], sleeps?: number[], dataDir: string = DATA): Partial<Deps> {
  return {
    sleep: async (ms) => {
      sleeps?.push(ms);
    },
    fs,
    fetch: async url => {
      requests.push(url);
      throw new Error("no network in this test");
    },
    env: {},
    homeDir: WIN_HOME,
    dataDir,
    now: () => new Date(NOW),
    deadlineMs: 1000,
    run: async () => ({ code: 127 }),
    platform: "windows",
  };
}

test("windows: a fresh lock held by another run is busy, not an error, although the rename says access denied", async () => {
  const world = windowsFs({ lock: "fresh" });
  const requests: string[] = [];
  const outcome = await refresh("all", windowsDeps(world.fs, requests));
  expect(outcome).toEqual({ status: "busy" });
  expect(requests).toEqual([]);
  // The foreign lock is untouched and this run left no staging directory.
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}\\owner.json`)).toBe(true);
  expect([...world.entries.keys()].some(key => key.includes(".new-"))).toBe(false);
});

test("windows: a stale lock is broken and refresh goes on to make its requests", async () => {
  const world = windowsFs({ lock: "stale" });
  const requests: string[] = [];
  const outcome = await refresh("all", windowsDeps(world.fs, requests));
  expect(outcome.status).toBe("ok");
  expect(requests).toEqual([]); // no credential files in this world, so no request, but the lock was won
  // The lock is released again, and every path was written with backslashes.
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false);
  expect(world.renames.every(entry => !entry.includes("/"))).toBe(true);
});

test("windows: an access-denied rename with no lock in place is a real failure, not a silent busy", async () => {
  const world = windowsFs({ refuseRename: true });
  const failed = await refresh("all", windowsDeps(world.fs, [])).then(() => false, () => true);
  expect(failed).toBe(true);
  expect([...world.entries.keys()].some(key => key.includes(".new-"))).toBe(false);
});

test("linux: an access-denied rename of the lock is an error as before (only Windows reads it as a possible held lock)", async () => {
  const world = windowsFs({ refuseRename: true });
  const failed = await refresh("all", { ...windowsDeps(world.fs, []), platform: "linux" }).then(() => false, () => true);
  expect(failed).toBe(true);
});

// ----- the lock: broken versus absent, and EACCES from the other steps ------------------------------------------------

const denied = (what: string) => Object.assign(new Error(`${what}: access denied`), { code: "EACCES" });
const isStaging = (path: string) => path.includes(`${LOCK_NAME}.new-`);

test("windows: a fresh lock that has no owner file is held (busy); an old one is broken like a stale lock", async () => {
  const fresh = windowsFs({ lock: "fresh", unowned: true });
  expect(await refresh("all", windowsDeps(fresh.fs, []))).toEqual({ status: "busy" });
  expect(fresh.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(true);

  const old = windowsFs({ lock: "stale", unowned: true });
  expect((await refresh("all", windowsDeps(old.fs, []))).status).toBe("ok");
  expect(old.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false); // broken, taken, and released again
  expect([...old.entries.keys()].some((key) => key.includes(".stale-") || key.includes(".new-"))).toBe(false);
});

test("windows: access denied when taking the lock is busy only if a lock is really there, for the rename, mkdir and write alike", async () => {
  const cases: Record<string, Partial<Parameters<typeof windowsFs>[0]>> = {
    rename: { refuseRename: true },
    mkdir: { failMkdirExclusive: (path) => (isStaging(path) ? denied("mkdir") : null) },
    write: { failWrite: (path) => (isStaging(path) ? denied("write") : null) },
  };
  for (const failing of Object.values(cases)) {
    // A lock is there: this run lost the race for it.
    const held = windowsFs({ lock: "fresh", ...failing });
    expect(await refresh("all", windowsDeps(held.fs, []))).toEqual({ status: "busy" });
    expect(held.entries.has(`${DATA}\\${LOCK_NAME}\\owner.json`)).toBe(true);
    expect([...held.entries.keys()].some((key) => key.includes(".new-"))).toBe(false);

    // No lock: the denial is a real failure, with the staging directory removed, and the EACCES is what the caller sees.
    const none = windowsFs({ ...failing });
    const failure = await refresh("all", windowsDeps(none.fs, [])).then(() => null, (error: unknown) => error);
    expect((failure as { code?: string } | null)?.code).toBe("EACCES");
    expect([...none.entries.keys()].some((key) => key.includes(".new-"))).toBe(false);
    expect(none.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false);
  }
});

test("linux: access denied from the mkdir or the write of the lock is an error even when a lock is there", async () => {
  for (const failing of [
    { failMkdirExclusive: (path: string) => (isStaging(path) ? denied("mkdir") : null) },
    { failWrite: (path: string) => (isStaging(path) ? denied("write") : null) },
  ]) {
    const world = windowsFs({ lock: "fresh", ...failing });
    const failure = await refresh("all", { ...windowsDeps(world.fs, []), platform: "linux" }).then(() => null, (error: unknown) => error);
    expect((failure as { code?: string } | null)?.code).toBe("EACCES");
  }
});

// ----- releasing the lock ----------------------------------------------------------------------------------------------

const isRelease = (from: string, to: string) => from.endsWith(`${LOCK_NAME}`) && to.includes(`${LOCK_NAME}.stale-`);
const sharing = () => new Error("The process cannot access the file because it is being used by another process. (os error 32)");

test("windows: releasing the lock retries a sharing violation (no error code) with short waits, then the lock is gone", async () => {
  let refused = 0;
  const world = windowsFs({ failRename: (from, to) => (isRelease(from, to) && refused++ < 2 ? sharing() : null) });
  const sleeps: number[] = [];
  expect((await refresh("all", windowsDeps(world.fs, [], sleeps))).status).toBe("ok");
  expect(refused).toBe(3); // refused twice, then it went through
  expect(sleeps).toEqual([25, 50]);
  expect([...world.entries.keys()].filter((key) => key.includes(LOCK_NAME))).toEqual([]);
});

test("windows: releasing the lock retries EPERM, EACCES and EBUSY too", async () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    let refused = 0;
    const world = windowsFs({ failRename: (from, to) => (isRelease(from, to) && refused++ < 1 ? Object.assign(new Error(code), { code }) : null) });
    const sleeps: number[] = [];
    await refresh("all", windowsDeps(world.fs, [], sleeps));
    expect(sleeps).toEqual([25]);
    expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false);
  }
});

test("windows: a release that keeps being refused gives up after the bounded retries without failing the refresh, leaving the lock to the stale rule", async () => {
  let attempts = 0;
  const world = windowsFs({
    failRename: (from, to) => {
      if (!isRelease(from, to)) return null;
      attempts++;
      return sharing();
    },
  });
  const sleeps: number[] = [];
  const outcome = await refresh("all", windowsDeps(world.fs, [], sleeps));
  expect(outcome.status).toBe("ok");
  expect(attempts).toBe(5);
  expect(sleeps).toEqual([25, 50, 100, 200]);
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(true); // still ours, and fresh: a later run reports busy until it goes stale
  expect(await refresh("all", windowsDeps(world.fs, []))).toEqual({ status: "busy" });
});

test("windows: a release that fails for an unrelated reason is not retried", async () => {
  for (const failure of [
    Object.assign(new Error("io"), { code: "EIO" }),
    Object.assign(new Error("gone"), { code: "ENOENT" }),
    new Error("There is not enough space on the disk. (os error 112)"),
  ]) {
    let attempts = 0;
    const world = windowsFs({
      failRename: (from, to) => {
        if (!isRelease(from, to)) return null;
        attempts++;
        return failure;
      },
    });
    const sleeps: number[] = [];
    expect((await refresh("all", windowsDeps(world.fs, [], sleeps))).status).toBe("ok");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  }
});

test("linux and macos: a release refused for any reason is tried once", async () => {
  for (const platform of ["linux", "macos"]) {
    let attempts = 0;
    const world = windowsFs({
      posix: true,
      failRename: (from, to) => {
        if (!isRelease(from, to)) return null;
        attempts++;
        return sharing();
      },
    });
    const sleeps: number[] = [];
    expect((await refresh("all", { ...windowsDeps(world.fs, [], sleeps, world.data), platform, homeDir: "/home/me" })).status).toBe("ok");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  }
});

// ----- taking the lock: sharing violations while renaming the staged lock into place --------------------------------------

const isAcquire = (from: string, to: string) => from.includes(`${LOCK_NAME}.new-`) && to.endsWith(`\\${LOCK_NAME}`);
const leftovers = (world: { entries: Map<string, unknown> }) => [...world.entries.keys()].filter((key) => key.includes(".new-") || key.includes(".stale-"));
const foreign = (world: { entries: Map<string, { kind: "dir" | "file"; text?: string; mtimeMs: number }> }) => {
  world.entries.set(`${DATA}\\${LOCK_NAME}`, { kind: "dir", mtimeMs: NOW });
  world.entries.set(`${DATA}\\${LOCK_NAME}\\owner.json`, { kind: "file", text: JSON.stringify({ token: "other", started: NOW }), mtimeMs: NOW });
};

test("windows: a transient refusal of the lock's rename (nsh's code-less os error 32, the number, EPERM, EACCES, EBUSY) is waited out and the lock is taken", async () => {
  const refusals: Error[] = [
    sharing(),
    Object.assign(new Error("sharing"), { code: 32 }),
    Object.assign(new Error("sharing"), { code: "32" }),
    ...["EPERM", "EACCES", "EBUSY"].map((code) => Object.assign(new Error(code), { code })),
  ];
  for (const refusal of refusals) {
    let attempts = 0;
    let stagings = 0;
    const world = windowsFs({
      failRename: (from, to) => (isAcquire(from, to) && attempts++ < 2 ? refusal : null),
      failMkdirExclusive: (path) => {
        if (isStaging(path)) stagings++;
        return null;
      },
    });
    const sleeps: number[] = [];
    expect((await refresh("all", windowsDeps(world.fs, [], sleeps))).status).toBe("ok");
    expect(attempts).toBe(3); // refused twice, taken the third time
    expect(stagings).toBe(1); // the same staged directory was renamed again, not rebuilt
    expect(sleeps).toEqual([25, 50]);
    expect(leftovers(world)).toEqual([]);
    expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false); // taken, then released
  }
});

test("windows: the refusal is retried a bounded number of times, then it is the refresh's error (and nothing is left behind)", async () => {
  let attempts = 0;
  const world = windowsFs({ failRename: (from, to) => (isAcquire(from, to) && ++attempts > 0 ? sharing() : null) });
  const sleeps: number[] = [];
  const failure = await refresh("all", windowsDeps(world.fs, [], sleeps)).then(() => null, (error: unknown) => error);
  expect(String((failure as Error).message)).toContain("(os error 32)");
  expect(attempts).toBe(5);
  expect(sleeps).toEqual([25, 50, 100, 200]);
  expect(leftovers(world)).toEqual([]);
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false);
});

test("windows: a refusal that is not an in-use refusal is not retried when taking the lock", async () => {
  for (const failure of [
    Object.assign(new Error("io"), { code: "EIO" }),
    Object.assign(new Error("gone"), { code: "ENOENT" }),
    new Error("There is not enough space on the disk. (os error 112)"),
    new Error("something else"),
  ]) {
    let attempts = 0;
    const world = windowsFs({ failRename: (from, to) => (isAcquire(from, to) && ++attempts > 0 ? failure : null) });
    const sleeps: number[] = [];
    const caught = await refresh("all", windowsDeps(world.fs, [], sleeps)).then(() => null, (error: unknown) => error);
    expect(caught).toBe(failure);
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(leftovers(world)).toEqual([]);
  }
});

test("windows: when another run's lock appears during the waits, this run reports busy; it neither retries into it nor touches it", async () => {
  // The first refusal is a sharing violation, and by the time it is judged a competing run has taken the lock.
  let attempts = 0;
  const racing = windowsFs({
    failRename: (from, to) => {
      if (!isAcquire(from, to)) return null;
      attempts++;
      foreign(racing);
      return sharing();
    },
  });
  const sleeps: number[] = [];
  expect(await refresh("all", windowsDeps(racing.fs, [], sleeps))).toEqual({ status: "busy" });
  expect(attempts).toBe(1); // no second try against the lock that is now there
  expect(sleeps).toEqual([]);
  expect(JSON.parse(racing.entries.get(`${DATA}\\${LOCK_NAME}\\owner.json`)!.text!)).toEqual({ token: "other", started: NOW });
  expect(leftovers(racing)).toEqual([]);

  // The competing run wins between the wait and the retry: the retried rename meets its lock (access denied, as on
  // Windows) and the answer is busy; the competitor's lock stays exactly as it was.
  let tries = 0;
  const late = windowsFs({
    failRename: (from, to) => {
      if (!isAcquire(from, to)) return null;
      if (tries++ === 0) return sharing();
      foreign(late);
      return null;
    },
  });
  const slept: number[] = [];
  const sleepAndRace = { ...windowsDeps(late.fs, [], slept), sleep: async (ms: number) => void slept.push(ms) };
  expect(await refresh("all", sleepAndRace)).toEqual({ status: "busy" });
  expect(slept).toEqual([25]);
  expect(JSON.parse(late.entries.get(`${DATA}\\${LOCK_NAME}\\owner.json`)!.text!)).toEqual({ token: "other", started: NOW });
  expect(leftovers(late)).toEqual([]);
});

test("windows: a competing lock seen after a refusal that is gone by the next look is retaken, not reported as the refusal", async () => {
  // The refused rename is followed by a look that finds a lock (so the refusal is read as "a lock is there"); the holder
  // then releases before the second look. Nothing was wrong with taking the lock, so the run loops and takes it.
  let attempts = 0;
  let lockLooks = 0;
  const world = windowsFs({
    failRename: (from, to) => {
      if (!isAcquire(from, to)) return null;
      if (attempts++ > 0) return null;
      foreign(world);
      return sharing();
    },
  });
  const lockPath = `${DATA}\\${LOCK_NAME}`;
  const fs: Deps["fs"] = {
    ...world.fs,
    async stat(path) {
      const found = await world.fs.stat(path);
      if (path === lockPath && ++lockLooks === 1 && found !== null) {
        // The competitor lets go right after the first look: the second look finds nothing.
        world.entries.delete(lockPath);
        world.entries.delete(`${lockPath}\\owner.json`);
      }
      return found;
    },
  };
  const sleeps: number[] = [];
  expect((await refresh("all", windowsDeps(fs, [], sleeps))).status).toBe("ok");
  expect(attempts).toBe(2); // refused once, then a fresh staged directory was renamed into place
  expect(sleeps).toEqual([]); // the competitor was seen, so this was no wait-and-retry of the same rename
  expect(leftovers(world)).toEqual([]);
  expect(world.entries.has(lockPath)).toBe(false); // taken, then released: no foreign lock was replaced or left
});

test("windows: a stale lock met with a code-less sharing violation is broken, and this run then takes the lock", async () => {
  let attempts = 0;
  const failing = windowsFs({
    lock: "stale",
    failRename: (from, to) => (isAcquire(from, to) && attempts++ === 0 ? sharing() : null),
  });
  const sleeps: number[] = [];
  expect((await refresh("all", windowsDeps(failing.fs, [], sleeps))).status).toBe("ok");
  expect(attempts).toBe(2); // first refused (the old lock is there, so no wait), the second staged directory went in
  expect(sleeps).toEqual([]);
  expect(leftovers(failing)).toEqual([]);
});

test("linux and macos: a refusal of the lock's rename is not retried and is not read as a held lock without EEXIST/ENOTEMPTY", async () => {
  for (const platform of ["linux", "macos"]) {
    let attempts = 0;
    const world = windowsFs({ posix: true, failRename: (from) => (from.includes(".new-") && ++attempts > 0 ? sharing() : null) });
    const sleeps: number[] = [];
    const failure = await refresh("all", { ...windowsDeps(world.fs, [], sleeps, world.data), platform, homeDir: "/home/me" }).then(() => null, (error: unknown) => error);
    expect(String((failure as Error).message)).toContain("(os error 32)");
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
  }
});

// ----- the deadline: a rename still in flight when the refresh times out -----------------------------------------------

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
};

test("windows: a lock rename that hangs past the deadline times the refresh out, and when it lands late the run's lock is released, not leaked", async () => {
  let land!: () => void;
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  const world = windowsFs({ hangRename: (from, to) => (isAcquire(from, to) ? gate : null) });
  const requests: string[] = [];
  const failure = await refresh("all", { ...windowsDeps(world.fs, requests), deadlineMs: 40 }).then(() => null, (error: unknown) => error);
  expect((failure as { code?: string }).code).toBe("timeout");
  // The refresh made no request and wrote nothing past the deadline. The in-flight rename keeps its source in use,
  // so the release at the deadline could not remove the staging directory either: the lock does not exist yet.
  expect(requests).toEqual([]);
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false);
  land(); // the rename completes now, long after its run was abandoned
  await settle();
  expect(leftovers(world)).toEqual([]);
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}`)).toBe(false); // the late lock was this run's token and is gone
  expect(world.entries.has(`${DATA}\\${LOCK_NAME}\\owner.json`)).toBe(false);
});

test("windows: a hung lock rename that finally fails leaves no staging directory behind", async () => {
  let fail!: () => void;
  const gate = new Promise<void>((_resolve, reject) => {
    fail = () => reject(sharing());
  });
  const world = windowsFs({ hangRename: (from, to) => (isAcquire(from, to) ? gate : null) });
  const failure = await refresh("all", { ...windowsDeps(world.fs, []), deadlineMs: 40 }).then(() => null, (error: unknown) => error);
  expect((failure as { code?: string }).code).toBe("timeout");
  expect([...world.entries.keys()].some((key) => key.includes(".new-"))).toBe(true); // still in use, so it could not be removed yet
  fail();
  await settle();
  expect(leftovers(world)).toEqual([]);
});

test("windows: a hung lock rename that lands late onto another run's lock cannot replace it, and that lock is not released by the late cleanup", async () => {
  let land!: () => void;
  const gate = new Promise<void>((resolve) => {
    land = resolve;
  });
  const world = windowsFs({ hangRename: (from, to) => (isAcquire(from, to) ? gate : null) });
  const failure = await refresh("all", { ...windowsDeps(world.fs, []), deadlineMs: 40 }).then(() => null, (error: unknown) => error);
  expect((failure as { code?: string }).code).toBe("timeout");
  foreign(world); // another run took the lock meanwhile
  land(); // the late rename now meets it: access denied, as on Windows
  await settle();
  expect(JSON.parse(world.entries.get(`${DATA}\\${LOCK_NAME}\\owner.json`)!.text!)).toEqual({ token: "other", started: NOW });
  expect(leftovers(world)).toEqual([]);
});

test("windows: no step of a timed-out acquire runs after the deadline (the waits between retries stop with the run)", async () => {
  const world = windowsFs({ failRename: (from, to) => (isAcquire(from, to) ? sharing() : null) });
  const renamesBefore = () => world.renames.length;
  let hold!: () => void;
  const held = new Promise<void>((resolve) => {
    hold = resolve;
  });
  const deps = { ...windowsDeps(world.fs, []), deadlineMs: 40, sleep: () => held }; // the first wait never ends
  const failure = await refresh("all", deps).then(() => null, (error: unknown) => error);
  expect((failure as { code?: string }).code).toBe("timeout");
  const seen = renamesBefore();
  hold();
  await settle();
  expect(world.renames.length).toBe(seen); // the abandoned run did not try the rename again
  expect(leftovers(world)).toEqual([]);
});
