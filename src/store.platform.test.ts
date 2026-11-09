// The settings store on Windows and macOS: path building with the data folder's own separator, no POSIX modes on
// Windows, the POSIX rules on macOS, and the bounded retry of a rename Windows refuses while the target is open.
// The ports are in-memory fakes (nsh's names for the platforms: "windows", "macos", "linux"); nothing here ran on a
// real Windows or macOS host.

import { expect, test } from "nsh/test";
import { SerialQueue, settingsStore } from "./store";
import type { SettingsStoreDeps } from "./store";
import { depsFor, fakeChmod, MemoryFs } from "../tests/fakes";

// A verbatim Windows folder: `/` separates nothing in it, so every child path must use a backslash.
const VERBATIM = "\\\\?\\C:\\Users\\me\\AppData\\Local\\Superbar";

// MemoryFs lists with "/" children; a Windows folder's children are separated by a backslash.
class WindowsFs extends MemoryFs {
    /** Rename failures to produce before one succeeds: their error codes, in order. */
    renameFailures: string[] = [];
    /** Rename failures to produce (before `renameFailures`) as whole errors, so a test chooses the exact shape. */
    renameErrors: Error[] = [];
    /** Every rename attempt, the refused ones included. */
    attempts = 0;

    override async rename(from: string, to: string): Promise<void> {
        this.attempts++;
        const error = this.renameErrors.shift();
        if (error !== undefined) throw error;
        const code = this.renameFailures.shift();
        if (code !== undefined) throw Object.assign(new Error(`rename ${from} failed`), { code });
        return super.rename(from, to);
    }

    override async list(dir: string): Promise<string[]> {
        const prefix = `${dir}\\`;
        return [...this.entries.keys()]
            .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes("\\"))
            .map(key => key.slice(prefix.length));
    }
}

function windowsStore(fs: WindowsFs, options: { sleeps?: number[]; platform?: string } = {}) {
    const chmod = fakeChmod(fs);
    const deps: SettingsStoreDeps = {
        ...depsFor(fs, chmod.run, { platform: options.platform ?? "windows", queue: new SerialQueue() }),
        sleep: async ms => {
            options.sleeps?.push(ms);
        },
    };
    return { store: settingsStore(VERBATIM, deps)!, chmod };
}

test("windows: files of a verbatim folder are named with a backslash, and no mode is set or required", async () => {
    const fs = new WindowsFs();
    const { store, chmod } = windowsStore(fs);
    await store.write('{"version":1}');
    expect(fs.writes.length).toBe(1);
    expect(fs.writes[0].startsWith(`${VERBATIM}\\settings.json.`)).toBe(true);
    expect(fs.writes[0].includes("/")).toBe(false);
    expect(fs.renames[0].endsWith(` -> ${VERBATIM}\\settings.json`)).toBe(true);
    expect(chmod.calls.length).toBe(0);
    expect(fs.entries.has(`${VERBATIM}\\settings.json`)).toBe(true);
    const read = await store.read();
    expect(read).toEqual({ kind: "loaded", text: '{"version":1}' });
});

test("windows: a file written world-readable by Windows' modes is still trusted (no mode bits there)", async () => {
    const fs = new WindowsFs();
    fs.entries.set(VERBATIM, { kind: "dir", mode: 0o777, mtimeMs: 0 });
    fs.entries.set(`${VERBATIM}\\settings.json`, { kind: "file", mode: 0o666, text: "{}", mtimeMs: 0 });
    const { store } = windowsStore(fs);
    expect(await store.read()).toEqual({ kind: "loaded", text: "{}" });
});

test("windows: an orphaned temporary file in a backslash folder is swept on read", async () => {
    const fs = new WindowsFs();
    fs.entries.set(VERBATIM, { kind: "dir", mode: 0o777, mtimeMs: 0 });
    fs.clock = 60 * 60_000;
    const orphan = `${VERBATIM}\\settings.json.abc-1.tmp`;
    fs.entries.set(orphan, { kind: "file", mode: 0o666, text: "x", mtimeMs: 0 });
    const { store } = windowsStore(fs);
    expect((await store.read()).kind).toBe("missing");
    expect(fs.entries.has(orphan)).toBe(false);
});

// What nsh reports for Windows' ERROR_SHARING_VIOLATION: Rust's message ends in "(os error 32)", and the error has no Node
// name, so nsh gives it NO `code` property at all (never `code: undefined` set by hand, which is a different shape).
function sharingViolation(): Error {
    return new Error("The process cannot access the file because it is being used by another process. (os error 32)");
}

test("windows: a rename refused while the target is open is retried with short waits, then lands", async () => {
    const fs = new WindowsFs();
    fs.renameFailures = ["EPERM", "EACCES", "EBUSY"];
    const sleeps: number[] = [];
    const { store } = windowsStore(fs, { sleeps });
    await store.write('{"v":1}');
    expect(sleeps).toEqual([25, 50, 100]);
    expect(fs.attempts).toBe(4);
    expect(fs.entries.get(`${VERBATIM}\\settings.json`)?.text).toBe('{"v":1}');
    expect(fs.temporaries().length).toBe(0);
});

test("windows: a sharing violation with no error code (os error 32) is retried, then lands", async () => {
    const fs = new WindowsFs();
    const error = sharingViolation();
    expect("code" in error).toBe(false);
    fs.renameErrors = [sharingViolation(), sharingViolation()];
    const sleeps: number[] = [];
    const { store } = windowsStore(fs, { sleeps });
    await store.write('{"v":2}');
    expect(sleeps).toEqual([25, 50]);
    expect(fs.attempts).toBe(3);
    expect(fs.entries.get(`${VERBATIM}\\settings.json`)?.text).toBe('{"v":2}');
    expect(fs.temporaries().length).toBe(0);
});

test("windows: the other shapes of the same refusal are retried too (code 32 as a number or a string, code undefined)", async () => {
    for (const shape of [{ code: 32 }, { code: "32" }, { code: undefined }]) {
        const fs = new WindowsFs();
        fs.renameErrors = [Object.assign(sharingViolation(), shape)];
        const sleeps: number[] = [];
        const { store } = windowsStore(fs, { sleeps });
        await store.write("{}");
        expect(sleeps).toEqual([25]);
        expect(fs.entries.has(`${VERBATIM}\\settings.json`)).toBe(true);
    }
    // No code and no OS error in the message: unknown, so treated as the same transient refusal.
    const fs = new WindowsFs();
    fs.renameErrors = [new Error("rename failed")];
    const sleeps: number[] = [];
    await windowsStore(fs, { sleeps }).store.write("{}");
    expect(sleeps).toEqual([25]);
});

test("windows: a rename that keeps being refused fails after the bounded retries, with the last error, and leaves no temporary file", async () => {
    for (const refuse of [
        () => Object.assign(new Error("busy"), { code: "EBUSY" }),
        sharingViolation,
    ]) {
        const fs = new WindowsFs();
        fs.renameErrors = Array.from({ length: 10 }, refuse);
        const sleeps: number[] = [];
        const { store } = windowsStore(fs, { sleeps });
        const failure = await store.write("{}").then(() => null, (error: unknown) => error);
        expect(failure instanceof Error).toBe(true);
        expect(sleeps).toEqual([25, 50, 100, 200]);
        expect(fs.attempts).toBe(5); // the first try and four retries, then it gives up
        expect(fs.renameErrors.length).toBe(5);
        expect(fs.temporaries().length).toBe(0);
        expect(fs.entries.has(`${VERBATIM}\\settings.json`)).toBe(false);
    }
});

test("windows: a rename that fails for a known unrelated reason is not retried, whatever the platform's retry policy", async () => {
    const failures: Error[] = [
        Object.assign(new Error("rename failed"), { code: "EIO" }),
        Object.assign(new Error("rename failed"), { code: "ENOENT" }),
        Object.assign(new Error("rename failed"), { code: "ENOSPC" }),
        Object.assign(new Error("rename failed"), { code: "EXDEV" }),
        // No code, but the message names another OS error (here ERROR_DISK_FULL, 112): known, so not retried.
        new Error("There is not enough space on the disk. (os error 112)"),
        Object.assign(new Error("rename failed"), { code: 112 }),
    ];
    for (const failure of failures) {
        const fs = new WindowsFs();
        fs.renameErrors = [failure];
        const sleeps: number[] = [];
        const { store } = windowsStore(fs, { sleeps });
        expect(await store.write("{}").then(() => null, (error: unknown) => error)).toBe(failure);
        expect(sleeps).toEqual([]);
        expect(fs.attempts).toBe(1);
        expect(fs.temporaries().length).toBe(0);
    }
});

for (const platform of ["linux", "macos"]) {
    test(`${platform}: POSIX rules apply: modes are set, and no refused rename is retried, whatever its shape`, async () => {
        const fs = new WindowsFs();
        const dir = "/data";
        const chmod = fakeChmod(fs);
        const sleeps: number[] = [];
        const deps: SettingsStoreDeps = {
            ...depsFor(fs, chmod.run, { platform, queue: new SerialQueue() }),
            sleep: async ms => {
                sleeps.push(ms);
            },
        };
        const store = settingsStore(dir, deps)!;
        await store.write("{}");
        expect(chmod.calls.map(call => call.mode)).toEqual(["700", "600"]);
        expect(fs.modeOf(dir)).toBe(0o700);
        expect(fs.modeOf(`${dir}/settings.json`)).toBe(0o600);

        for (const failure of [Object.assign(new Error("denied"), { code: "EACCES" }), Object.assign(new Error("busy"), { code: "EBUSY" }), sharingViolation()]) {
            fs.renameErrors = [failure];
            const before = fs.attempts;
            expect(await store.write("{}").then(() => null, (error: unknown) => error)).toBe(failure);
            expect(fs.attempts - before).toBe(1);
        }
        expect(sleeps).toEqual([]);

        // A group-readable settings file is not trusted.
        fs.entries.get(`${dir}/settings.json`)!.mode = 0o640;
        expect((await store.read()).kind).toBe("untrusted");
    });

    // The sweep on POSIX paths (a "/" folder, listed by MemoryFs itself), not a Windows folder's backslash names.
    test(`${platform}: the orphan sweep works on POSIX paths and removes only old, exactly named temporary files`, async () => {
        const fs = new MemoryFs();
        const dir = "/data";
        fs.entries.set(dir, { kind: "dir", mode: 0o700, mtimeMs: 0 });
        fs.entries.set(`${dir}/settings.json`, { kind: "file", mode: 0o600, text: "{}", mtimeMs: 0 });
        fs.clock = 60 * 60_000;
        const old = `${dir}/settings.json.abc-1.tmp`;
        const fresh = `${dir}/settings.json.abc-2.tmp`;
        const lookalike = `${dir}/settings.json.ABC.tmp`;
        const windowsStyle = `${dir}\\settings.json.abc-3.tmp`;
        fs.entries.set(old, { kind: "file", mode: 0o600, text: "x", mtimeMs: 0 });
        fs.entries.set(fresh, { kind: "file", mode: 0o600, text: "x", mtimeMs: fs.clock - 1000 });
        fs.entries.set(lookalike, { kind: "file", mode: 0o600, text: "x", mtimeMs: 0 });
        fs.entries.set(windowsStyle, { kind: "file", mode: 0o600, text: "x", mtimeMs: 0 });
        const chmod = fakeChmod(fs);
        const store = settingsStore(dir, { ...depsFor(fs, chmod.run, { platform, queue: new SerialQueue() }), sleep: async () => undefined })!;
        expect(await store.read()).toEqual({ kind: "loaded", text: "{}" });
        expect(fs.entries.has(old)).toBe(false);
        expect(fs.entries.has(fresh)).toBe(true);
        expect(fs.entries.has(lookalike)).toBe(true);
        expect(fs.entries.has(windowsStyle)).toBe(true);
        expect(chmod.calls.length).toBe(0);
    });
}
