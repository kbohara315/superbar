// The app's state and scheduler. Everything with a side effect (providers, metric samplers, timers, notifications,
// the settings file, the clocks) comes in through `ControllerDeps`, so the logic runs under test with fakes.
//
// State is held in nsh signals; views read them and re-render. Behaviour follows ../../docs/usage.md:
// provider refresh with rate-limit backoff, a 40-second fetch timeout, last-good values kept on failure, metric
// sampling on per-metric intervals, usage and disk alerts, and burn-rate samples kept in memory.
//
// LIFECYCLE. A Token is a capture of the lifecycle generation: `valid()` turns false at the next stop() (start() also
// begins a generation). Every asynchronous entry below holds the token it was started under, and nothing it started
// may invoke external work, publish state, arm a timer, or notify once its token is stale. Three primitives enforce
// that, so a new async site has to go through one of them:
//   - bounded(token, task, ms): invokes `task` only while the token is valid, and resolves with a Timeout after `ms`
//     or when stop() abandons it, so a hung call can never hold the controller. Returns an Outcome, never rejects.
//   - SerialRuns: one run per key (a metric's samples, a process list). A stale run is neither joined nor waited for;
//     its gate is checked before every invocation, so a queued item of a stopped generation is dropped unrun.
//   - later() / every(): every timer is registered and cancelled by stop(); their callbacks check the token again.
//
// ASYNC AUDIT (every async entry; "gen" is the token; "after" = each continuation)
//  #  entry                                  invoked via                     checks
//  1  start: store.read (requestRead)        bounded(gen) for the startup wait; applyRead always (gen valid, latest request)
//  2  start: loadSnapshot (cache)            bounded(gen)                    after: gen
//  3  start: (none: the store's queue holds earlier writes; nothing to kick)
//  4  start: refreshFull -> fetch            fetch (own token)               see 9-11
//  5  start: sampleEnabledMetrics            sampleMetric(manual)            see 17-18
//  6  start: refreshLiveExpiry               bounded(gen)                    after: gen
//  7  start: clock timer                     every(gen) + guard              tick: gen before publish
//  8  start: provider schedule timer         every(gen) + guard              guard; then fetch
//  9  fetch: refresh                         bounded(gen)                    after: gen before publish; finally gen
// 10  fetch: applySnapshot                   sync, only after #9's gen check  -
// 11  applySnapshot: alert chain            permission.then                 then: gen before evaluate
// 12  applySnapshot: refreshLiveExpiry      bounded(gen)                    after: gen
// 13  clock tick                            timer #7 -> tick(gen)           gen (see #6)
// 14  provider timer -> refreshFull         timer #8                        gen (see #9)
// 15  refreshLiveExpiry                     bounded(gen)                    after: gen
// 16  metric interval timer                 every(gen) -> sampleMetric      gen (see #17)
// 17  metric run (queued or first)          SerialRuns.execute              gate before EACH invocation and after each await
// 18  sampleOnce: sampler.sample            bounded(gen)                    after: gen, metric epoch, enabled; publishes
//                                                                             unavailable on timeout only while current
// 19  sample follow-up timer                later(gen) -> sampleMetric      gen (see #17)
// 20  process-list run                      SerialRuns.execute              gate before EACH invocation and after each await
// 21  listOnce: topProcesses                bounded(gen)                    after: gen, process epoch, metric open
// 22  cpu process follow-up timer           later(gen) -> loadProcesses     gen (see #20)
// 23  runDoctor: providers.doctor           bounded(gen)                    after: gen before publishing; doctorRunning reset by stop
// 24  saves: store.write (queued, store.ts) bounded(gen) for the note only  the write is never cancelled: it is issued by the
//                                                                             store's queue after the previous write settles;
//                                                                             the note clears when the newest save lands
// 25  notify: notifier.show                 sync from #11/#18/#25            gen before calling show
// 26  askPermission: requestPermission      bounded(gen)                    after: gen before recording the answer
// 27  updateSettings / applyRead -> applySettings  sync; transitions and timers use the current gen; applyRead checks gen first
// 28  stop()                                cancels every timer, abandons every bounded wait, resets state -
// Synchronous UI entries (refreshAll, refreshProvider, toggleProcesses, runDoctor, sampleMetric) capture the current
// token when called; a stop() after that makes all of their continuations inert.

import { signal } from "nsh";
import type { DoctorCheck, MetricName, MetricReading, ProcessEntry, ProviderName, Settings, Snapshot, UsageWindow } from "./types";
import type { RefreshOutcome } from "./providers";
import { diskAlertMessage, nextRateLimitStreak, paceProjection, paceText, providerBackoffSeconds, windowAlerts } from "./model";
import { changedLeaves, defaultSettings, METRIC_NAMES, normalizeSettings, PROVIDER_NAMES, serializeSettings, settingsFromText, withLeaves } from "./settings";

export type RefreshStatus = "idle" | "refreshing" | "busy" | "timeout" | "failed";
export type RefreshSelection = "all" | ProviderName;
export type Screen = "usage" | "settings";
export type ProcessMetric = "cpu" | "memory";
/** `rows` is null while the list is loading (the view shows "sampling…"). */
export interface ProcessList { metric: ProcessMetric | null; rows: ProcessEntry[] | null }
export interface PaceSample { t: number; percent: number; resetAt: string }

// Provider fetches get this long before the UI gives up on them (the extension's FETCH_TIMEOUT_MS).
export const FETCH_TIMEOUT_MS = 40_000;
// Bounds for the other external calls. A metric sample or process list that takes longer is abandoned for that tick.
export const SAMPLE_TIMEOUT_MS = 15_000;
export const LOAD_TIMEOUT_MS = 15_000;
export const PERMISSION_TIMEOUT_MS = 15_000;
export const DOCTOR_TIMEOUT_MS = 15_000;
export const SAVE_TIMEOUT_MS = 15_000;
// How often the clock signal moves on, which also re-reads token expiry from the credential files.
export const CLOCK_TICK_MS = 30_000;
// A rate metric needs a second reading before it has a value; this is when the follow-up is taken.
export const FOLLOW_UP_MS = 1_000;
// About two hours of provider refreshes at the default interval.
export const PACE_KEEP = 120;

export const SNAPSHOT_NOT_SAVED = "Not saved: the snapshot could not be stored with private permissions, so these values last only for this run.";
export const SETTINGS_LOADING = "Settings are still loading from disk. Your changes are kept here and saved once the read finishes.";
export const SETTINGS_UNUSABLE = "Saved settings could not be used (not a private regular file, or damaged), so defaults are used for this run.";
export const SETTINGS_NOT_SAVED = "Settings are not saved: the settings folder could not be made private, so they last only for this run.";
export const SETTINGS_WRITE_FAILED = "Settings could not be saved, so they last only for this run.";
export const SETTINGS_STALLED = "Not saved: the settings write is still running, so the newest settings are not on disk yet.";

// The ports. Production wiring is in App.tsx; tests pass fakes (tests/fakes.ts).
export interface TimerPort {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}
export interface ProvidersPort {
    loadSnapshot(): Promise<Snapshot | null>;
    refresh(selection: RefreshSelection): Promise<RefreshOutcome>;
    doctor(): Promise<DoctorCheck[]>;
}
export interface SamplerPort {
    sample(): Promise<MetricReading>;
    topProcesses(kind: ProcessMetric): Promise<ProcessEntry[]>;
}
export interface NotifierPort {
    requestPermission(): Promise<string>;
    show(notification: { id: string; title: string; body: string }): Promise<boolean>;
}
/** What the saved settings file holds (see store.ts). Reading never throws: anything unusual is `untrusted`. */
export type SettingsRead = { kind: "missing" } | { kind: "loaded"; text: string } | { kind: "untrusted"; reason: string };
export interface StorePort {
    read(): Promise<SettingsRead>;
    /**
     * Saves the settings text. Writes are issued one at a time, in request order, and a newer request replaces a waiting
     * one (see store.ts). Resolves when a write holding this text, or a newer one, has landed; rejects when a write fails.
     */
    write(text: string): Promise<void>;
}
export interface ControllerDeps {
    /** Wall-clock milliseconds: for display and reset times only. */
    clock: () => number;
    /** Elapsed milliseconds that never move backwards: for the provider schedule and backoff. */
    monotonic: () => number;
    timers: TimerPort;
    providers: ProvidersPort;
    sampler: (name: MetricName) => SamplerPort;
    notifier: NotifierPort;
    /** Where settings are saved; null keeps them in memory only (no data directory). */
    store: StorePort | null;
}

/** A capture of the lifecycle generation: `valid()` is false once a stop() has happened since the capture. */
export interface Token {
    valid(): boolean;
}

/** The result of an external call made through `bounded`. It never rejects. */
export type Outcome<T> = { kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "timeout" };

const SETTINGS_INSECURE_CODE = "settings_insecure";
const PROVIDER_LABEL: Record<ProviderName, string> = { codex: "Codex", claude: "Claude Code" };
const RATE_METRICS: readonly MetricName[] = ["cpu", "network"];

// A rate's first reading only sets a baseline ("sampling…"): it has neither a percent nor a detail line. Every
// reading with a value carries one or the other.
function isRateBaseline(reading: MetricReading): boolean {
    return reading.available && reading.percent === undefined && reading.detail === undefined;
}

// A metric whose sampler throws or times out is shown as unavailable rather than breaking the other tiles.
function unavailable(name: MetricName): MetricReading {
    return { name, available: false, text: "unavailable" };
}

type Source = "timer" | "manual";
interface Run { token: Token; queued: boolean; done: Promise<void> }

/**
 * At most one run per key. A request while a run of the current generation is active joins it (a manual request
 * queues one follow-up; a timer request is absorbed). A run of a stopped generation is neither joined nor waited for:
 * a new request starts its own run at once. Each step checks the gate before invoking the task.
 */
class SerialRuns<K> {
    private readonly runs = new Map<K, Run>();

    request(key: K, token: Token, gate: () => boolean, source: Source, task: () => Promise<void>, changed: () => boolean): Promise<void> {
        const running = this.runs.get(key);
        if (running && running.token.valid()) {
            if (source === "manual") running.queued = true;
            return running.done;
        }
        const run: Run = { token, queued: false, done: Promise.resolve() };
        this.runs.set(key, run);
        run.done = this.execute(key, run, gate, task, changed);
        return run.done;
    }

    private async execute(key: K, run: Run, gate: () => boolean, task: () => Promise<void>, changed: () => boolean): Promise<void> {
        try {
            let go = gate();
            while (go) {
                run.queued = false;
                await task();
                go = gate() && (run.queued || changed());
            }
        } finally {
            if (this.runs.get(key) === run) this.runs.delete(key);
        }
    }
}

export class Controller {
    readonly settings = signal<Settings>(defaultSettings());
    readonly snapshot = signal<Snapshot | null>(null);
    /** Token expiry read from the credential files on the last tick (null: no file, or none recorded). */
    readonly liveExpiry = signal<Record<ProviderName, string | null>>({ codex: null, claude: null });
    readonly now = signal(0);
    readonly status = signal<RefreshStatus>("idle");
    readonly refreshing = signal<RefreshSelection | null>(null);
    readonly metrics = signal<Partial<Record<MetricName, MetricReading>>>({});
    readonly processes = signal<ProcessList>({ metric: null, rows: null });
    readonly screen = signal<Screen>("usage");
    readonly doctor = signal<DoctorCheck[] | null>(null);
    readonly doctorRunning = signal(false);
    /** Storage problems the views show in settings: snapshot, settings read, and settings write. Null when none. */
    readonly storageWarning = signal<string | null>(null);
    /** True once the saved settings and the cached snapshot are loaded; views wait for it. */
    readonly ready = signal(false);

    private started = false;
    private generation = 0;
    private inFlight = false;
    private rateStreak = 0;
    /** Monotonic time before which automatic provider refresh waits (0: no backoff). */
    private providerNextAt = 0;

    // Timers, keyed by our own ids so stop() can clear every one of them.
    private readonly timers = new Map<number, { handle: unknown; repeat: boolean }>();
    private timerSeq = 0;
    private clockTimer: number | null = null;
    private providerTimer: number | null = null;
    private readonly metricTimers: Partial<Record<MetricName, number | null>> = {};
    private readonly followTimers: Partial<Record<MetricName, number | null>> = {};
    private processFollowTimer: number | null = null;
    /** Bumped when a metric is stopped, so a sample started before that is discarded. */
    private readonly metricEpoch = new Map<MetricName, number>();
    /** Bumped when a process list opens, closes, or stops. */
    private processEpoch = 0;

    private readonly sampling = new SerialRuns<MetricName>();
    private readonly listing = new SerialRuns<ProcessMetric>();
    private readonly abandoners = new Set<() => void>();
    private readonly samplers = new Map<MetricName, SamplerPort>();
    private readonly alertMemo: Record<string, { resetAt: string | null; percent: number | null; levels: number[] }> = {};
    private readonly paceSamples = new Map<string, PaceSample[]>();
    private readonly diskState = { alerted: false };
    private diskEta: string | null = null;
    private notifyAllowed = false;
    private permissionAnswered = false;
    /** The permission request of the current generation, if one is in progress or has been answered. */
    private permissionRequest: Promise<void> | null = null;
    private notifySeq = 0;

    // Settings persistence. The store orders the writes (store.ts); the controller hands each change over at once, and
    // only reports: the note says a save is still running past its limit, and clears when the newest one lands.
    // Settings state. `baseKnown`: a read has settled in this process, so the settings in memory are the saved ones with
    // the user's changes on top, and a save writes all of them. Until then, and while a read is in flight, a change is
    // recorded in `overlay` (per field) and is not written: when the read settles, the loaded values are the base and
    // the overlay is laid over them. A read that times out is still pending; its answer is applied when it arrives.
    private baseKnown = false;
    /** The settings text the disk is believed to hold: what was handed to the store, or what the last read said. */
    private lastWritten: string | null = null;
    /** `lastWritten` when the current read was requested: a write handed out since lands after that read's answer. */
    private lastWrittenAtRead: string | null = null;
    /** The newest settings requested while an application runs: the running one applies them next (applySettings). */
    private pendingApply: Settings | null = null;
    private applying = false;
    /** The save promise the controller last watched: edits queued behind one write share it, so it is watched once. */
    private latestSave: Promise<void> | null = null;
    private readPending = false;
    private readRequest = 0;
    private overlay = new Map<string, unknown>();

    private settingsReadNote: string | null = null;
    private settingsWriteNote: string | null = null;
    private snapshotNote: string | null = null;

    constructor(private readonly deps: ControllerDeps) {}

    // ----- Tokens, timers and bounded calls ------------------------------------------------------------------------

    /** The current generation's token. */
    private token(): Token {
        const gen = this.generation;
        return { valid: () => gen === this.generation };
    }

    /** A token for a new generation (start). */
    private newToken(): Token {
        this.generation++;
        return this.token();
    }

    private later(t: Token, ms: number, run: () => void): number | null {
        if (!t.valid()) return null;
        const id = ++this.timerSeq;
        const handle = this.deps.timers.setTimeout(() => {
            this.timers.delete(id);
            if (t.valid()) run();
        }, ms);
        this.timers.set(id, { handle, repeat: false });
        return id;
    }

    private every(t: Token, ms: number, run: () => void): number | null {
        if (!t.valid()) return null;
        const id = ++this.timerSeq;
        const handle = this.deps.timers.setInterval(() => {
            if (t.valid()) run();
        }, ms);
        this.timers.set(id, { handle, repeat: true });
        return id;
    }

    private cancel(id: number | null | undefined): void {
        if (id === null || id === undefined) return;
        const timer = this.timers.get(id);
        if (!timer) return;
        this.timers.delete(id);
        if (timer.repeat) this.deps.timers.clearInterval(timer.handle);
        else this.deps.timers.clearTimeout(timer.handle);
    }

    private cancelAll(): void {
        for (const id of [...this.timers.keys()]) this.cancel(id);
    }

    /**
     * Runs an external call under a token and a time limit. The task is not invoked at all for a stale token, and the
     * wait ends at the limit or when stop() abandons it. Never rejects: failures come back as an error outcome.
     */
    private bounded<T>(t: Token, task: () => Promise<T>, ms: number): Promise<Outcome<T>> {
        if (!t.valid()) return Promise.resolve({ kind: "timeout" });
        return new Promise<Outcome<T>>(resolve => {
            let settled = false;
            let timer: number | null = null;
            const finish = (outcome: Outcome<T>) => {
                if (settled) return;
                settled = true;
                this.abandoners.delete(abandon);
                this.cancel(timer);
                resolve(outcome);
            };
            const abandon = () => finish({ kind: "timeout" });
            this.abandoners.add(abandon);
            timer = this.later(t, ms, () => finish({ kind: "timeout" }));
            let pending: Promise<T>;
            try {
                pending = task();
            } catch (error) {
                pending = Promise.reject(error);
            }
            pending.then(
                value => finish({ kind: "value", value }),
                error => finish({ kind: "error", error }),
            );
        });
    }

    private epochOf(name: MetricName): number {
        return this.metricEpoch.get(name) ?? 0;
    }

    // ----- Lifecycle ----------------------------------------------------------------------------------------------

    /**
     * Loads the saved settings, shows the cached snapshot at once, then starts the timers and refreshes what is
     * enabled. Resolves after the first paint data is in place; the refresh finishes in the background.
     */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        const t = this.newToken();
        const read = this.requestRead();
        const saved: Outcome<SettingsRead> = await this.bounded(t, () => read, LOAD_TIMEOUT_MS);
        if (!t.valid()) return;
        // A read still running at the startup limit does not hold the app up: it starts with the settings it knows, and
        // says so until the read settles (applyRead).
        if (saved.kind === "timeout" && this.readPending) {
            this.settingsReadNote = SETTINGS_LOADING;
            this.updateStorageWarning();
        }
        const cached = await this.bounded(t, () => this.deps.providers.loadSnapshot(), LOAD_TIMEOUT_MS);
        if (!t.valid()) return;
        if (cached.kind === "value" && cached.value !== null && this.snapshot() === null) this.snapshot.set(cached.value);
        this.now.set(this.deps.clock());
        this.ready.set(true);
        this.clockTimer = this.every(t, CLOCK_TICK_MS, () => this.tick(t));
        if (this.settings().alerts) this.ensureNotifyPermission();
        this.scheduleProvider();
        for (const name of METRIC_NAMES) this.scheduleMetric(name);
        if (this.settings().providerRefresh.enabled) void this.refreshFull();
        this.sampleEnabledMetrics();
        void this.refreshLiveExpiry(t);
    }

    /** Stops every timer, settles every pending wait, and resets the state a run would have shown. */
    stop(): void {
        this.started = false;
        this.generation++;
        this.cancelAll();
        for (const abandon of [...this.abandoners]) abandon();
        this.clockTimer = null;
        this.providerTimer = null;
        this.processFollowTimer = null;
        for (const name of METRIC_NAMES) {
            this.metricTimers[name] = null;
            this.followTimers[name] = null;
            this.metricEpoch.set(name, this.epochOf(name) + 1);
        }
        this.processEpoch++;
        this.inFlight = false;
        this.refreshing.set(null);
        this.doctorRunning.set(false);
        this.permissionRequest = null;
        this.samplers.clear();
        this.metrics.set({});
        this.processes.set({ metric: null, rows: null });
    }

    private tick(t: Token): void {
        if (!t.valid()) return;
        this.now.set(this.deps.clock());
        void this.refreshLiveExpiry(t);
    }

    // ----- Provider refresh and backoff ---------------------------------------------------------------------------

    /** The provider refresh interval in effect: the base interval, doubled per consecutive rate-limited refresh. */
    get providerIntervalSeconds(): number {
        const base = this.settings().providerRefresh.seconds;
        return this.rateStreak > 0 ? providerBackoffSeconds(base, this.rateStreak) : base;
    }

    get rateLimitStreak(): number {
        return this.rateStreak;
    }

    /** The header refresh button: both providers, then every enabled metric. Changes the backoff, as the timer does. */
    async refreshAll(): Promise<void> {
        const pending = this.fetch("all", true);
        this.sampleEnabledMetrics();
        await pending;
    }

    /** A provider card's refresh button: one provider; it neither changes the backoff nor samples metrics. */
    async refreshProvider(name: ProviderName): Promise<void> {
        await this.fetch(name, false);
    }

    private refreshFull(): Promise<void> {
        return this.fetch("all", true);
    }

    private scheduleProvider(): void {
        this.cancel(this.providerTimer);
        this.providerTimer = null;
        if (!this.started) return;
        const { enabled, seconds } = this.settings().providerRefresh;
        if (!enabled) return;
        // The timer ticks at the base interval; ticks before the backoff deadline are skipped.
        this.providerTimer = this.every(this.token(), seconds * 1000, () => {
            if (this.deps.monotonic() + 1000 >= this.providerNextAt) void this.refreshFull();
        });
    }

    private async fetch(selection: RefreshSelection, full: boolean): Promise<void> {
        if (this.inFlight) return;
        const t = this.token();
        this.inFlight = true;
        this.refreshing.set(selection);
        this.status.set("refreshing");
        const startedAt = this.deps.monotonic();
        try {
            const outcome = await this.bounded(t, () => this.deps.providers.refresh(selection), FETCH_TIMEOUT_MS);
            if (!t.valid()) return;
            if (outcome.kind === "timeout") {
                this.status.set("timeout");
            } else if (outcome.kind === "error") {
                // The provider layer's own 35-second deadline rejects with code `timeout`; that is the same state.
                this.status.set((outcome.error as { code?: string }).code === "timeout" ? "timeout" : "failed");
            } else if (outcome.value.status === "busy") {
                this.status.set("busy");
            } else {
                this.snapshotNote = outcome.value.storage ? SNAPSHOT_NOT_SAVED : null;
                this.updateStorageWarning();
                this.applySnapshot(outcome.value.snapshot, full ? startedAt : null, t);
            }
        } finally {
            if (t.valid()) {
                this.inFlight = false;
                this.refreshing.set(null);
            }
        }
    }

    // `fullStartedAt` is the monotonic start of a full refresh, or null for one provider. Only a full refresh moves
    // the backoff. Called only while `t` is still valid.
    private applySnapshot(snapshot: Snapshot, fullStartedAt: number | null, t: Token): void {
        this.snapshot.set(snapshot);
        this.status.set("idle");
        const now = this.deps.clock();
        this.now.set(now);
        if (fullStartedAt !== null) this.recordFullRefresh(snapshot, fullStartedAt);
        this.recordPace(snapshot, now);
        if (this.settings().alerts) this.ensureNotifyPermission();
        const answer = this.permissionRequest ?? Promise.resolve();
        void answer.then(() => {
            if (t.valid()) this.evaluateUsageAlerts(snapshot, now, t);
        });
        void this.refreshLiveExpiry(t);
    }

    private recordFullRefresh(snapshot: Snapshot, startedAtMonotonic: number): void {
        this.rateStreak = nextRateLimitStreak(this.rateStreak, snapshot);
        this.providerNextAt = this.rateStreak > 0
            ? startedAtMonotonic + providerBackoffSeconds(this.settings().providerRefresh.seconds, this.rateStreak) * 1000
            : 0;
    }

    // ----- Token expiry -------------------------------------------------------------------------------------------

    private async refreshLiveExpiry(t: Token): Promise<void> {
        const loaded = await this.bounded(t, () => this.deps.providers.loadSnapshot(), LOAD_TIMEOUT_MS);
        if (!t.valid() || loaded.kind !== "value" || loaded.value === null) return;
        this.liveExpiry.set({
            codex: loaded.value.providers.codex.expires_at,
            claude: loaded.value.providers.claude.expires_at,
        });
    }

    // ----- Burn rate ----------------------------------------------------------------------------------------------

    /** The burn-rate line for one window, or '' until there are enough samples (see model.ts paceProjection). */
    paceLine(name: ProviderName, kind: "primary" | "secondary", window: UsageWindow | null): string {
        if (!window || typeof window.reset_at !== "string") return "";
        return paceText(paceProjection(this.paceSamples.get(`${name}/${kind}`), window.reset_at));
    }

    // Fresh data only, so a carried-forward value never adds a sample.
    private recordPace(snapshot: Snapshot, now: number): void {
        for (const name of PROVIDER_NAMES) {
            const provider = snapshot.providers[name];
            if (provider.state !== "fresh") continue;
            for (const kind of ["primary", "secondary"] as const) {
                const window = provider.windows[kind];
                if (!window || typeof window.reset_at !== "string") continue;
                const key = `${name}/${kind}`;
                const samples = this.paceSamples.get(key) ?? [];
                samples.push({ t: now, percent: window.used_percent, resetAt: window.reset_at });
                if (samples.length > PACE_KEEP) samples.shift();
                this.paceSamples.set(key, samples);
            }
        }
    }

    // ----- Alerts -------------------------------------------------------------------------------------------------

    // Only fresh provider data raises a usage alert. Thresholds are judged on used percent; the wording follows the
    // display setting. The memo updates even with alerts off, so turning them on later does not replay old levels.
    private evaluateUsageAlerts(snapshot: Snapshot, now: number, t: Token): void {
        const mode = this.settings().showRemaining ? "remaining" : "used";
        for (const name of PROVIDER_NAMES) {
            const provider = snapshot.providers[name];
            if (provider.state !== "fresh") continue;
            for (const kind of ["primary", "secondary"] as const) {
                const window = provider.windows[kind];
                if (!window) continue;
                const label = `${PROVIDER_LABEL[name]} ${window.label}`;
                for (const message of windowAlerts(this.alertMemo, `${name}/${kind}`, label, window, now, mode)) {
                    this.notify(message, t);
                }
            }
        }
    }

    private checkDisk(reading: MetricReading, t: Token): void {
        if (!reading.available || typeof reading.percent !== "number") return;
        // The sampler's detail carries the time-to-full estimate as `full in …` (or `full now`).
        const eta = reading.detail?.split(" · ").find(part => part.startsWith("full ")) ?? null;
        this.diskEta = eta;
        const message = diskAlertMessage(this.diskState, reading.percent, this.settings().diskAlertThreshold, eta);
        if (message) this.notify(message, t);
    }

    private notify(message: string, t: Token): void {
        if (!t.valid() || !this.settings().alerts || !this.notifyAllowed) return;
        this.notifySeq += 1;
        this.deps.notifier.show({ id: `superbar-${this.notifySeq}`, title: "Superbar", body: message }).catch(() => undefined);
    }

    // Asks once per generation until answered; a denial (or a platform with no notifications) leaves alerts silent.
    private ensureNotifyPermission(): void {
        if (this.permissionAnswered || this.permissionRequest !== null) return;
        this.permissionRequest = this.askPermission(this.token());
    }

    private async askPermission(t: Token): Promise<void> {
        const outcome = await this.bounded(t, () => this.deps.notifier.requestPermission(), PERMISSION_TIMEOUT_MS);
        // A stopped generation records nothing; the next start asks again.
        if (!t.valid()) return;
        this.permissionAnswered = true;
        this.notifyAllowed = outcome.kind === "value" && outcome.value === "granted";
    }

    // ----- System metrics -----------------------------------------------------------------------------------------

    private samplerFor(name: MetricName): SamplerPort {
        let sampler = this.samplers.get(name);
        if (!sampler) {
            sampler = this.deps.sampler(name);
            this.samplers.set(name, sampler);
        }
        return sampler;
    }

    /**
     * Samples one metric. Timer requests are skipped while a sample is running; manual ones (a tile click, the header
     * button, the first reading) join it and queue one follow-up. Never two samples of one metric at once.
     */
    sampleMetric(name: MetricName, source: Source = "manual"): Promise<void> {
        if (!this.settings().metrics[name].enabled) return Promise.resolve();
        const t = this.token();
        let epochAtStart = this.epochOf(name);
        const gate = () => t.valid() && this.settings().metrics[name].enabled;
        return this.sampling.request(
            name,
            t,
            gate,
            source,
            () => {
                epochAtStart = this.epochOf(name);
                return this.sampleOnce(name, t, epochAtStart);
            },
            () => this.epochOf(name) !== epochAtStart,
        );
    }

    private async sampleOnce(name: MetricName, t: Token, epoch: number): Promise<void> {
        const outcome = await this.bounded(t, () => this.samplerFor(name).sample(), SAMPLE_TIMEOUT_MS);
        if (!t.valid() || this.epochOf(name) !== epoch || !this.settings().metrics[name].enabled) return;
        const reading = outcome.kind === "value" ? outcome.value : unavailable(name);
        this.metrics.set({ ...this.metrics(), [name]: reading });
        if (name === "disk") this.checkDisk(reading, t);
        if (this.processes().metric === name) void this.loadProcesses(name as ProcessMetric, "timer");
        // A rate needs a baseline: the first reading has no percent, so take the next one soon.
        if (RATE_METRICS.includes(name) && isRateBaseline(reading) && (this.followTimers[name] ?? null) === null) {
            this.followTimers[name] = this.later(t, FOLLOW_UP_MS, () => {
                this.followTimers[name] = null;
                void this.sampleMetric(name, "manual");
            });
        }
    }

    sampleEnabledMetrics(): void {
        for (const name of METRIC_NAMES) {
            if (this.settings().metrics[name].enabled) void this.sampleMetric(name, "manual");
        }
    }

    /** The CPU and memory tiles: a click opens the top-five list, a second click closes it. */
    toggleProcesses(name: ProcessMetric): void {
        if (this.processes().metric === name) {
            this.closeProcesses();
            return;
        }
        this.processEpoch++;
        this.processes.set({ metric: name, rows: null });
        void this.loadProcesses(name, "manual");
    }

    private closeProcesses(): void {
        this.processEpoch++;
        this.cancel(this.processFollowTimer);
        this.processFollowTimer = null;
        this.processes.set({ metric: null, rows: null });
    }

    private loadProcesses(name: ProcessMetric, source: Source): Promise<void> {
        const t = this.token();
        let epochAtStart = this.processEpoch;
        const gate = () => t.valid() && this.processes().metric === name;
        return this.listing.request(
            name,
            t,
            gate,
            source,
            () => {
                epochAtStart = this.processEpoch;
                return this.listOnce(name, t, epochAtStart);
            },
            () => this.processEpoch !== epochAtStart,
        );
    }

    private async listOnce(name: ProcessMetric, t: Token, epoch: number): Promise<void> {
        const outcome = await this.bounded(t, () => this.samplerFor(name).topProcesses(name), SAMPLE_TIMEOUT_MS);
        if (!t.valid() || this.processEpoch !== epoch || this.processes().metric !== name) return;
        const rows = outcome.kind === "value" ? outcome.value : [];
        this.processes.set({ metric: name, rows });
        // CPU shares need two readings: the first list has only placeholders, so read again shortly.
        if (name === "cpu" && rows.length > 0 && rows.every(row => row.text === "—") && this.processFollowTimer === null) {
            this.processFollowTimer = this.later(t, FOLLOW_UP_MS, () => {
                this.processFollowTimer = null;
                if (this.processes().metric === "cpu") void this.loadProcesses("cpu", "manual");
            });
        }
    }

    private scheduleMetric(name: MetricName): void {
        this.cancel(this.metricTimers[name]);
        this.metricTimers[name] = null;
        const { enabled, seconds } = this.settings().metrics[name];
        if (!this.started || !enabled || !this.settings().systemRefresh.enabled) return;
        this.metricTimers[name] = this.every(this.token(), seconds * 1000, () => {
            void this.sampleMetric(name, "timer");
        });
    }

    private stopMetric(name: MetricName): void {
        this.cancel(this.metricTimers[name]);
        this.metricTimers[name] = null;
        this.cancel(this.followTimers[name]);
        this.followTimers[name] = null;
        this.metricEpoch.set(name, this.epochOf(name) + 1);
        this.samplers.delete(name);
        this.metrics.set(withoutKey(this.metrics(), name));
        if (this.processes().metric === name) this.closeProcesses();
    }

    // ----- Doctor -------------------------------------------------------------------------------------------------

    async runDoctor(): Promise<void> {
        if (this.doctorRunning()) return;
        const t = this.token();
        this.doctorRunning.set(true);
        const outcome = await this.bounded(t, () => this.deps.providers.doctor(), DOCTOR_TIMEOUT_MS);
        // A stopped generation publishes nothing; stop() has already cleared doctorRunning.
        if (!t.valid()) return;
        if (outcome.kind === "value") {
            this.doctor.set(outcome.value);
        } else {
            const detail = outcome.kind === "timeout" ? "Doctor did not finish in time" : "Doctor could not run";
            this.doctor.set([{ name: "doctor", status: "fail", detail }]);
        }
        this.doctorRunning.set(false);
    }

    // ----- Settings -----------------------------------------------------------------------------------------------

    /**
     * Applies a change to the settings: normalises it (ranges, the 60-second provider floor), saves it, and moves
     * timers and metric sampling to match. `change` gets the current settings and returns the new ones.
     */
    updateSettings(change: (current: Settings) => Settings): void {
        const previous = this.pendingApply ?? this.settings();
        const next = normalizeSettings(change(previous));
        if (!this.baseKnown || this.readPending) {
            for (const [path, value] of changedLeaves(previous, next)) this.overlay.set(path, value);
        }
        this.applySettings(next);
    }

    // The one way the settings change, whatever the cause (a user's edit, the first load, a late read): publish them, run
    // the runtime transitions their difference calls for, and save them when the disk does not hold them.
    // Re-entrancy: a transition's callback can change the settings (a sampler's read, a permission answer). Such a change
    // is queued (`pendingApply`) and applied after the running application finishes, so no application works from a value
    // another one has since replaced, and the file gets the newest value only.
    private applySettings(next: Settings): void {
        this.pendingApply = next;
        if (this.applying) return;
        this.applying = true;
        try {
            while (this.pendingApply !== null) {
                const target = this.pendingApply;
                this.pendingApply = null;
                this.applyOnce(target);
            }
        } finally {
            this.applying = false;
        }
    }

    private applyOnce(next: Settings): void {
        const previous = this.settings();
        const t = this.token();
        this.settings.set(next);
        if (this.started) this.runTransitions(previous, next, t);
        // A change queued meanwhile is saved by its own application, with the value that is current then.
        if (this.pendingApply === null) this.saveIfNotOnDisk();
    }

    // Everything that follows from a change of settings, by diffing previous and next: the provider timer, the alert
    // permission, and each metric's sampler and timer. A step runs only while the generation that started the change is
    // still running: a callback (a permission answer, a sampler's read) can stop the controller in the middle.
    private runTransitions(previous: Settings, next: Settings, t: Token): void {
        const running = () => t.valid() && this.started;
        if (!running()) return;
        if (next.providerRefresh.enabled !== previous.providerRefresh.enabled
            || next.providerRefresh.seconds !== previous.providerRefresh.seconds) {
            this.scheduleProvider();
        }
        if (!running()) return;
        if (next.alerts && !previous.alerts) this.ensureNotifyPermission();
        for (const name of METRIC_NAMES) {
            if (!running()) return;
            const before = previous.metrics[name];
            const after = next.metrics[name];
            if (!after.enabled) {
                if (before.enabled) this.stopMetric(name);
                continue;
            }
            if (!before.enabled) {
                this.stopMetric(name); // a fresh sampler starts a fresh baseline each time a metric is shown
                this.scheduleMetric(name);
                if (!running()) return;
                void this.sampleMetric(name, "manual");
            } else if (before.seconds !== after.seconds || previous.systemRefresh.enabled !== next.systemRefresh.enabled) {
                this.scheduleMetric(name);
            }
        }
    }

    // The persistence rule. Once a read has settled, the disk's settings are known, and the settings in memory are
    // written whenever they differ from what the disk is believed to hold (`lastWritten`). A no-op change writes nothing.
    // Before a read settles nothing is written: the read's answer is the base the changes are laid over (applyRead).
    // It reads the current settings, never a value captured earlier.
    private saveIfNotOnDisk(): void {
        if (!this.baseKnown) return;
        const text = serializeSettings(this.settings());
        if (text === this.lastWritten) return;
        this.lastWritten = text;
        this.persist(text);
    }


    // Asks the store for the saved settings. The answer is applied when it arrives, even after a timeout or a stop
    // (applyRead). A failed read is `untrusted`: the store reports what it found and never throws.
    private requestRead(): Promise<SettingsRead> {
        const request = ++this.readRequest;
        const t = this.token();
        this.readPending = true;
        this.lastWrittenAtRead = this.lastWritten;
        const store = this.deps.store;
        let read: Promise<SettingsRead>;
        try {
            read = store ? store.read() : Promise.resolve<SettingsRead>({ kind: "missing" });
        } catch {
            read = Promise.resolve<SettingsRead>({ kind: "untrusted", reason: "the read failed" });
        }
        const settled = read.catch((): SettingsRead => ({ kind: "untrusted", reason: "the read failed" }));
        void settled.then(answer => this.applyRead(request, t, answer));
        return settled;
    }

    // Applies a read's answer. The answer is what the disk holds (for a missing, damaged or untrusted file: the defaults),
    // so it is the base; the changes made since (the overlay) are laid over it, and applySettings saves the result if it
    // differs from the disk. A read that is superseded, or whose generation was stopped, changes nothing: the next start
    // reads again, and the changes stay recorded until then.
    private applyRead(request: number, t: Token, answer: SettingsRead): void {
        if (request !== this.readRequest || !t.valid()) return;
        this.readPending = false;
        let base = defaultSettings();
        let note: string | null = null;
        if (answer.kind === "loaded") {
            const parsed = settingsFromText(answer.text);
            if (parsed === null) note = SETTINGS_UNUSABLE; // damaged JSON: the defaults, with a note
            else base = parsed;
        } else if (answer.kind === "untrusted") {
            note = SETTINGS_UNUSABLE;
        }
        this.baseKnown = true;
        this.settingsReadNote = note;
        // What the disk will hold: the answer, unless a write was handed out after this read was requested (the queue runs
        // it after the read, so its text is what the disk ends with; a failed one has cleared `lastWritten`).
        const handedSinceRead = this.lastWritten !== this.lastWrittenAtRead;
        if (!handedSinceRead) this.lastWritten = serializeSettings(base);
        const merged = this.overlay.size > 0 ? withLeaves(base, this.overlay) : base;
        this.overlay.clear();
        // If the disk already holds what is shown, a note about an earlier failed save is no longer true: the file was read.
        if (!handedSinceRead && serializeSettings(merged) === this.lastWritten) this.settingsWriteNote = null;
        this.applySettings(merged);
        this.updateStorageWarning();
    }

    // Hands the settings to the store at once (no wait for an earlier save). The returned promise settles when the
    // save has landed, fails, or passed its time limit, so it never hangs; the landing of the newest save always clears
    // the note, and a save still running past its limit shows SETTINGS_STALLED.
    // Hands the text to the store at once (no wait for an earlier save). Edits queued behind one write share its promise
    // (store.ts), so the outcome is watched once per promise: the latest save decides the notes, and the time limit is
    // measured from the write's first request. The controller never waits on a save itself.
    private persist(text: string): void {
        const store = this.deps.store;
        if (!store) return;
        const t = this.token();
        let landed: Promise<void>;
        try {
            landed = store.write(text);
        } catch (error) {
            landed = Promise.reject(error);
        }
        if (landed === this.latestSave) return;
        this.latestSave = landed;
        landed.then(
            () => {
                if (this.latestSave === landed) {
                    this.settingsWriteNote = null;
                    // The file is ours now and valid: an unusable-file note is resolved by it. A read still in flight
                    // keeps its own note.
                    if (this.settingsReadNote === SETTINGS_UNUSABLE) this.settingsReadNote = null;
                    this.updateStorageWarning();
                }
            },
            (error: unknown) => {
                if (this.latestSave === landed) {
                    this.lastWritten = null; // the disk does not hold it: the next change or read writes again
                    this.settingsWriteNote = (error as { code?: string }).code === SETTINGS_INSECURE_CODE ? SETTINGS_NOT_SAVED : SETTINGS_WRITE_FAILED;
                    this.updateStorageWarning();
                }
            },
        );
        void this.bounded(t, () => landed, SAVE_TIMEOUT_MS).then(outcome => {
            if (outcome.kind === "timeout" && t.valid() && this.latestSave === landed) {
                this.settingsWriteNote = SETTINGS_STALLED;
                this.updateStorageWarning();
            }
        });
    }

    private updateStorageWarning(): void {
        const notes = [this.settingsReadNote, this.settingsWriteNote, this.snapshotNote].filter(note => note !== null);
        this.storageWarning.set(notes.length > 0 ? notes.join(" ") : null);
    }
}

function withoutKey<T extends Record<string, unknown>>(record: T, key: string): T {
    const copy = { ...record };
    delete copy[key];
    return copy;
}
