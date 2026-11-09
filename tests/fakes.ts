// Test doubles for the controller's ports and snapshot fixtures. Nothing here touches the disk, the network or the
// desktop, so it runs under headless `nsh test`.

import type { ProviderSnapshot, Snapshot, DoctorCheck, MetricName, MetricReading, ProcessEntry, ProviderName, UsageWindow } from "../src/types";
import type { ProcessMetric } from "../src/controller";
import type { RefreshOutcome } from "../src/providers";
import { Controller } from "../src/controller";
import type { ChmodRunner, EntryInfo, SettingsFs, SettingsStoreDeps } from "../src/store";
import type { SerialQueue } from "../src/store";
import type { ControllerDeps, NotifierPort, ProvidersPort, RefreshSelection, SamplerPort, SettingsRead, StorePort, TimerPort } from "../src/controller";

export const T0 = Date.parse("2026-11-07T10:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

export function iso(ms: number): string {
    return new Date(ms).toISOString();
}

// A window used `used` percent that resets `resetInMs` after T0 (3 hours by default). `null` reset means none recorded.
export function window(label: string, used: number, resetInMs: number | null = 3 * HOUR): UsageWindow {
    return { label, used_percent: used, reset_at: resetInMs === null ? null : iso(T0 + resetInMs), duration_seconds: null };
}

export function provider(
    state: ProviderSnapshot["state"],
    primary: UsageWindow | null,
    secondary: UsageWindow | null = null,
    extra: { error?: { code: string; message: string } | null; expiresAt?: string | null } = {},
): ProviderSnapshot {
    return {
        state,
        last_success_at: state === "unavailable" ? null : iso(T0 - MINUTE),
        windows: { primary, secondary },
        error: extra.error ?? null,
        expires_at: extra.expiresAt ?? null,
    };
}

export function snapshot(codex: ProviderSnapshot, claude: ProviderSnapshot): Snapshot {
    return { schema_version: 1, generated_at: iso(T0), providers: { codex, claude } };
}

// Both providers fresh: Codex 22% used in its 5-hour window (weekly 40%), Claude 51% used (weekly 70%).
export function freshSnapshot(): Snapshot {
    return snapshot(
        provider("fresh", window("5-hour", 22), window("Weekly", 40, 2 * 24 * HOUR)),
        provider("fresh", window("5-hour", 51), window("Weekly", 70, 2 * 24 * HOUR)),
    );
}

export class ManualTimers implements TimerPort {
    now: number;
    private seq = 1;
    private readonly pending = new Map<number, { at: number; every: number | null; run: () => void }>();

    constructor(start: number) {
        this.now = start;
    }

    setInterval(callback: () => void, ms: number): unknown {
        const id = this.seq++;
        this.pending.set(id, { at: this.now + ms, every: ms, run: callback });
        return id;
    }

    setTimeout(callback: () => void, ms: number): unknown {
        const id = this.seq++;
        this.pending.set(id, { at: this.now + ms, every: null, run: callback });
        return id;
    }

    clearInterval(handle: unknown): void {
        this.pending.delete(handle as number);
    }

    clearTimeout(handle: unknown): void {
        this.pending.delete(handle as number);
    }

    count(): number {
        return this.pending.size;
    }

    /** The periods (ms) of the repeating timers still pending, sorted: the registry as a schedule sees it. */
    intervals(): number[] {
        return [...this.pending.values()]
            .filter(timer => timer.every !== null)
            .map(timer => timer.every as number)
            .sort((x, y) => x - y);
    }

    /** Runs due timers in time order, each at its own time, then moves the clock to the target. */
    advance(ms: number): void {
        const target = this.now + ms;
        for (;;) {
            let next: { id: number; at: number } | null = null;
            for (const [id, timer] of this.pending) {
                if (timer.at <= target && (next === null || timer.at < next.at)) next = { id, at: timer.at };
            }
            if (next === null) break;
            const timer = this.pending.get(next.id);
            if (!timer) break;
            this.now = next.at;
            if (timer.every !== null) timer.at += timer.every;
            else this.pending.delete(next.id);
            timer.run();
        }
        this.now = target;
    }
}

// Lets resolved promises and their continuations run (the fakes resolve at once).
export async function settle(): Promise<void> {
    for (let i = 0; i < 200; i++) await Promise.resolve();
}

export class FakeProviders implements ProvidersPort {
    saved: Snapshot | null = null;
    current: Snapshot = freshSnapshot();
    calls: RefreshSelection[] = [];
    doctorChecks: DoctorCheck[] = [{ name: "data_dir", status: "ok", detail: "ready" }];
    /** What each refresh gives back; by default the current snapshot, fresh. */
    respond: (selection: RefreshSelection, call: number) => Promise<RefreshOutcome> =
        () => Promise.resolve({ status: "ok", snapshot: this.current });

    async loadSnapshot(): Promise<Snapshot | null> {
        return this.saved;
    }

    refresh(selection: RefreshSelection): Promise<RefreshOutcome> {
        const call = this.calls.length;
        this.calls.push(selection);
        return this.respond(selection, call);
    }

    async doctor(): Promise<DoctorCheck[]> {
        return this.doctorChecks;
    }
}

export class FakeMetrics {
    readings: Partial<Record<MetricName, MetricReading>> = {};
    processes: ProcessEntry[] = [];
    samples: MetricName[] = [];
    processListings: string[] = [];

    readonly sampler = (name: MetricName): SamplerPort => ({
        sample: async () => {
            this.samples.push(name);
            return this.readings[name] ?? { name, available: false, text: "unavailable" };
        },
        topProcesses: async (kind) => {
            this.processListings.push(kind);
            return this.processes;
        },
    });
}

export class FakeNotifier implements NotifierPort {
    permission = "granted";
    requests = 0;
    shown: { id: string; title: string; body: string }[] = [];

    async requestPermission(): Promise<string> {
        this.requests += 1;
        return this.permission;
    }

    async show(notification: { id: string; title: string; body: string }): Promise<boolean> {
        this.shown.push(notification);
        return true;
    }
}

/** An in-memory store: the settings text it holds, as a restart would load it. Writes complete at once. */
export class MemoryStore implements StorePort {
    /** Every write, in the order it was requested. */
    writes: string[] = [];
    private current: string | null = null;
    constructor(text: string | null = null) {
        this.current = text;
    }

    /** The text a restart would load, or null. */
    get text(): string | null {
        return this.current;
    }

    async read(): Promise<SettingsRead> {
        return this.current === null ? { kind: "missing" } : { kind: "loaded", text: this.current };
    }

    async write(text: string): Promise<void> {
        this.writes.push(text);
        this.current = text;
    }
}

export interface Harness {
    controller: Controller;
    /** The wall clock is the monotonic timeline plus this offset; a test can move the wall clock alone. */
    wall: { offset: number };
    timers: ManualTimers;
    providers: FakeProviders;
    metrics: FakeMetrics;
    notifier: FakeNotifier;
    store: MemoryStore;
}

export function harness(options: { saved?: Snapshot | null; settings?: string | null; permission?: string; start?: number; store?: StorePort; sampler?: ControllerDeps["sampler"] } = {}): Harness {
    const timers = new ManualTimers(options.start ?? T0);
    const wall = { offset: 0 };
    const providers = new FakeProviders();
    providers.saved = options.saved ?? null;
    const metrics = new FakeMetrics();
    const notifier = new FakeNotifier();
    notifier.permission = options.permission ?? "granted";
    const store = new MemoryStore(options.settings === undefined ? null : options.settings);
    const deps: ControllerDeps = {
        clock: () => timers.now + wall.offset,
        monotonic: () => timers.now,
        timers,
        providers,
        sampler: options.sampler ?? metrics.sampler,
        notifier,
        store: options.store ?? store,
    };
    return { controller: new Controller(deps), wall, timers, providers, metrics, notifier, store };
}

export function okOutcome(snap: Snapshot): Promise<RefreshOutcome> {
    return Promise.resolve({ status: "ok", snapshot: snap });
}

export const PROVIDERS: ProviderName[] = ["codex", "claude"];

/**
 * A store whose writes complete only when the test releases them. It records what reached the disk, in the order the
 * writes completed, and the largest number of writes running at once.
 */
/**
 * A raw port whose writes stay in flight until the test releases them (no ordering of its own: the controller's
 * hand-over is what is under test here; store.ts orders the real writes).
 */
export class DeferredStore implements StorePort {
    /** Every write requested, in order: its text and the function that completes it. */
    readonly calls: { text: string; release: () => void }[] = [];
    /** The texts of the writes that completed, in the order they completed. */
    readonly committed: string[] = [];
    inFlight = 0;
    maxInFlight = 0;
    /** What `read` answers; `holdRead` holds the answer until `finishRead`. */
    readResult: SettingsRead = { kind: "missing" };
    holdRead = false;
    private releaseRead: (() => void) | null = null;

    read(): Promise<SettingsRead> {
        if (!this.holdRead) return Promise.resolve(this.readResult);
        return new Promise<SettingsRead>(resolve => {
            this.releaseRead = () => resolve(this.readResult);
        });
    }

    /** Completes a held `read`. */
    finishRead(): void {
        this.releaseRead?.();
    }

    write(text: string): Promise<void> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        return new Promise<void>(resolve => {
            this.calls.push({
                text,
                release: () => {
                    this.inFlight -= 1;
                    this.committed.push(text);
                    resolve();
                },
            });
        });
    }
}

/** A sampler whose reads complete only when the test releases them, to check that reads never overlap. */
export class DeferredSampler implements SamplerPort {
    readonly started: number[] = [];
    readonly pending: { release: (reading: MetricReading) => void }[] = [];
    inFlight = 0;
    maxInFlight = 0;
    /** Process-list reads, held until released; `listsInFlight` counts the ones still running. */
    readonly listPending: { kind: ProcessMetric; release: () => void }[] = [];
    listsInFlight = 0;
    maxListsInFlight = 0;
    processRows: ProcessEntry[] = [];

    constructor(private readonly name: MetricName) {}

    sample(): Promise<MetricReading> {
        this.inFlight += 1;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        this.started.push(this.started.length);
        return new Promise<MetricReading>(resolve => {
            this.pending.push({
                release: reading => {
                    this.inFlight -= 1;
                    resolve(reading);
                },
            });
        });
    }

    topProcesses(kind: ProcessMetric): Promise<ProcessEntry[]> {
        this.listsInFlight += 1;
        this.maxListsInFlight = Math.max(this.maxListsInFlight, this.listsInFlight);
        return new Promise<ProcessEntry[]>(resolve => {
            this.listPending.push({
                kind,
                release: () => {
                    this.listsInFlight -= 1;
                    resolve(this.processRows);
                },
            });
        });
    }

    get name_(): string {
        return this.name;
    }
}

export function reading(name: MetricName, percent: number): MetricReading {
    return { name, available: true, percent, text: `${percent}%` };
}

// An in-memory file system with POSIX-style permission bits. A new file gets 0644 and a new directory 0755 (a common
// umask), so a store that does not chmod them would fail the checks below.
export class MemoryFs implements SettingsFs {
    readonly entries = new Map<string, { kind: "dir" | "file" | "symlink" | "other"; mode: number; text?: string; mtimeMs: number }>();
    /** Every writeText, in order (the temporary files included). */
    readonly writes: string[] = [];
    /** Every rename, as `from -> to`, in order. */
    readonly renames: string[] = [];
    /** Test hook: a write that stores `partial` and then rejects, as a failing disk would. */
    failWriteWith: { partial: string; error: Error } | null = null;
    /** Test hook: a rename that fails once for a path this matches. */
    failRenameTo: ((path: string) => boolean) | null = null;
    /**
     * Test hook: a write to a path this matches waits for the promise it returns (null: no wait). The write lands
     * after that promise resolves, as a stuck disk write would.
     */
    gate: ((path: string) => Promise<void> | null) | null = null;
    /** Writes started and not yet landed (a write waiting at its gate counts). */
    inFlight = 0;
    maxInFlight = 0;
    clock = 0;

    async readText(path: string): Promise<string> {
        const entry = this.entries.get(path);
        if (!entry || entry.kind !== "file") throw Object.assign(new Error(`no ${path}`), { code: "ENOENT" });
        return entry.text ?? "";
    }

    async writeText(path: string, text: string): Promise<void> {
        this.writes.push(path);
        this.inFlight++;
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
        try {
            const wait = this.gate?.(path) ?? null;
            if (wait !== null) await wait;
            if (this.failWriteWith) {
                const { partial, error } = this.failWriteWith;
                this.failWriteWith = null;
                this.entries.set(path, { kind: "file", mode: 0o644, text: partial, mtimeMs: this.clock });
                throw error;
            }
            this.entries.set(path, { kind: "file", mode: 0o644, text, mtimeMs: this.clock });
        } finally {
            this.inFlight--;
        }
    }

    async rename(from: string, to: string): Promise<void> {
        this.renames.push(`${from} -> ${to}`);
        const entry = this.entries.get(from);
        if (!entry) throw Object.assign(new Error(`no ${from}`), { code: "ENOENT" });
        if (this.failRenameTo?.(to)) {
            this.failRenameTo = null;
            throw Object.assign(new Error(`rename to ${to} failed`), { code: "EIO" });
        }
        this.entries.delete(from);
        this.entries.set(to, entry);
    }

    async unlink(path: string): Promise<void> {
        if (!this.entries.delete(path)) throw Object.assign(new Error(`no ${path}`), { code: "ENOENT" });
    }

    async mkdir(path: string): Promise<void> {
        if (!this.entries.has(path)) this.entries.set(path, { kind: "dir", mode: 0o755, mtimeMs: this.clock });
    }

    async list(dir: string): Promise<string[]> {
        const prefix = `${dir}/`;
        return [...this.entries.keys()]
            .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
            .map(key => key.slice(prefix.length));
    }

    async lstat(path: string): Promise<EntryInfo | null> {
        const entry = this.entries.get(path);
        if (!entry) return null;
        const size = entry.kind === "file" ? (entry.text ?? "").length : 0;
        return {
            mode: entry.mode | (entry.kind === "dir" ? 0o40000 : entry.kind === "file" ? 0o100000 : entry.kind === "symlink" ? 0o120000 : 0o10000),
            mtimeMs: entry.mtimeMs,
            size,
            file: entry.kind === "file",
            directory: entry.kind === "dir",
            symlink: entry.kind === "symlink",
        };
    }

    modeOf(path: string): number | undefined {
        const entry = this.entries.get(path);
        return entry ? entry.mode & 0o777 : undefined;
    }

    temporaries(): string[] {
        return [...this.entries.keys()].filter(key => key.endsWith(".tmp"));
    }

    /** Holds every write to a path this matches until the returned function is called. */
    holdWritesTo(match: (path: string) => boolean): () => void {
        const releases: (() => void)[] = [];
        this.gate = path => (match(path) ? new Promise<void>(resolve => releases.push(resolve)) : null);
        return () => {
            this.gate = null;
            for (const release of releases.splice(0)) release();
        };
    }
}

// chmod that applies the mode when `honest` (the default), or reports success while changing nothing when not. A path
// matching `failFor` fails with exit code 1.
export function fakeChmod(fs: MemoryFs, options: { honest?: boolean; failFor?: (path: string) => boolean } = {}) {
    const calls: { mode: string; path: string }[] = [];
    const run: ChmodRunner = async (mode, path) => {
        calls.push({ mode, path });
        if (options.failFor?.(path)) return { code: 1 };
        if (options.honest !== false) {
            const entry = fs.entries.get(path);
            if (entry) entry.mode = (entry.mode & ~0o777) | Number.parseInt(mode, 8);
        }
        return { code: 0 };
    };
    return { calls, run };
}

export function depsFor(fs: MemoryFs, chmod: ChmodRunner, options: { platform?: string; newName?: () => string; queue?: SerialQueue } = {}): SettingsStoreDeps {
    let counter = 0;
    return {
        fs,
        chmod,
        platform: options.platform ?? "linux",
        newName: options.newName ?? (() => `0000-${(++counter).toString(16)}`),
        now: () => fs.clock,
        queue: options.queue,
    };
}
