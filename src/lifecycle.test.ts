// Lifecycle audit tests (see the ASYNC AUDIT table in controller.ts). Every async source the controller has is run
// through the same matrix: start -> stop, start -> stop -> start, and start -> stop -> start -> stop, with each
// pending operation either resolved late (after the stop that invalidated it) or never resolved. Deferred fakes keep
// every operation pending until the test releases it, and a registry remembers which generation created it.
//
// After the matrix, the test checks, for stale operations: no external work invoked, no state published, no timer
// armed, no notification shown; and that a later start is not blocked by them (its own operation runs and publishes).

import { expect, test } from "nsh/test";
import {
    Controller, CLOCK_TICK_MS, SAMPLE_TIMEOUT_MS,
    type ControllerDeps, type ProcessMetric, type SettingsRead, type StorePort,
} from "./controller";
import { settingsStore, SerialQueue } from "./store";
import type { RefreshOutcome } from "./providers";
import type { DoctorCheck, MetricName, MetricReading, ProcessEntry, Settings, Snapshot } from "./types";
import { defaultSettings, serializeSettings } from "./settings";
import { depsFor, fakeChmod, ManualTimers, MemoryFs, MINUTE, T0, iso, provider, settle, snapshot, window } from "../tests/fakes";

// ----- the lab: deferred fakes with a generation tag on every pending operation ---------------------------------------

interface Entry { tag: number; release: () => void }

class Lab {
    /** Which start-generation the operations being created belong to (incremented by the runner per start). */
    tag = 0;
    readonly pending: Entry[] = [];
    readonly counts = { sample: 0, list: 0, refresh: 0, doctor: 0, read: 0, write: 0, load: 0, permission: 0 };
    readonly shown: string[] = [];
    /**
     * The settings folder: the real store (store.ts) over an in-memory file system, so the matrix checks what lands on
     * disk. Its writes are gated like every other operation: a write is in flight until the lab releases it.
     */
    readonly fs = new MemoryFs();
    readonly store: StorePort;
    /** True for the "never" resolution: a stuck operation is never released, so nothing behind it can land. */
    neverResolves = false;
    deferSample = false;
    deferList = false;
    deferRefresh = false;
    deferDoctor = false;
    deferRead = false;
    deferWrite = false;
    deferLoad = false;
    deferPermission = false;
    /** Snapshots: the cache at start, the one a clock tick reads (its expiry differs, so a release is visible). */
    snapshotNow: Snapshot = snapshot(
        provider("fresh", window("5-hour", 22), null, { expiresAt: iso(T0 + 20 * MINUTE) }),
        provider("fresh", window("5-hour", 51)),
    );
    snapshotLater: Snapshot = snapshot(
        provider("fresh", window("5-hour", 22), null, { expiresAt: iso(T0 + 45 * MINUTE) }),
        provider("fresh", window("5-hour", 51)),
    );
    /** What a refresh returns. Notification sources use a value over the 80% line. */
    refreshSnapshot: Snapshot = this.snapshotNow;

    constructor() {
        const settings = defaultSettings();
        settings.metrics.cpu = { enabled: true, seconds: 3600 }; // CPU on, so every start samples it
        this.setSavedSettings(settings);
        this.fs.gate = path => {
            if (!this.deferWrite || !path.endsWith(".tmp")) return null;
            return new Promise<void>(resolve => this.pending.push({ tag: this.tag, release: resolve }));
        };
        const real = settingsStore(DATA_DIR, depsFor(this.fs, fakeChmod(this.fs).run, { queue: new SerialQueue() }))!;
        this.store = {
            read: () => {
                this.counts.read++;
                return this.later(this.deferRead, () => real.read());
            },
            write: text => {
                this.counts.write++; // a save request, counted when the controller makes it
                return real.write(text);
            },
        };
    }

    /** Writes the settings file as a previous run would have left it (private folder and file). */
    setSavedSettings(settings: Settings): void {
        this.fs.entries.set(DATA_DIR, { kind: "dir", mode: 0o700, mtimeMs: 0 });
        this.fs.entries.set(`${DATA_DIR}/settings.json`, { kind: "file", mode: 0o600, text: serializeSettings(settings), mtimeMs: 0 });
    }

    /** The diskAlertThreshold in the settings file now, or null when there is no file. */
    diskThreshold(): number | null {
        const text = this.fs.entries.get(`${DATA_DIR}/settings.json`)?.text;
        return text === undefined ? null : JSON.parse(text).diskAlertThreshold;
    }

    /** Runs `run` when released (a deferred read), or at once. */
    later<T>(defer: boolean, run: () => Promise<T>): Promise<T> {
        if (!defer) return run();
        return new Promise<T>((resolve, reject) => {
            this.pending.push({ tag: this.tag, release: () => run().then(resolve, reject) });
        });
    }

    /** Creates an operation: deferred (released by the test) or resolved at once. */
    op<T>(defer: boolean, value: () => T): Promise<T> {
        if (!defer) return Promise.resolve(value());
        return new Promise<T>(resolve => {
            this.pending.push({ tag: this.tag, release: () => resolve(value()) });
        });
    }

    /** Releases the pending operations for which `select` is true. */
    release(select: (entry: Entry) => boolean): void {
        const chosen = this.pending.filter(select);
        for (const entry of chosen) this.pending.splice(this.pending.indexOf(entry), 1);
        for (const entry of chosen) entry.release();
    }

    /**
     * Releases every matching operation, including the ones that start because a release let them (a queued save
     * starts when the write before it lands). Stops when nothing matching is left.
     */
    async releaseAll(select: (entry: Entry) => boolean): Promise<void> {
        for (let round = 0; round < 10 && this.pending.some(select); round++) {
            this.release(select);
            await settle();
        }
    }

    total(): number {
        return Object.values(this.counts).reduce((sum, value) => sum + value, 0);
    }
}

const DATA_DIR = "/data";

function sampleOf(name: MetricName, percent: number): MetricReading {
    return { name, available: true, percent, text: `${percent}%` };
}

function makeController(lab: Lab, timers: ManualTimers): Controller {
    const samplerFor = (name: MetricName) => ({
        sample: () => {
            lab.counts.sample++;
            return lab.op(lab.deferSample, () => sampleOf(name, 10));
        },
        topProcesses: (_kind: ProcessMetric): Promise<ProcessEntry[]> => {
            lab.counts.list++;
            return lab.op(lab.deferList, () => [{ name: "codex", value: 2048, text: "2.0 MB" }]);
        },
    });
    const deps: ControllerDeps = {
        clock: () => timers.now,
        monotonic: () => timers.now,
        timers,
        providers: {
            loadSnapshot: () => {
                lab.counts.load++;
                const later = lab.deferLoad; // captured now: a deferred read answers with the snapshot of its own time
                return lab.op<Snapshot | null>(later, () => (later ? lab.snapshotLater : lab.snapshotNow));
            },
            refresh: (): Promise<RefreshOutcome> => {
                lab.counts.refresh++;
                return lab.op<RefreshOutcome>(lab.deferRefresh, () => ({ status: "ok", snapshot: lab.refreshSnapshot }));
            },
            doctor: (): Promise<DoctorCheck[]> => {
                lab.counts.doctor++;
                return lab.op<DoctorCheck[]>(lab.deferDoctor, () => [{ name: "data_dir", status: "ok", detail: "ready" }]);
            },
        },
        sampler: samplerFor,
        notifier: {
            requestPermission: () => {
                lab.counts.permission++;
                return lab.op(lab.deferPermission, () => "granted");
            },
            show: notification => {
                lab.shown.push(notification.body);
                return Promise.resolve(true);
            },
        },
        store: lab.store,
    };
    return new Controller(deps);
}

function stateOf(c: Controller, lab: Lab): string {
    return JSON.stringify({
        metrics: c.metrics(),
        processes: c.processes(),
        snapshot: c.snapshot(),
        status: c.status(),
        refreshing: c.refreshing(),
        doctor: c.doctor(),
        doctorRunning: c.doctorRunning(),
        storageWarning: c.storageWarning(),
        liveExpiry: c.liveExpiry(),
        now: c.now(),
        ready: c.ready(),
        settings: c.settings(),
        shown: lab.shown.length,
    });
}

// ----- the sources ---------------------------------------------------------------------------------------------------

interface Source {
    name: string;
    configure(lab: Lab): void;
    /** Runs right after each start (the source's own trigger). */
    afterStart(lab: Lab, c: Controller, timers: ManualTimers): void;
    /** The source's own counter. */
    count(lab: Lab): number;
    /** After a fresh start and its release: the source published its result. */
    publishedFresh(lab: Lab, c: Controller, timers: ManualTimers): boolean;
}

const SOURCES: Source[] = [
    {
        name: "cpu sample",
        configure: lab => { lab.deferSample = true; },
        afterStart: () => undefined,
        count: lab => lab.counts.sample,
        publishedFresh: (_lab, c) => c.metrics().cpu !== undefined,
    },
    {
        name: "process list",
        configure: lab => { lab.deferList = true; },
        afterStart: (_lab, c) => c.toggleProcesses("memory"),
        count: lab => lab.counts.list,
        publishedFresh: (_lab, c) => c.processes().rows !== null,
    },
    {
        name: "provider refresh",
        configure: lab => { lab.deferRefresh = true; },
        afterStart: () => undefined,
        count: lab => lab.counts.refresh,
        publishedFresh: (_lab, c) => c.status() === "idle",
    },
    {
        name: "doctor",
        configure: lab => { lab.deferDoctor = true; },
        afterStart: (_lab, c) => void c.runDoctor(),
        count: lab => lab.counts.doctor,
        publishedFresh: (_lab, c) => c.doctor() !== null && !c.doctorRunning(),
    },
    {
        name: "settings load",
        configure: lab => { lab.deferRead = true; },
        afterStart: () => undefined,
        count: lab => lab.counts.read,
        publishedFresh: (_lab, c) => c.ready(),
    },
    {
        name: "settings save",
        configure: lab => { lab.deferWrite = true; },
        afterStart: (_lab, c) => {
            c.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));
            c.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
        },
        count: lab => lab.counts.write,
        // The property that matters: once everything that can settle has settled, the disk holds the newest value this
        // process requested (75). With a stuck write that never settles, nothing behind it may land (the disk keeps
        // the value it had).
        publishedFresh: lab => (lab.neverResolves
            ? lab.diskThreshold() === defaultSettings().diskAlertThreshold
            : lab.diskThreshold() === 75),
    },
    {
        name: "clock tick",
        configure: () => undefined,
        afterStart: (lab, _c, timers) => {
            lab.deferLoad = true;
            timers.advance(CLOCK_TICK_MS);
            lab.deferLoad = false;
        },
        count: lab => lab.counts.load,
        publishedFresh: (_lab, c) => c.liveExpiry().codex === iso(T0 + 45 * MINUTE),
    },
    {
        name: "notification",
        configure: lab => {
            lab.refreshSnapshot = snapshot(provider("fresh", window("5-hour", 92)), provider("fresh", window("5-hour", 51)));
            lab.deferPermission = true;
        },
        afterStart: () => undefined,
        count: lab => lab.counts.permission,
        publishedFresh: lab => lab.shown.length > 0,
    },
];

// ----- the matrix ----------------------------------------------------------------------------------------------------

type Step = "start" | "stop";
const MATRICES: { label: string; steps: Step[] }[] = [
    { label: "start -> stop", steps: ["start", "stop"] },
    { label: "start -> stop -> start", steps: ["start", "stop", "start"] },
    { label: "start -> stop -> start -> stop", steps: ["start", "stop", "start", "stop"] },
];

async function runMatrix(source: Source, steps: Step[], resolution: "late" | "never"): Promise<void> {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    source.configure(lab);
    const c = makeController(lab, timers);
    let tags = 0;
    for (const step of steps) {
        if (step === "start") {
            lab.tag = ++tags;
            void c.start();
            await settle();
            source.afterStart(lab, c, timers);
            await settle();
        } else {
            c.stop();
            await settle();
        }
    }
    const finalStopped = steps[steps.length - 1] === "stop";
    const isStale = (entry: Entry) => finalStopped || entry.tag !== lab.tag;
    lab.neverResolves = resolution === "never";
    const before = { state: stateOf(c, lab), total: lab.total(), shown: lab.shown.length };
    if (finalStopped) expect(timers.count()).toBe(0);

    if (resolution === "late") {
        // Every stale operation completes late. Work the live generation queued behind one of them starts when it
        // lands (a save), so the release runs until nothing stale is left; nothing else may change.
        await lab.releaseAll(isStale);
        expect(stateOf(c, lab)).toBe(before.state);
        expect(lab.shown.length).toBe(before.shown);
        expect(lab.total()).toBe(before.total);
        if (finalStopped) expect(timers.count()).toBe(0);
    }

    if (finalStopped) {
        // A later start is not blocked by the stale operations, which stay pending (or were resolved above).
        const countBefore = source.count(lab);
        lab.tag = ++tags;
        void c.start();
        await settle();
        source.afterStart(lab, c, timers);
        await settle();
        expect(source.count(lab) > countBefore).toBe(true);
        await lab.releaseAll(entry => entry.tag === lab.tag);
        expect(source.publishedFresh(lab, c, timers)).toBe(true);
    } else {
        // The live generation's own operations are not blocked either: they complete and publish.
        await lab.releaseAll(entry => entry.tag === lab.tag);
        expect(source.publishedFresh(lab, c, timers)).toBe(true);
    }
    c.stop();
    await settle();
    expect(timers.count()).toBe(0);
}

for (const source of SOURCES) {
    for (const matrix of MATRICES) {
        for (const resolution of ["late", "never"] as const) {
            test(`lifecycle · ${source.name} · ${matrix.label} · ${resolution}`, async () => {
                await runMatrix(source, matrix.steps, resolution);
            });
        }
    }
}

// ----- Sol's repros, verbatim in intent -----------------------------------------------------------------------------

test("repro: start with a deferred CPU sample => stop => start => stop => release the original sample: no further sampler call", async () => {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    lab.deferSample = true;
    const c = makeController(lab, timers);
    lab.tag = 1;
    void c.start();
    await settle();
    expect(lab.counts.sample).toBe(1);
    c.stop();
    lab.tag = 2;
    void c.start();
    await settle();
    c.stop();
    await settle();
    const invocationsAfterFinalStop = lab.counts.sample;
    lab.release(() => true);
    await settle();
    expect(lab.counts.sample).toBe(invocationsAfterFinalStop);
    expect(c.metrics().cpu).toBe(undefined);
});

test("repro: deferred doctor => stop => resolve: the doctor state is not published", async () => {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    lab.deferDoctor = true;
    const c = makeController(lab, timers);
    lab.tag = 1;
    void c.start();
    await settle();
    void c.runDoctor();
    await settle();
    c.stop();
    lab.release(() => true);
    await settle();
    expect(c.doctor()).toBe(null);
    expect(c.doctorRunning()).toBe(false);
});

// ----- C: hanging samplers are abandoned at their time limit ---------------------------------------------------------

test("a hanging CPU sample is abandoned after 15 seconds: the metric reads unavailable, the queued follow-up is bounded too, and the next tick reads again", async () => {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    const settings = defaultSettings();
    settings.metrics.cpu = { enabled: true, seconds: 2 };
    lab.setSavedSettings(settings);
    lab.deferSample = true;
    const c = makeController(lab, timers);
    lab.tag = 1;
    void c.start();
    await settle();
    // A manual request joins the sample that is hanging and queues one follow-up; its promise settles after that
    // follow-up, which is bounded as well, so it settles at two time limits.
    let settled = false;
    const manual = c.sampleMetric("cpu", "manual").then(() => { settled = true; });
    timers.advance(SAMPLE_TIMEOUT_MS);
    await settle();
    expect(c.metrics().cpu?.available).toBe(false);
    expect(settled).toBe(false);
    timers.advance(SAMPLE_TIMEOUT_MS);
    await manual;
    expect(settled).toBe(true);
    // The guard is released: the next interval tick (2 s) takes a new sample.
    const samplesBefore = lab.counts.sample;
    lab.deferSample = false;
    timers.advance(2000);
    await settle();
    expect(lab.counts.sample > samplesBefore).toBe(true);
    expect(c.metrics().cpu?.percent).toBe(10);
    c.stop();
    await settle();
    expect(timers.count()).toBe(0);
});

test("a hanging process-list read is abandoned after 15 seconds; reopening the list reads again", async () => {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    lab.deferList = true;
    const c = makeController(lab, timers);
    lab.tag = 1;
    void c.start();
    await settle();
    c.toggleProcesses("memory");
    await settle();
    timers.advance(SAMPLE_TIMEOUT_MS);
    await settle();
    expect(c.processes().rows).toEqual([]);
    lab.deferList = false;
    c.toggleProcesses("memory");
    c.toggleProcesses("memory");
    await settle();
    expect(lab.counts.list).toBe(2); // the first list and the reopened one
    expect((c.processes().rows ?? []).map(row => row.name)).toEqual(["codex"]);
    c.stop();
});

test("a stale sampler that never answers does not hold a later generation's samples", async () => {
    const timers = new ManualTimers(T0);
    const lab = new Lab();
    lab.deferSample = true;
    const c = makeController(lab, timers);
    lab.tag = 1;
    void c.start();
    await settle();
    c.stop();
    lab.deferSample = false;
    lab.tag = 2;
    void c.start();
    await settle();
    expect(c.metrics().cpu?.percent).toBe(10);
    c.stop();
});
