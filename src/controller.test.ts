import { expect, test } from "nsh/test";
import type { RefreshOutcome } from "./providers";
import type { MetricName, Settings, Snapshot } from "./types";
import { defaultSettings, serializeSettings } from "./settings";
import { FETCH_TIMEOUT_MS, FOLLOW_UP_MS, LOAD_TIMEOUT_MS, SAVE_TIMEOUT_MS, SETTINGS_LOADING, SETTINGS_NOT_SAVED, SETTINGS_STALLED, SETTINGS_UNUSABLE } from "./controller";
import { settingsStore, SerialQueue } from "./store";
import { depsFor, fakeChmod, MemoryFs, DeferredSampler, DeferredStore, Harness, MemoryStore, harness, HOUR, iso, MINUTE, okOutcome, provider, reading, settle, snapshot, T0, window } from "../tests/fakes";
import { defaultSettings as defaults } from "./settings";
import type { SettingsRead, StorePort } from "./controller";

const rateLimited = (): Snapshot => snapshot(
    provider("stale", window("5-hour", 22), null, { error: { code: "rate_limited", message: "limited" } }),
    provider("stale", window("5-hour", 51), null, { error: { code: "rate_limited", message: "limited" } }),
);
const clean = (): Snapshot => snapshot(provider("fresh", window("5-hour", 22)), provider("fresh", window("5-hour", 51)));

// Codex's 5-hour window at `codex` percent used; Claude stays low so it never alerts.
function fresh(codex: number, reset: number = 3 * HOUR): Snapshot {
    return snapshot(provider("fresh", window("5-hour", codex, reset)), provider("fresh", window("5-hour", 10, reset)));
}

// ----- first paint and settings --------------------------------------------------------------------------------------

test("start shows the cached snapshot before any refresh finishes", async () => {
    const h = harness({ saved: clean() });
    h.providers.respond = () => new Promise<RefreshOutcome>(() => undefined); // a refresh that never answers
    await h.controller.start();
    await settle();
    expect(h.controller.ready()).toBe(true);
    expect(h.controller.snapshot()?.providers.codex.windows.primary?.used_percent).toBe(22);
    expect(h.controller.status()).toBe("refreshing");
});

test("a missing settings file starts with the defaults and no note; a damaged one starts with the defaults and a note", async () => {
    const missing = harness({ settings: null });
    await missing.controller.start();
    await settle();
    expect(missing.controller.settings()).toEqual(defaultSettings());
    expect(missing.controller.storageWarning()).toBe(null);

    const damaged = harness({ settings: "{oops" });
    await damaged.controller.start();
    await settle();
    expect(damaged.controller.settings()).toEqual(defaultSettings());
    expect(damaged.controller.storageWarning() ?? "").toContain("damaged");
});

test("settings written by one run are read by the next", async () => {
    const first = harness();
    await first.controller.start();
    await settle();
    first.controller.updateSettings(s => ({ ...s, showRemaining: false, diskAlertThreshold: 75 }));
    const last = first.store.writes.at(-1) ?? "";
    expect(last).toContain("\"showRemaining\": false");

    const second = harness({ settings: last });
    await second.controller.start();
    await settle();
    expect(second.controller.settings().showRemaining).toBe(false);
    expect(second.controller.settings().diskAlertThreshold).toBe(75);
});

test("interval edits are clamped: provider refresh to at least 60 seconds, metrics to 1s to 1h", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, providerRefresh: { enabled: true, seconds: 5 } }));
    expect(h.controller.settings().providerRefresh.seconds).toBe(60);
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, cpu: { enabled: true, seconds: 0 } } }));
    expect(h.controller.settings().metrics.cpu.seconds).toBe(1);
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, cpu: { enabled: true, seconds: 7200 } } }));
    expect(h.controller.settings().metrics.cpu.seconds).toBe(3600);
});

// ----- provider refresh, backoff and failure states ------------------------------------------------------------------

test("automatic refresh backs off after rate limits: doubling, capped at 15 minutes, restored by a clean refresh", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(rateLimited());
    await h.controller.start(); // the first refresh is rate limited
    await settle();
    expect(h.controller.rateLimitStreak).toBe(1);
    expect(h.controller.providerIntervalSeconds).toBe(120);

    // The base-interval tick at 60s falls before the 120s deadline, so it is skipped.
    h.timers.advance(MINUTE);
    await settle();
    expect(h.providers.calls.length).toBe(1);
    h.timers.advance(MINUTE);
    await settle();
    expect(h.providers.calls.length).toBe(2);
    expect(h.controller.providerIntervalSeconds).toBe(240);

    const intervals: number[] = [];
    for (let i = 0; i < 4; i++) {
        h.timers.advance(h.controller.providerIntervalSeconds * 1000);
        await settle();
        intervals.push(h.controller.providerIntervalSeconds);
    }
    expect(intervals).toEqual([480, 900, 900, 900]);

    h.providers.respond = () => okOutcome(clean());
    await h.controller.refreshAll();
    expect(h.controller.rateLimitStreak).toBe(0);
    expect(h.controller.providerIntervalSeconds).toBe(60);
});

test("manual refreshes run during a backoff, and a card refresh does not change it", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(rateLimited());
    await h.controller.start();
    await settle();
    expect(h.controller.rateLimitStreak).toBe(1);

    h.providers.respond = () => okOutcome(clean());
    await h.controller.refreshProvider("codex");
    expect(h.providers.calls.at(-1)).toBe("codex");
    expect(h.controller.rateLimitStreak).toBe(1);

    await h.controller.refreshAll();
    expect(h.controller.rateLimitStreak).toBe(0);
});

test("a fetch that outlasts 40 seconds says Refresh timed out and keeps the last values", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.providers.respond = () => new Promise<RefreshOutcome>(() => undefined);
    const pending = h.controller.refreshAll();
    h.timers.advance(FETCH_TIMEOUT_MS - 1);
    await settle();
    expect(h.controller.status()).toBe("refreshing");
    h.timers.advance(1);
    await pending;
    expect(h.controller.status()).toBe("timeout");
    expect(h.controller.snapshot()?.providers.codex.windows.primary?.used_percent).toBe(22);
});

test("a lock held by another refresh says Refresh busy and changes nothing", async () => {
    const h = harness({ saved: clean() });
    await h.controller.start();
    await settle();
    h.providers.respond = () => Promise.resolve({ status: "busy" });
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("busy");
    expect(h.controller.snapshot()?.providers.claude.windows.primary?.used_percent).toBe(51);
});

test("a failed refresh says Refresh failed and keeps the last good snapshot", async () => {
    const h = harness({ saved: clean() });
    await h.controller.start();
    await settle();
    h.providers.respond = () => Promise.reject(new Error("network down"));
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("failed");
    expect(h.controller.snapshot()?.providers.codex.windows.primary?.used_percent).toBe(22);
});

test("the next successful refresh clears a failure message", async () => {
    const h = harness({ saved: clean() });
    h.providers.respond = () => Promise.reject(new Error("network down"));
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("failed");
    h.providers.respond = () => okOutcome(clean());
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("idle");
});

test("the token expiry is read again on each clock tick", async () => {
    const h = harness({ saved: clean() });
    await h.controller.start();
    await settle();
    expect(h.controller.liveExpiry().codex).toBe(null);
    const later = iso(T0 + 20 * MINUTE);
    h.providers.saved = snapshot(provider("fresh", window("5-hour", 22), null, { expiresAt: later }), provider("fresh", null));
    h.timers.advance(30_000);
    await settle();
    expect(h.controller.liveExpiry().codex).toBe(later);
});

// ----- usage alerts --------------------------------------------------------------------------------------------------

test("usage alerts fire at 80% and 90% once per window period, judged on used percent", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(fresh(85));
    await h.controller.start();
    await settle();
    expect(h.notifier.shown.map(n => n.body)).toEqual(["Codex 5-hour: 15% left"]);

    h.providers.respond = () => okOutcome(fresh(88));
    await h.controller.refreshAll();
    expect(h.notifier.shown.length).toBe(1);

    h.providers.respond = () => okOutcome(fresh(92));
    await h.controller.refreshAll();
    expect(h.notifier.shown.map(n => n.body)).toEqual(["Codex 5-hour: 15% left", "Codex 5-hour: 8% left"]);
});

test("a new window period alerts again, and a reset with prior usage says so", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(fresh(85));
    await h.controller.start();
    await settle();
    // The provider keeps returning the old window while it is past its reset: its usage is unknown, not 85%.
    h.timers.advance(3 * HOUR + MINUTE);
    await settle();
    h.providers.respond = () => okOutcome(fresh(85, 8 * HOUR));
    await h.controller.refreshAll();
    expect(h.notifier.shown.map(n => n.body)).toEqual([
        "Codex 5-hour: 15% left",
        "Codex 5-hour window reset",
        "Codex 5-hour: 15% left",
        "Claude Code 5-hour window reset", // Claude's window had 10% used and reset too
    ]);
});

test("stale data never raises a usage alert", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(snapshot(provider("stale", window("5-hour", 97)), provider("stale", null)));
    await h.controller.start();
    await settle();
    expect(h.notifier.shown.length).toBe(0);
});

test("with alerts off nothing is shown, and turning them back on does not replay old levels", async () => {
    const h = harness();
    h.controller.updateSettings(s => ({ ...s, alerts: false }));
    h.providers.respond = () => okOutcome(fresh(95));
    await h.controller.start();
    await settle();
    expect(h.notifier.shown.length).toBe(0);
    h.controller.updateSettings(s => ({ ...s, alerts: true }));
    await settle();
    await h.controller.refreshAll();
    expect(h.notifier.shown.length).toBe(0);
});

test("a denied notification permission keeps alerts silent without an error", async () => {
    const h = harness({ permission: "denied" });
    h.providers.respond = () => okOutcome(fresh(95));
    await h.controller.start();
    await settle();
    expect(h.notifier.requests).toBe(1);
    expect(h.notifier.shown.length).toBe(0);
    expect(h.controller.status()).toBe("idle");
});

// ----- system metrics ------------------------------------------------------------------------------------------------

test("a disk alert fires once at the threshold and re-arms below it", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, disk: { enabled: true, seconds: 30 } } }));
    const disk = (percent: number) => {
        h.metrics.readings.disk = { name: "disk", available: true, percent, text: `${percent}%`, detail: "55.9 GB free · full in 3h 12m" };
    };
    await settle();
    disk(92);
    await h.controller.sampleMetric("disk");
    disk(93);
    await h.controller.sampleMetric("disk");
    expect(h.notifier.shown.map(n => n.body)).toEqual(["Disk 92% used · full in 3h 12m"]);
    disk(80);
    await h.controller.sampleMetric("disk");
    disk(91);
    await h.controller.sampleMetric("disk");
    expect(h.notifier.shown.length).toBe(2);
});

test("a disabled metric is not sampled, and enabling it samples at once", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.metrics.samples = [];
    await h.controller.sampleMetric("memory");
    expect(h.metrics.samples.length).toBe(0);
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, memory: { enabled: true, seconds: 5 } } }));
    await settle();
    expect(h.metrics.samples).toEqual(["memory"]);
});

test("an enabled metric samples on its own interval", async () => {
    const h = harness();
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, cpu: { enabled: true, seconds: 2 } } }));
    await h.controller.start();
    await settle();
    h.metrics.samples = [];
    h.timers.advance(2000);
    await settle();
    expect(h.metrics.samples).toEqual(["cpu"]);
    // Each tick is two seconds apart: let one sample finish before the next tick arrives.
    h.timers.advance(2000);
    await settle();
    h.timers.advance(2000);
    await settle();
    expect(h.metrics.samples).toEqual(["cpu", "cpu", "cpu"]);
});

test("a switched-off system refresh stops automatic sampling but a manual sample still works", async () => {
    const h = harness();
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, cpu: { enabled: true, seconds: 2 } } }));
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, systemRefresh: { enabled: false } }));
    h.metrics.samples = [];
    h.timers.advance(10_000);
    await settle();
    expect(h.metrics.samples.length).toBe(0);
    await h.controller.sampleMetric("cpu");
    expect(h.metrics.samples).toEqual(["cpu"]);
});

test("a rate metric takes a follow-up reading about a second after its baseline", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, network: { enabled: true, seconds: 60 } } }));
    await settle();
    h.metrics.readings.network = { name: "network", available: true, text: "sampling…" };
    h.metrics.samples = [];
    await h.controller.sampleMetric("network");
    expect(h.metrics.samples).toEqual(["network"]);
    h.timers.advance(FOLLOW_UP_MS);
    await settle();
    expect(h.metrics.samples).toEqual(["network", "network"]);
});

test("the top-process list opens on a click and closes on the second", async () => {
    const h = harness();
    await h.controller.start();
    await settle();
    h.metrics.processes = [{ name: "codex", value: 2048, text: "2.0 MB" }];
    h.controller.toggleProcesses("memory");
    await settle();
    expect(h.controller.processes().metric).toBe("memory");
    expect((h.controller.processes().rows ?? []).map(r => r.name)).toEqual(["codex"]);
    h.controller.toggleProcesses("memory");
    expect(h.controller.processes().metric).toBe(null);
});

// ----- burn rate and doctor ------------------------------------------------------------------------------------------

test("the burn-rate line needs three samples spanning ten minutes", async () => {
    const h = harness();
    // Codex usage climbs two points a minute, so the limit would run out before the reset.
    h.providers.respond = () => okOutcome(snapshot(
        provider("fresh", window("5-hour", 10 + Math.round((h.timers.now - T0) / MINUTE) * 2)),
        provider("fresh", window("5-hour", 10)),
    ));
    await h.controller.start();
    await settle();
    const current = () => h.controller.snapshot()?.providers.codex.windows.primary ?? null;
    expect(h.controller.paceLine("codex", "primary", current())).toBe("");
    for (let minute = 0; minute < 5; minute++) {
        h.timers.advance(MINUTE);
        await settle();
    }
    expect(h.controller.paceLine("codex", "primary", current())).toBe("");
    for (let minute = 0; minute < 5; minute++) {
        h.timers.advance(MINUTE);
        await settle();
    }
    expect(h.controller.paceLine("codex", "primary", current())).toContain("at this pace the limit runs out at");
});

test("doctor stores the checks it runs", async () => {
    const h = harness();
    h.providers.doctorChecks = [{ name: "claude_credentials", status: "warn", detail: "no credential file" }];
    await h.controller.runDoctor();
    expect(h.controller.doctor()).toEqual([{ name: "claude_credentials", status: "warn", detail: "no credential file" }]);
    expect(h.controller.doctorRunning()).toBe(false);
});

test("start with no cache and a failing refresh still runs: no snapshot, failed status, usage screen", async () => {
    const h = harness();
    h.providers.respond = () => Promise.reject(new Error("no data directory"));
    await h.controller.start();
    await settle();
    expect(h.controller.snapshot()).toBe(null);
    expect(h.controller.status()).toBe("failed");
    expect(h.controller.screen()).toBe("usage");
});

test("a snapshot that could not be saved privately still shows, with a storage warning and no error state", async () => {
    const h = harness();
    h.providers.respond = () => Promise.resolve({
        status: "ok",
        snapshot: clean(),
        storage: { persisted: false, error: { code: "storage_insecure", message: "not private" } },
    });
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("idle");
    expect(h.controller.storageWarning()).toContain("private permissions");
    expect(h.controller.snapshot()?.providers.codex.windows.primary?.used_percent).toBe(22);

    h.providers.respond = () => okOutcome(clean());
    await h.controller.refreshAll();
    expect(h.controller.storageWarning()).toBe(null);
});

test("the provider layer's own 35-second timeout is the same state as the UI's timeout", async () => {
    const h = harness({ saved: clean() });
    await h.controller.start();
    await settle();
    h.providers.respond = () => Promise.reject(Object.assign(new Error("deadline"), { code: "timeout" }));
    await h.controller.refreshAll();
    expect(h.controller.status()).toBe("timeout");
    expect(h.controller.snapshot()?.providers.codex.windows.primary?.used_percent).toBe(22);
});

// ----- regression tests for the review round (each fails on the pre-fix controller) ------------------------------------

// The controller hands each change to the store at once and reports; the store orders the writes (store.ts). These
// tests check the hand-over, the note's lifecycle, and the real store behind the controller.

let folders = 0;
/** A data folder no other test uses, so a stuck write in one test never reaches another (the queue is per folder). */
function freshFolder(): string {
    return `/data-${++folders}`;
}

/** Holds the first temporary write (the first save's) until the returned function is called. */
function holdFirstTemp(fs: MemoryFs): () => void {
    let temporaries = 0;
    return fs.holdWritesTo(path => path.endsWith(".tmp") && temporaries++ === 0);
}

function diskThreshold(fs: MemoryFs, dir: string): number | null {
    const text = fs.entries.get(`${dir}/settings.json`)?.text;
    return text === undefined ? null : JSON.parse(text).diskAlertThreshold;
}

test("settings: every change is handed to the store at once, in order, without waiting for an earlier save", async () => {
    const store = new DeferredStore();
    const h = harness({ store });
    await h.controller.start();
    await settle();
    store.calls.length = 0;
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 60 }));
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
    expect(store.calls.map(call => JSON.parse(call.text).diskAlertThreshold)).toEqual([60, 70, 75]);
});

test("settings: a save still running past its limit shows the not-saved note, and the note clears when the newest save lands", async () => {
    const store = new DeferredStore();
    const h = harness({ store });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 60 }));
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
    expect(h.controller.storageWarning()).toBe(null);
    h.timers.advance(SAVE_TIMEOUT_MS);
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_STALLED);
    store.calls[0].release();                       // an earlier save lands: the newest one is still running
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_STALLED);
    store.calls[1].release();                       // the newest lands: the note clears
    await settle();
    expect(h.controller.storageWarning()).toBe(null);
});

test("settings: a save that fails shows the write note, and the next save that lands clears it", async () => {
    let attempts = 0;
    const flaky: StorePort = {
        read: async (): Promise<SettingsRead> => ({ kind: "missing" }),
        write: async () => {
            if (attempts++ === 0) throw Object.assign(new Error("not private"), { code: "settings_insecure" });
        },
    };
    const h = harness({ store: flaky });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 60 }));
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_NOT_SAVED);
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
    await settle();
    expect(h.controller.storageWarning()).toBe(null);
});

test("repro (Sol) through the controller: 70 stuck, 75 requested, 70 released late: the disk holds 75, never 70", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const release = holdFirstTemp(fs); // the first write is stuck
    const store = settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))!;
    const h = harness({ store });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));   // stuck
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));   // waits behind the stuck write
    await settle();
    expect(diskThreshold(fs, dir)).toBe(null);
    release();                                                              // 70 lands late
    await settle();
    expect(diskThreshold(fs, dir)).toBe(75);
    expect(fs.writes.length).toBe(2);                                       // 70, then 75: never 70 after 75
});

test("settings: a stuck save past its limit shows the note, later saves wait behind it, and the newest is written after it", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const release = holdFirstTemp(fs);
    const h = harness({ store: settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))! });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));
    await settle();
    h.timers.advance(SAVE_TIMEOUT_MS);
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_STALLED);
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
    h.timers.advance(SAVE_TIMEOUT_MS);
    await settle();
    expect(fs.writes.length).toBe(1);                                        // the newer save does not overtake the stuck one
    release();
    await settle();
    expect(diskThreshold(fs, dir)).toBe(75);
    expect(h.controller.storageWarning()).toBe(null);
});

test("settings: stop and start in the middle keep the newest save: the disk holds it and the next start loads it", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const release = holdFirstTemp(fs);
    const h = harness({ store: settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))! });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));   // stuck
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));   // waiting
    h.controller.stop();
    release();
    await settle();
    expect(diskThreshold(fs, dir)).toBe(75);
    const restart = harness({ store: settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))! });
    await restart.controller.start();
    await settle();
    expect(restart.controller.settings().diskAlertThreshold).toBe(75);
});

test("settings: a change made while the settings are still loading is kept over the loaded value", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    store.readResult = { kind: "loaded", text: JSON.stringify({ showRemaining: true }) };
    const h = harness({ store });
    const starting = h.controller.start();
    h.controller.updateSettings(s => ({ ...s, showRemaining: false }));
    store.finishRead();
    await starting;
    await settle();
    expect(h.controller.settings().showRemaining).toBe(false);
    expect(JSON.parse(store.calls.at(-1)?.text ?? "{}").showRemaining).toBe(false);
});

// ----- one way in: a late read and a user change are the same change (applySettings) ---------------------------------

const DAY_MS = 60_000;

interface Observed {
    settings: string;
    intervals: number[];
    immediateSamples: string[];
    immediateRefreshes: number;
    immediatePermissions: number;
    laterSamples: string[];
    laterRefreshes: number;
}

// Advances the clock in one-second steps, letting each step's samples settle (a timer that fires while its last sample is
// still in flight is skipped, as it should be; advancing in one jump would skip them for the wrong reason).
async function stepSeconds(h: Harness, seconds: number): Promise<void> {
    for (let i = 0; i < seconds; i++) {
        h.timers.advance(1000);
        await settle();
    }
}

// Applies `apply`, then runs a minute on: what the timers, samplers, provider refreshes and permission requests did.
async function observe(h: Harness, apply: () => void): Promise<Observed> {
    const samples0 = h.metrics.samples.length;
    const refreshes0 = h.providers.calls.length;
    const permissions0 = h.notifier.requests;
    apply();
    await settle();
    const samples1 = h.metrics.samples.length;
    const refreshes1 = h.providers.calls.length;
    await stepSeconds(h, DAY_MS / 1000);
    return {
        settings: serializeSettings(h.controller.settings()),
        intervals: h.timers.intervals(),
        immediateSamples: h.metrics.samples.slice(samples0, samples1),
        immediateRefreshes: refreshes1 - refreshes0,
        immediatePermissions: h.notifier.requests - permissions0,
        laterSamples: h.metrics.samples.slice(samples1),
        laterRefreshes: h.providers.calls.length - refreshes1,
    };
}

interface TransitionRow {
    name: string;
    /** The settings before the change (both paths start from them). */
    before: (s: Settings) => Settings;
    /** The change: a user edit makes it, a late read delivers it. */
    after: (s: Settings) => Settings;
    /** What the change must do, so the table cannot pass by doing nothing on both paths. */
    effect: (o: Observed) => boolean;
}

const withMetric = (name: MetricName, enabled: boolean, seconds: number) => (s: Settings): Settings =>
    ({ ...s, metrics: { ...s.metrics, [name]: { enabled, seconds } } });

const TRANSITIONS: TransitionRow[] = [
    { name: "CPU is switched on at 2s", before: s => s, after: withMetric("cpu", true, 2),
        effect: o => o.laterSamples.includes("cpu") && o.intervals.includes(2000) },
    { name: "memory and disk are switched on at 5s and 30s", before: s => s,
        after: s => withMetric("disk", true, 30)(withMetric("memory", true, 5)(s)),
        effect: o => o.laterSamples.includes("memory") && o.laterSamples.includes("disk") },
    { name: "CPU is switched off", before: withMetric("cpu", true, 2), after: withMetric("cpu", false, 2),
        effect: o => !o.intervals.includes(2000) && !o.laterSamples.includes("cpu") },
    { name: "CPU interval changes from 2s to 5s", before: withMetric("cpu", true, 2), after: withMetric("cpu", true, 5),
        effect: o => o.intervals.includes(5000) && !o.intervals.includes(2000) },
    { name: "global system refresh is switched off while CPU is on", before: withMetric("cpu", true, 2),
        after: s => ({ ...s, systemRefresh: { enabled: false } }),
        effect: o => !o.laterSamples.includes("cpu") },
    { name: "global system refresh is switched on while CPU is on", before: s => ({ ...withMetric("cpu", true, 2)(s), systemRefresh: { enabled: false } }),
        after: s => ({ ...s, systemRefresh: { enabled: true } }),
        effect: o => o.laterSamples.includes("cpu") },
    { name: "provider refresh is switched off", before: s => s,
        after: s => ({ ...s, providerRefresh: { ...s.providerRefresh, enabled: false } }),
        effect: o => o.laterRefreshes === 0 },
    { name: "provider refresh is switched on", before: s => ({ ...s, providerRefresh: { ...s.providerRefresh, enabled: false } }),
        after: s => ({ ...s, providerRefresh: { ...s.providerRefresh, enabled: true } }),
        effect: o => o.laterRefreshes >= 1 },
    { name: "provider refresh interval becomes 120s", before: s => s,
        after: s => ({ ...s, providerRefresh: { ...s.providerRefresh, seconds: 120 } }),
        effect: o => o.intervals.includes(120_000) && o.laterRefreshes === 0 },
    // Provider refresh is off in this row: a refresh that completes asks for permission too (applySnapshot), which would
    // hide a missing transition. Without it, only the alert switch itself can ask.
    { name: "alerts are switched on (permission is asked)",
        before: s => ({ ...s, alerts: false, providerRefresh: { ...s.providerRefresh, enabled: false } }),
        after: s => ({ ...s, alerts: true, providerRefresh: { ...s.providerRefresh, enabled: false } }),
        effect: o => o.immediatePermissions === 1 },
];

// The change as a user makes it: the controller runs, and the edit is applied.
async function userChange(row: TransitionRow): Promise<{ observed: Observed; writes: number }> {
    const store = new MemoryStore(serializeSettings(row.before(defaultSettings())));
    const h = harness({ store });
    await h.controller.start();
    await settle();
    const observed = await observe(h, () => h.controller.updateSettings(() => row.after(row.before(defaultSettings()))));
    return { observed, writes: store.writes.length };
}

// The same change as a late read delivers it: the first read timed out, and the saved file arrives after the limit.
async function lateReadChange(row: TransitionRow): Promise<{ observed: Observed; writes: number }> {
    const store = new DeferredStore();
    store.readResult = { kind: "loaded", text: serializeSettings(row.before(defaultSettings())) };
    const h = harness({ store });
    await h.controller.start();
    await settle();
    h.controller.stop();
    store.readResult = { kind: "loaded", text: serializeSettings(row.after(row.before(defaultSettings()))) };
    store.holdRead = true;
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    const observed = await observe(h, () => store.finishRead());
    return { observed, writes: store.calls.length };
}

for (const row of TRANSITIONS) {
    test(`one way in: a late read that ${row.name} runs the same transitions as the user change`, async () => {
        const user = await userChange(row);
        const late = await lateReadChange(row);
        expect(user.observed.intervals.length > 0).toBe(true);
        expect(row.effect(user.observed)).toBe(true);             // the change does something on the user path
        expect(late.observed).toEqual(user.observed);             // the same timers, samples, refreshes and permission asks
        expect(user.writes).toBe(1);                              // the user's change is saved once
        expect(late.writes).toBe(0);                              // the file already holds it: a no-op reconcile writes nothing
    });
}

test("repro (Sol A6): disk 80, a save of 75 fails, stop and start with the read held past its limit, alerts off during the read: the file and the controller agree", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const saved = defaultSettings();
    saved.diskAlertThreshold = 80;
    fs.entries.set(dir, { kind: "dir", mode: 0o700, mtimeMs: 0 });
    fs.entries.set(`${dir}/settings.json`, { kind: "file", mode: 0o600, mtimeMs: 0, text: serializeSettings(saved) });
    const h = harness({ store: settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))! });
    await h.controller.start();
    await settle();
    fs.failWriteWith = { partial: "", error: Object.assign(new Error("disk full"), { code: "ENOSPC" }) };
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));   // this save fails
    await settle();
    expect(diskThreshold(fs, dir)).toBe(80);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const rawReadText = fs.readText.bind(fs);
    fs.readText = async path => { await gate; return rawReadText(path); };   // the restart's read is held
    h.controller.stop();
    const starting = h.controller.start();
    await settle();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    expect((h.controller.storageWarning() ?? "").includes(SETTINGS_LOADING)).toBe(true); // the failed save's note is still up
    h.controller.updateSettings(s => ({ ...s, alerts: false }));           // toggled off while the read is held
    await settle();
    release();
    await settle();
    // The failed 75 is not kept (the file is the truth, the accepted limit); the toggle is kept; disk and controller agree.
    expect(h.controller.settings().diskAlertThreshold).toBe(80);
    expect(h.controller.settings().alerts).toBe(false);
    const disk = JSON.parse(fs.entries.get(`${dir}/settings.json`)?.text ?? "{}");
    expect(disk.diskAlertThreshold).toBe(80);
    expect(disk.alerts).toBe(false);
    expect(h.controller.storageWarning()).toBe(null);
});

test("late read enables CPU at 2s: CPU is sampled every 2 seconds after the read arrives", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    const h = harness({ store });
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    const settings = defaultSettings();
    settings.metrics.cpu = { enabled: true, seconds: 2 };
    settings.providerRefresh.enabled = false;
    store.readResult = { kind: "loaded", text: serializeSettings(settings) };
    store.finishRead();
    await settle();
    const before = h.metrics.samples.filter(name => name === "cpu").length;
    await stepSeconds(h, 6);
    expect(h.metrics.samples.filter(name => name === "cpu").length - before >= 3).toBe(true);
});

test("late read disables provider refresh: no provider refresh happens after the read arrives", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    const h = harness({ store });
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    const settings = defaultSettings();
    settings.providerRefresh.enabled = false;
    store.readResult = { kind: "loaded", text: serializeSettings(settings) };
    store.finishRead();
    await settle();
    const before = h.providers.calls.length;
    h.timers.advance(60_000);
    await settle();
    expect(h.providers.calls.length).toBe(before);
});

// ----- re-entrancy and stop inside a transition (one application at a time, latest value only) -------------------------

test("re-entrant change (Sol A7): a sampler that changes the threshold while CPU is enabled leaves the controller and the file on the latest value", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const saved = defaultSettings();
    saved.alerts = false;
    saved.providerRefresh.enabled = false;
    fs.entries.set(dir, { kind: "dir", mode: 0o700, mtimeMs: 0 });
    fs.entries.set(`${dir}/settings.json`, { kind: "file", mode: 0o600, mtimeMs: 0, text: serializeSettings(saved) });
    const store = settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))!;
    // The CPU sampler changes the threshold while it is being started by the enabling change.
    const h: Harness = harness({
        store,
        sampler: name => ({
            sample: async () => {
                h.controller.updateSettings(x => ({ ...x, diskAlertThreshold: 75 }));
                return { name, available: false, text: "unavailable" };
            },
            topProcesses: async () => [],
        }),
    });
    await h.controller.start();
    await settle();
    fs.writes.length = 0;
    h.controller.updateSettings(x => ({ ...x, metrics: { ...x.metrics, cpu: { enabled: true, seconds: 2 } } }));
    await settle();
    expect(h.controller.settings().diskAlertThreshold).toBe(75);
    expect(h.controller.settings().metrics.cpu.enabled).toBe(true);
    expect(diskThreshold(fs, dir)).toBe(75);                 // the file holds the latest value, not the one the outer change captured
    expect(JSON.parse(fs.entries.get(`${dir}/settings.json`)?.text ?? "{}").metrics.cpu.enabled).toBe(true);
    expect(fs.writes.length).toBe(1);                        // one save of the settings as they now are
    expect(h.controller.storageWarning()).toBe(null);
});

test("stop inside a permission callback (Sol A7): no sampler, timer or further permission work happens after it", async () => {
    const saved = defaultSettings();
    saved.alerts = false;
    saved.providerRefresh.enabled = false;
    const samplesTaken: string[] = [];
    const h = harness({
        settings: serializeSettings(saved),
        sampler: name => ({
            sample: async () => {
                samplesTaken.push(name);
                return { name, available: false, text: "unavailable" };
            },
            topProcesses: async () => [],
        }),
    });
    await h.controller.start();
    await settle();
    let asked = 0;
    h.notifier.requestPermission = async () => {
        asked++;
        h.controller.stop();                                 // the user stops the controller while the permission is asked
        return "granted";
    };
    h.controller.updateSettings(x => ({ ...x, alerts: true, metrics: { ...x.metrics, cpu: { enabled: true, seconds: 2 } } }));
    await settle();
    h.timers.advance(10_000);
    await settle();
    expect(samplesTaken.length).toBe(0);                     // the CPU step that followed never ran
    expect(h.timers.count()).toBe(0);
    expect(asked).toBe(1);                                   // the one request that was already in progress
});

test("stop inside a sampler callback (Sol A7): the metrics after it in the same change are not started", async () => {
    const saved = defaultSettings();
    saved.providerRefresh.enabled = false;
    const samplesTaken: string[] = [];
    let h: Harness | null = null;
    h = harness({
        settings: serializeSettings(saved),
        sampler: name => ({
            sample: async () => {
                samplesTaken.push(name);
                h?.controller.stop();                        // CPU's first reading stops the controller
                return { name, available: false, text: "unavailable" };
            },
            topProcesses: async () => [],
        }),
    });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(x => ({ ...x, metrics: { ...x.metrics, cpu: { enabled: true, seconds: 2 }, memory: { enabled: true, seconds: 5 } } }));
    await settle();
    h.timers.advance(10_000);
    await settle();
    expect(samplesTaken).toEqual(["cpu"]);                   // memory was never started: its step ran after the stop
    expect(h.timers.count()).toBe(0);
});

test("200 edits behind a hung write keep the controller's bookkeeping bounded, and the newest value is written when it lands", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const release = fs.holdWritesTo(path => path.endsWith(".tmp"));   // the first write hangs
    const store = settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))!;
    const h = harness({ store });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 60 }));
    await settle();
    const timersBefore = h.timers.count();
    for (let i = 0; i < 200; i++) h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: i % 2 === 0 ? 70 : 75 }));
    await settle();
    expect(h.timers.count() - timersBefore <= 1).toBe(true);  // one stall timer for the waiting write, not one per edit
    expect(fs.writes.length).toBe(1);
    h.timers.advance(SAVE_TIMEOUT_MS);
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_STALLED);
    release();
    await settle();
    expect(fs.writes.length).toBe(2);
    expect(diskThreshold(fs, dir)).toBe(75);                 // the newest of the 200 edits (the last one, 75)
    expect(h.controller.storageWarning()).toBe(null);
});

// ----- a read that times out, or is still running (the settings known so far are kept; a late read is applied) -------

test("repro (Sol): 70 stuck, 75 requested, stop and start while it is held, the read times out: 75 is kept, and the next toggle keeps 75", async () => {
    const fs = new MemoryFs();
    const dir = freshFolder();
    const release = holdFirstTemp(fs);
    const h = harness({ store: settingsStore(dir, depsFor(fs, fakeChmod(fs).run, { queue: new SerialQueue() }))! });
    await h.controller.start();
    await settle();
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 70 }));   // stuck
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));   // queued behind it
    await settle();
    h.controller.stop();
    const starting = h.controller.start();                                   // its read queues behind the stuck write
    await settle();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    expect(h.controller.settings().diskAlertThreshold).toBe(75);             // not the default 90
    expect(h.controller.storageWarning()).toBe(SETTINGS_LOADING);
    release();                                                               // 70 lands, then 75, then the read answers 75
    await settle();
    expect(diskThreshold(fs, dir)).toBe(75);
    expect(h.controller.settings().diskAlertThreshold).toBe(75);
    expect(h.controller.storageWarning()).toBe(null);
    h.controller.updateSettings(s => ({ ...s, alerts: !s.alerts }));         // the user toggles only alerts
    await settle();
    expect(h.controller.settings().diskAlertThreshold).toBe(75);
    expect(diskThreshold(fs, dir)).toBe(75);
});

test("the first read is slow: a change made before it settles is laid over the loaded values, and the file ends with both", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    store.readResult = { kind: "loaded", text: JSON.stringify({ diskAlertThreshold: 80, showRemaining: false }) };
    const h = harness({ store });
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    expect(h.controller.ready()).toBe(true);
    expect(h.controller.storageWarning()).toBe(SETTINGS_LOADING);
    h.controller.updateSettings(s => ({ ...s, alerts: false }));            // edited before the read settles
    await settle();
    expect(store.calls.length).toBe(0);                                     // no write from defaults
    store.finishRead();
    await settle();
    expect(h.controller.settings().diskAlertThreshold).toBe(80);
    expect(h.controller.settings().showRemaining).toBe(false);
    expect(h.controller.settings().alerts).toBe(false);
    expect(store.calls.length).toBe(1);
    const written = JSON.parse(store.calls[0].text);
    expect(written.diskAlertThreshold).toBe(80);
    expect(written.showRemaining).toBe(false);
    expect(written.alerts).toBe(false);
    expect(h.controller.storageWarning()).toBe(null);
});

test("a first read that never settles: the app is ready, edits are kept in memory, nothing is written, and the loading note stays", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    const h = harness({ store });
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    expect(h.controller.ready()).toBe(true);
    h.controller.updateSettings(s => ({ ...s, diskAlertThreshold: 75 }));
    await settle();
    expect(h.controller.settings().diskAlertThreshold).toBe(75);
    expect(store.calls.length).toBe(0);
    expect(h.controller.storageWarning()).toBe(SETTINGS_LOADING);
});

test("a change made while a restart's read is pending is kept over the value that read returns, and is written at once", async () => {
    const store = new DeferredStore();
    const h = harness({ store });
    await h.controller.start();                                             // the base is known from this read
    await settle();
    h.controller.stop();
    store.readResult = { kind: "loaded", text: JSON.stringify({ alerts: true, showRemaining: true, diskAlertThreshold: 90 }) };
    store.holdRead = true;
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    h.controller.updateSettings(s => ({ ...s, alerts: false }));
    await settle();
    expect(store.calls.length).toBe(1);                                     // the base is known: the whole settings, at once
    store.finishRead();
    await settle();
    expect(h.controller.settings().alerts).toBe(false);
    expect(store.calls.length).toBe(1);
});

test("the damaged-file note is its own: it clears when the next save lands, and is not the loading note", async () => {
    const store = new DeferredStore();
    store.readResult = { kind: "loaded", text: "{oops" };
    const h = harness({ store });
    await h.controller.start();
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_UNUSABLE);
    expect(SETTINGS_UNUSABLE.includes("damaged")).toBe(true);
    expect(SETTINGS_LOADING.includes("damaged")).toBe(false);
    h.controller.updateSettings(s => ({ ...s, alerts: false }));
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_UNUSABLE);          // the save is still running
    store.calls[0].release();
    await settle();
    expect(h.controller.storageWarning()).toBe(null);
});

test("the loading note stays until the read itself settles, even when a save lands in the meantime", async () => {
    const store = new DeferredStore();
    const h = harness({ store });
    await h.controller.start();                                             // base known
    await settle();
    h.controller.stop();
    store.holdRead = true;
    const starting = h.controller.start();
    h.timers.advance(LOAD_TIMEOUT_MS);
    await starting;
    expect(h.controller.storageWarning()).toBe(SETTINGS_LOADING);
    h.controller.updateSettings(s => ({ ...s, alerts: false }));           // known base: saved now
    await settle();
    store.calls[0].release();
    await settle();
    expect(h.controller.storageWarning()).toBe(SETTINGS_LOADING);           // the read has not settled yet
    store.finishRead();
    await settle();
    expect(h.controller.storageWarning()).toBe(null);
});

test("the process list shows loading (no rows yet) until its first read, not an empty list", async () => {
    const sampler = new DeferredSampler("memory");
    const h = harness({ sampler: () => sampler });
    h.controller.toggleProcesses("memory");
    expect(h.controller.processes().rows).toBe(null);
    sampler.listPending[0].release();
    await settle();
    expect(h.controller.processes().rows).toEqual([]);
});

test("stop() while the settings are still loading starts no timers and no refresh", async () => {
    const store = new DeferredStore();
    store.holdRead = true;
    const h = harness({ store });
    const starting = h.controller.start();
    h.controller.stop();
    store.finishRead();
    await starting;
    await settle();
    expect(h.timers.count()).toBe(0);
    expect(h.providers.calls.length).toBe(0);
    expect(h.controller.ready()).toBe(false);
});

test("a metric sample that finishes after stop() publishes nothing and schedules nothing", async () => {
    const sampler = new DeferredSampler("network");
    const h = harness({ sampler: () => sampler });
    h.controller.updateSettings(s => ({ ...s, metrics: { ...s.metrics, network: { enabled: true, seconds: 60 } } }));
    await h.controller.start();
    await settle();
    h.controller.stop();
    sampler.pending[0].release({ name: "network", available: true, text: "sampling…" });
    await settle();
    expect(h.controller.metrics().network).toBe(undefined);
    expect(h.timers.count()).toBe(0);
});

test("stop() clears every timer, and a fetch still waiting on the provider never reports a timeout afterwards", async () => {
    const h = harness({ saved: null });
    h.providers.respond = () => new Promise(() => undefined);
    await h.controller.start();
    await settle();
    expect(h.timers.count() > 0).toBe(true);
    h.controller.stop();
    expect(h.timers.count()).toBe(0);
    const before = h.controller.status();
    h.timers.advance(FETCH_TIMEOUT_MS + MINUTE);
    await settle();
    expect(h.controller.status()).toBe(before);
});

test("stop() clears the CPU process-list follow-up timer", async () => {
    const sampler = new DeferredSampler("cpu");
    sampler.processRows = [{ name: "a", value: 0, text: "—" }];
    const h = harness({ sampler: () => sampler });
    h.controller.toggleProcesses("cpu");
    sampler.listPending[0].release();
    await settle();
    expect(h.timers.count()).toBe(1);
    h.controller.stop();
    expect(h.timers.count()).toBe(0);
});

test("a start after a stop begins one clean generation: no duplicate timers, one refresh per start", async () => {
    const h = harness({ saved: clean() });
    await h.controller.start();
    await settle();
    const timers = h.timers.count();
    h.controller.stop();
    await h.controller.start();
    await settle();
    expect(h.timers.count()).toBe(timers);
    expect(h.providers.calls.length).toBe(2);
});

test("a backward wall-clock change does not stall automatic refresh after rate limits", async () => {
    const h = harness();
    h.providers.respond = () => okOutcome(rateLimited());
    await h.controller.start();
    await settle();
    h.wall.offset = -HOUR; // the wall clock is set back an hour; timers keep firing on the monotonic timeline
    for (let minute = 0; minute < 15; minute++) {
        h.timers.advance(MINUTE);
        await settle();
    }
    expect(h.providers.calls.length > 2).toBe(true);
});

test("a saved file that is not a private regular file is refused: defaults are used and the note says so", async () => {
    const store = new DeferredStore();
    store.readResult = { kind: "untrusted", reason: "settings.json is not private" };
    const h = harness({ store });
    await h.controller.start();
    await settle();
    expect(h.controller.settings()).toEqual(defaults());
    expect(h.controller.storageWarning() ?? "").toContain("not a private regular file");
});
