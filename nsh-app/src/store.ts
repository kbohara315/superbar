// The saved settings: one file, `${dataDir}/settings.json`.
//
// Writes are atomic. Each save goes to a uniquely named temporary file (`settings.json.<id>.tmp`), is restricted to 0600
// and checked, and is then renamed over settings.json, so a reader sees either the old file or the new one, never a
// part of either. A temporary file left by an interrupted save is swept on load once it is older than SWEEP_AGE_MS.
//
// Ordering inside this process: every read and write of a data directory goes through one serial queue that lives at
// module level, so it outlives a controller's stop() and start(). A write is issued only after the previous underlying
// write has settled (resolved or rejected). Writes requested while one is waiting are coalesced: only the newest pending
// text is written next, so an older value can never land after a newer one this process requested. A read waits behind
// the writes requested before it, so it sees the newest value. A write that never settles holds the queue (later saves
// wait); the controller reports that with its own note and time limit, and never issues a second write meanwhile.
//
// Cross-instance: one Superbar instance is expected. Two instances writing the same folder are not ordered with each
// other: the last writer wins, and because each write is an atomic rename the file is always one whole valid version.
//
// Privacy, as for the snapshot (providers.ts): on POSIX the data directory must be 0700 and the file 0600 with no group
// or other bits, checked with lstat. nsh's lstat reports modes and types but not ownership, so a folder owned by another
// user is not detected here. Reads never follow a symlink and never trust a non-regular entry. Windows skips the modes.
//
// Every port is injectable so tests can run it against an in-memory file system.

import * as fsPromises from "fs/promises";
import process from "process";
import { randomUUID } from "crypto";
import type { SettingsRead, StorePort } from "./controller";

export const SETTINGS_FILE = "settings.json";
export const SETTINGS_INSECURE = "settings_insecure";
/** A settings file larger than this is not read: a settings file is a few hundred bytes. */
export const MAX_SETTINGS_BYTES = 64 * 1024;
/** A temporary file older than this is an orphan of an interrupted save; a save takes milliseconds to seconds. */
export const SWEEP_AGE_MS = 10 * 60_000;

/** The only names the sweep may remove: the temporary files this module makes (lowercase hex and dashes, as randomUUID gives). */
export const TEMP_NAME = /^settings\.json\.[0-9a-f-]+\.tmp$/;

export interface EntryInfo {
    mode: number;
    mtimeMs: number;
    size: number;
    file: boolean;
    directory: boolean;
    symlink: boolean;
}

export interface SettingsFs {
    /** Reads UTF-8 text. */
    readText(path: string): Promise<string>;
    writeText(path: string, text: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    /** Entry names in a directory; an empty list when it does not exist. */
    list(dir: string): Promise<string[]>;
    /** What the entry itself is (a symlink is not followed); null when it does not exist. */
    lstat(path: string): Promise<EntryInfo | null>;
}

export type ChmodRunner = (mode: string, path: string) => Promise<{ code: number | null }>;

export interface SettingsStoreDeps {
    fs: SettingsFs;
    chmod: ChmodRunner;
    /** `process.platform`. Anything but `windows` is POSIX, where modes are enforced (as in providers.ts). */
    platform: string;
    /** A new unique id for each temporary file: lowercase hex and dashes (see TEMP_NAME). */
    newName(): string;
    /** The wall clock in milliseconds: for the orphan sweep's age test. */
    now(): number;
    /**
     * The queue this store uses. Default: the process-wide queue of the data directory, so every store of one folder in
     * this process is ordered together. A test can pass its own queue to model a second instance.
     */
    queue?: SerialQueue;
}

export function defaultSettingsStoreDeps(): SettingsStoreDeps {
    return {
        fs: {
            readText: path => fsPromises.readFile(path, "utf8"),
            writeText: (path, text) => fsPromises.writeFile(path, text),
            rename: (from, to) => fsPromises.rename(from, to),
            unlink: path => fsPromises.unlink(path),
            mkdir: path => fsPromises.mkdir(path, { recursive: true }).then(() => undefined),
            list: async dir => {
                try {
                    return await fsPromises.readdir(dir);
                } catch (err) {
                    if ((err as { code?: string }).code === "ENOENT") return [];
                    throw err;
                }
            },
            lstat: async path => {
                try {
                    const info = await fsPromises.lstat(path);
                    return {
                        mode: info.mode,
                        mtimeMs: info.mtimeMs,
                        size: info.size,
                        file: info.isFile(),
                        directory: info.isDirectory(),
                        symlink: info.isSymbolicLink(),
                    };
                } catch (err) {
                    if ((err as { code?: string }).code === "ENOENT") return null;
                    throw err;
                }
            },
        },
        chmod: async (mode, path) => ({ code: (await process.run("chmod", [mode, path])).code ?? null }),
        platform: process.platform,
        newName: () => randomUUID(),
        now: () => Date.now(),
    };
}

// ----- the serial queue -----------------------------------------------------------------------------------------------

/** One completion shared by every save that joins a queued write job: settled once, when that job's write settles. */
interface Completion {
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
}

function completion(): Completion {
    let resolve: () => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

interface WriteJob {
    kind: "write";
    dir: string;
    deps: SettingsStoreDeps;
    text: string;
    done: Completion;
}
interface ReadJob {
    kind: "read";
    dir: string;
    deps: SettingsStoreDeps;
    resolve: (read: SettingsRead) => void;
}

/**
 * The operations on one data directory, run one at a time. `jobs` holds only the operations not yet started. Writes
 * requested while a write is waiting are coalesced into that job: its text becomes the newest, and every such save
 * shares the job's one completion, so the bookkeeping per waiting job is constant however many edits arrive.
 */
export class SerialQueue {
    private readonly jobs: (WriteJob | ReadJob)[] = [];
    private running = false;

    /** Queues a write (or joins the waiting one). Every save that joins gets the same promise; it settles with the write. */
    write(dir: string, text: string, deps: SettingsStoreDeps): Promise<void> {
        const last = this.jobs[this.jobs.length - 1];
        if (last?.kind === "write") {
            last.text = text;
            last.deps = deps;
            return last.done.promise;
        }
        const done = completion();
        this.jobs.push({ kind: "write", dir, deps, text, done });
        void this.pump();
        return done.promise;
    }

    read(dir: string, deps: SettingsStoreDeps): Promise<SettingsRead> {
        return new Promise<SettingsRead>(resolve => {
            this.jobs.push({ kind: "read", dir, deps, resolve });
            void this.pump();
        });
    }

    /** Operations waiting to start (diagnostics: a hung write plus any number of edits leaves one waiting write). */
    queued(): number {
        return this.jobs.length;
    }

    // One job at a time: the next starts only after the previous one has settled. A job that never settles holds the
    // queue (the documented behaviour; see the header).
    private async pump(): Promise<void> {
        if (this.running) return;
        this.running = true;
        try {
            for (let job = this.jobs.shift(); job !== undefined; job = this.jobs.shift()) {
                if (job.kind === "read") {
                    job.resolve(await readSettings(job.dir, job.deps));
                } else {
                    try {
                        await writeAtomic(job.dir, job.text, job.deps);
                        job.done.resolve();
                    } catch (error) {
                        job.done.reject(error);
                    }
                }
            }
        } finally {
            this.running = false;
        }
    }
}

const queues = new Map<string, SerialQueue>();

function queueFor(dataDir: string): SerialQueue {
    let queue = queues.get(dataDir);
    if (queue === undefined) {
        queue = new SerialQueue();
        queues.set(dataDir, queue);
    }
    return queue;
}

// ----- privacy and file helpers ---------------------------------------------------------------------------------------

function insecure(message: string): Error {
    return Object.assign(new Error(message), { code: SETTINGS_INSECURE });
}

function isPosix(deps: Pick<SettingsStoreDeps, "platform">): boolean {
    return deps.platform !== "windows";
}

// Applies `mode` with chmod, then reads the entry back: it must now be exactly `mode`, and it must be what was expected
// (a directory or a regular file, never a symlink). A chmod that reports success but changes nothing fails.
async function restrict(path: string, mode: string, expectDirectory: boolean, deps: SettingsStoreDeps): Promise<void> {
    const result = await deps.chmod(mode, path);
    if (result.code !== 0) throw insecure(`chmod ${mode} failed on ${path}`);
    const info = await deps.fs.lstat(path);
    const kindOk = info !== null && !info.symlink && (expectDirectory ? info.directory : info.file);
    if (!kindOk || (info.mode & 0o777) !== Number.parseInt(mode, 8)) {
        throw insecure(`${path} does not have mode ${mode} after chmod`);
    }
}

// ----- write ----------------------------------------------------------------------------------------------------------

async function writeAtomic(dir: string, text: string, deps: SettingsStoreDeps): Promise<void> {
    await deps.fs.mkdir(dir);
    if (isPosix(deps)) {
        const folder = await deps.fs.lstat(dir);
        if (folder === null || folder.symlink || !folder.directory) throw insecure("the settings folder is not a folder");
        if ((folder.mode & 0o777) !== 0o700) await restrict(dir, "700", true, deps);
    }
    const id = deps.newName();
    if (!/^[0-9a-f-]+$/.test(id)) throw new Error("temporary file ids must be lowercase hex and dashes");
    const temp = `${dir}/${SETTINGS_FILE}.${id}.tmp`;
    try {
        // From here on the temporary file may exist, so any failure removes it (a write may stop part-way).
        await deps.fs.writeText(temp, text);
        if (isPosix(deps)) await restrict(temp, "600", false, deps);
        await deps.fs.rename(temp, `${dir}/${SETTINGS_FILE}`);
    } catch (error) {
        await deps.fs.unlink(temp).catch(() => undefined);
        throw error;
    }
}

// ----- read -----------------------------------------------------------------------------------------------------------

function untrusted(reason: string): SettingsRead {
    return { kind: "untrusted", reason };
}

// Removes the orphaned temporary files of interrupted saves: names that match TEMP_NAME exactly, regular files only,
// older than SWEEP_AGE_MS. Each removal uses the name as it was listed (never a path rebuilt from the name's text).
async function sweepTemporaries(dir: string, deps: SettingsStoreDeps): Promise<void> {
    let names: string[];
    try {
        names = await deps.fs.list(dir);
    } catch {
        return;
    }
    for (const name of names) {
        if (!TEMP_NAME.test(name)) continue;
        const path = `${dir}/${name}`;
        try {
            const info = await deps.fs.lstat(path);
            if (info !== null && info.file && !info.symlink && deps.now() - info.mtimeMs >= SWEEP_AGE_MS) {
                await deps.fs.unlink(path);
            }
        } catch {
            // Gone already, or not ours to remove: leave it.
        }
    }
}

// Reads the saved settings. Nothing is thrown: the result says what was found. Only settings.json is read; other files
// in the folder (the interim `settings.<digits>.json` of earlier builds included) are left alone.
async function readSettings(dir: string, deps: SettingsStoreDeps): Promise<SettingsRead> {
    try {
        const folder = await deps.fs.lstat(dir);
        if (folder === null) return { kind: "missing" };
        if (folder.symlink || !folder.directory) return untrusted("the settings folder is not a folder");
        if (isPosix(deps) && (folder.mode & 0o777) !== 0o700) return untrusted("the settings folder is not private");
        await sweepTemporaries(dir, deps);
        const path = `${dir}/${SETTINGS_FILE}`;
        const info = await deps.fs.lstat(path);
        if (info === null) return { kind: "missing" };
        if (info.symlink || !info.file) return untrusted("settings.json is not a regular file");
        if (isPosix(deps) && (info.mode & 0o077) !== 0) return untrusted("settings.json is not private");
        if (info.size > MAX_SETTINGS_BYTES) return untrusted("settings.json is too large");
        return { kind: "loaded", text: await deps.fs.readText(path) };
    } catch (error) {
        const code = (error as { code?: string }).code;
        return untrusted(`settings could not be read${code ? ` (${code})` : ""}`);
    }
}

// ----- the port -------------------------------------------------------------------------------------------------------

/** The store for `dataDir` (null: no data directory, so nothing is saved). */
export function settingsStore(dataDir: string | null, deps: SettingsStoreDeps = defaultSettingsStoreDeps()): StorePort | null {
    if (!dataDir) return null;
    const queue = deps.queue ?? queueFor(dataDir);
    return {
        read: () => queue.read(dataDir, deps),
        write: text => queue.write(dataDir, text, deps),
    };
}
