import { expect, open, test } from "nsh/test";
import { defaultSettings } from "./src/settings";
import type { DoctorCheck, MetricName, MetricReading, Settings, Snapshot } from "./src/types";
import { createDashboardWindows, startTray } from "./src/windows";
import type { DesktopPort, WindowHandle } from "./src/windows";
import type { Screen } from "./src/controller";
import { installTray } from "./src/tray";
import type { TrayActions, TrayPort } from "./src/tray";
import { harness, HOUR, iso, MINUTE, provider, settle, snapshot, T0, window } from "./tests/fakes";

// The dashboard under test: the real Dashboard over fake ports (tests/harness.tsx), at a fixed clock.
function dashboard(scenario: {
    snapshot?: Snapshot | null;
    settings?: Settings | null;
    readings?: Partial<Record<MetricName, MetricReading>>;
    doctor?: DoctorCheck[];
    storageInsecure?: boolean;
}) {
    return open("./tests/harness.tsx", {
        clock: { time: new Date(T0) },
        storage: {
            scenario: JSON.stringify({
                snapshot: scenario.snapshot ?? null,
                settings: scenario.settings ?? null,
                readings: scenario.readings ?? {},
                doctor: scenario.doctor ?? [],
                storageInsecure: scenario.storageInsecure ?? false,
            }),
        },
    });
}

// Codex fresh at 20% used (weekly 40%); Claude has no data at all.
function liveSnapshot(): Snapshot {
    return snapshot(
        provider("fresh", window("5-hour", 20), window("Weekly", 40, 2 * 24 * HOUR)),
        provider("unavailable", null, null, { error: { code: "credentials_missing", message: "no credentials" } }),
    );
}

test("app mounts", async () => {
    const app = await open("./App.tsx", { clock: { time: new Date(T0) } });
    expect(app.texts()).toContain("Superbar");
});

test("a fresh provider card shows Live, its windows with the remaining percentage, and the reset countdown", async () => {
    const app = await dashboard({ snapshot: liveSnapshot() });
    await app.waitFor("text:Live");
    const texts = app.texts();
    expect(texts).toContain("Codex");
    expect(texts).toContain("Live");
    expect(texts).toContain("80% left");
    expect(texts).toContain("60% left");
    expect(texts).toContain("5-hour");
    expect(texts).toContain("Weekly");
    expect(texts.some(text => text.startsWith("↻ 3h 0m"))).toBe(true);
    expect(texts.some(text => text.startsWith("Synced "))).toBe(true);
});

test("a stale provider card says Stale and shows its error reason with the fix hint", async () => {
    const stale = snapshot(
        provider("stale", window("5-hour", 20), null, { error: { code: "rate_limited", message: "limited" } }),
        provider("stale", window("5-hour", 51), null),
    );
    const app = await dashboard({ snapshot: stale });
    await app.waitFor("text:Stale");
    expect(app.texts()).toContain("rate_limited: Rate limited; retrying with backoff");
    expect(app.texts()).toContain("80% left");
});

test("an unavailable provider card says Offline, not synced yet, and points at sign-in", async () => {
    const app = await dashboard({ snapshot: liveSnapshot() });
    await app.waitFor("text:Offline");
    const texts = app.texts();
    expect(texts).toContain("Offline");
    expect(texts).toContain("Not synced yet");
    expect(texts).toContain("credentials_missing: Sign in with `claude` to share usage");
});

test("the expired window shows the reset text and the unknown usage, not its old percentage", async () => {
    const expired = snapshot(
        provider("fresh", window("5-hour", 20, -HOUR), window("Weekly", 40, 2 * 24 * HOUR)),
        provider("unavailable", null, null),
    );
    const app = await dashboard({ snapshot: expired });
    await app.waitFor("text:Live");
    const texts = app.texts();
    expect(texts).toContain("reset · usage unknown");
    expect(texts).toContain("↻ reset passed · awaiting data");
    expect(texts).not.toContain("80% left");
});

test("the display setting switches every percentage between remaining and used", async () => {
    const app = await dashboard({ snapshot: liveSnapshot() });
    await app.waitFor("text:80% left");
    expect(app.texts()).toContain("60% left");

    await app.press("id:open-settings");
    await app.waitFor("text:Show remaining usage (off = show used)");
    await app.press("id:show-remaining");
    await app.press("id:settings-back");
    await app.waitFor("text:20% used");
    expect(app.texts()).toContain("40% used");
    expect(app.texts()).not.toContain("80% left");
});

test("the settings screen opens from the gear and goes back to usage", async () => {
    const app = await dashboard({ snapshot: liveSnapshot() });
    await app.waitFor("text:80% left");
    expect(app.texts()).toContain("Usage");

    await app.press("id:open-settings");
    await app.waitFor("text:Settings");
    expect(app.shows("text:Usage and disk alerts")).toBe(true);
    expect(app.shows("text:80% left")).toBe(false);

    await app.press("id:settings-back");
    await app.waitFor("text:80% left");
    expect(app.shows("text:Usage and disk alerts")).toBe(false);
});

test("enabled system metrics show as tiles, and disabled ones do not", async () => {
    const settings: Settings = {
        ...defaultSettings(),
        metrics: {
            ...defaultSettings().metrics,
            cpu: { enabled: true, seconds: 2 },
            memory: { enabled: true, seconds: 5 },
            network: { enabled: true, seconds: 1 },
        },
    };
    const app = await dashboard({
        snapshot: liveSnapshot(),
        settings,
        readings: {
            cpu: { name: "cpu", available: true, percent: 12, text: "12%", history: [8, 10, 12] },
            memory: { name: "memory", available: true, percent: 39, text: "6.2 GB", detail: "of 16 GB", history: [39] },
            network: { name: "network", available: true, percent: 1.5, text: "↓ 1.2 KB/s", detail: "↑ 0.3 KB/s", history: [1.5] },
        },
    });
    await app.waitFor("text:12%");
    expect(app.shows("id:tile-cpu")).toBe(true);
    expect(app.shows("id:tile-memory")).toBe(true);
    expect(app.shows("id:tile-network")).toBe(true);
    expect(app.shows("id:tile-disk")).toBe(false);
    const texts = app.texts();
    expect(texts).toContain("6.2 GB");
    expect(texts).toContain("of 16 GB");
    expect(texts).toContain("↓ 1.2 KB/s");
});

test("the settings doctor lists each check with its status", async () => {
    const app = await dashboard({
        snapshot: liveSnapshot(),
        doctor: [
            { name: "data_dir", status: "ok", detail: "private and usable" },
            { name: "claude_credentials", status: "warn", detail: "no credential file" },
        ],
    });
    await app.waitFor("text:80% left");
    await app.press("id:open-settings");
    await app.waitFor("text:[ok]");
    const texts = app.texts();
    expect(texts).toContain("[ok]");
    expect(texts).toContain("[warn]");
    expect(texts).toContain("claude_credentials");
});

test("a snapshot that could not be saved privately warns in settings without an error state", async () => {
    const app = await dashboard({ snapshot: liveSnapshot(), storageInsecure: true });
    await app.waitFor("text:80% left");
    expect(app.texts().some(text => text.startsWith("Not saved:"))).toBe(false);
    await app.press("id:open-settings");
    await app.waitFor("id:storage-warning");
    expect(app.texts().some(text => text.startsWith("Not saved:"))).toBe(true);
    await app.press("id:settings-back");
    await app.waitFor("text:80% left");
    expect(app.texts()).toContain("Live");
});

test("the storage note is at the top of the settings screen, above the usage switches", async () => {
    const app = await dashboard({ snapshot: liveSnapshot(), storageInsecure: true });
    await app.waitFor("text:80% left");
    await app.press("id:open-settings");
    await app.waitFor("id:storage-warning");
    const texts = app.texts();
    const note = texts.findIndex(text => text.startsWith("Not saved:"));
    expect(note >= 0).toBe(true);
    expect(note < texts.indexOf("USAGE")).toBe(true);
});

// The token line sits on its own line and is never cut short: each variant must read in full on the card.
test("the card shows the full token line when the token expires later", async () => {
    const expiring = snapshot(
        provider("fresh", window("5-hour", 20), window("Weekly", 40, 2 * 24 * HOUR), { expiresAt: iso(T0 + 20 * MINUTE) }),
        provider("unavailable", null, null),
    );
    const app = await dashboard({ snapshot: expiring });
    await app.waitFor("id:codex-token");
    expect(app.texts()).toContain("token expires in 20m");
});

test("the card shows the full token line when the CLI renews the token on next use", async () => {
    const renewing = snapshot(
        provider("fresh", window("5-hour", 20), window("Weekly", 40, 2 * 24 * HOUR), { expiresAt: iso(T0 - MINUTE) }),
        provider("unavailable", null, null),
    );
    const app = await dashboard({ snapshot: renewing });
    await app.waitFor("id:codex-token");
    expect(app.texts()).toContain("token renews on next use");
});

test("the card shows the full token line, and the sign-in hint, after a failed sign-in", async () => {
    const expired = snapshot(
        provider("stale", window("5-hour", 20), null, { expiresAt: iso(T0 - MINUTE), error: { code: "authentication_required", message: "sign in" } }),
        provider("unavailable", null, null),
    );
    const app = await dashboard({ snapshot: expired });
    await app.waitFor("id:codex-token");
    expect(app.texts()).toContain("token expired · sign in again");
    expect(app.texts()).toContain("authentication_required: Run `codex` to sign in again");
});

// The disk's time-to-full and the battery's time-left are the point of those tiles: their detail lines wrap, never cut.
test("the disk and battery tiles show their full detail lines, time estimates included", async () => {
    const settings: Settings = {
        ...defaultSettings(),
        metrics: {
            ...defaultSettings().metrics,
            disk: { enabled: true, seconds: 30 },
            battery: { enabled: true, seconds: 30 },
        },
    };
    const app = await dashboard({
        snapshot: liveSnapshot(),
        settings,
        readings: {
            disk: { name: "disk", available: true, percent: 40, text: "40%", detail: "55.9 GB free · full in 3h 12m" },
            battery: { name: "battery", available: true, percent: 60, text: "60%", detail: "Discharging · 2h 14m left" },
        },
    });
    await app.waitFor("text:55.9 GB free · full in 3h 12m");
    expect(app.texts()).toContain("Discharging · 2h 14m left");
});

// ----- Dashboard windows (src/windows.ts) over a fake desktop ------------------------------------------------------------
// App.tsx's own wiring (the real nsh/desktop calls and process.platform) cannot be injected into a headless
// open("./App.tsx"), so these tests cover the logic App.tsx delegates to, with the same port shape. The real calls on
// Windows and macOS are NOT exercised by them.

interface Fake {
    port: DesktopPort;
    calls: string[];
    screens: Screen[];
    /** Makes a named call throw from now on. */
    fail: Set<string>;
    state: { minimized: boolean; hidden: boolean } | null;
    closeWindow(): void;
    count(name: string): number;
    windows: WindowHandle[];
}

function fakeDesktop(platform: string): Fake {
    const fake: Fake = {
        calls: [],
        screens: [],
        fail: new Set(),
        state: null,
        windows: [],
        closeWindow: () => undefined,
        count: name => fake.calls.filter(call => call === name).length,
        port: undefined as unknown as DesktopPort,
    };
    const record = (name: string) => {
        fake.calls.push(name);
        if (fake.fail.has(name)) throw new Error(`${name} failed`);
    };
    fake.port = {
        isAvailable: true,
        platform,
        openWindow: onClosed => {
            record("openWindow");
            fake.closeWindow = onClosed;
            const handle: WindowHandle = { focus: () => record("focus"), hide: () => record("hide") };
            fake.windows.push(handle);
            return handle;
        },
        setTitle: () => record("setTitle"),
        setFrame: () => record("setFrame"),
        setSkipTaskbar: skip => record(`setSkipTaskbar(${skip})`),
        minimize: () => record("minimize"),
        orderFront: () => record("orderFront"),
        windowState: () => fake.state,
    };
    return fake;
}

function windowsFor(fake: Fake) {
    return createDashboardWindows({
        port: fake.port,
        setScreen: screen => fake.screens.push(screen),
        appName: "Superbar",
        size: { width: 380, height: 660 },
    });
}

test("tray failure raises the main window once, however many later tray sets fail", () => {
    const fake = fakeDesktop("windows");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    expect(fake.calls).toContain("setSkipTaskbar(true)");
    fake.calls.length = 0;
    windows.onTrayFailed();
    windows.onTrayFailed();
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(1);
    expect(fake.count("setSkipTaskbar(false)")).toBe(1);
    expect(windows.inMain()).toBe(true);
    expect(windows.trayFailed()).toBe(true);
    expect(windows.shown()).toBe(true);
});

test("a tray failure before startup keeps the main window up: it is not hidden or minimized", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.onTrayFailed();
    fake.calls.length = 0;
    windows.hideMainWindow();
    expect(fake.calls).toEqual([]);
});

test("Linux: open, hide, reopen and close of the second window, and the screen it starts on", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    expect(fake.calls).toEqual(["setTitle", "minimize"]);
    expect(windows.inMain()).toBe(false);
    expect(windows.shown()).toBe(false);

    windows.open();
    expect(fake.count("openWindow")).toBe(1);
    expect(fake.screens).toEqual(["usage"]);
    expect(windows.shown()).toBe(true);

    windows.hide();
    expect(fake.count("hide")).toBe(1);
    expect(windows.shown()).toBe(false);

    // Reopening a hidden window keeps the screen it was on.
    windows.open();
    expect(fake.screens).toEqual(["usage"]);
    expect(windows.shown()).toBe(true);

    // Closing it by the user unmounts it: the next open starts on Usage again.
    fake.closeWindow();
    expect(windows.shown()).toBe(false);
    windows.hide();
    expect(fake.count("hide")).toBe(1);
    windows.open();
    expect(fake.screens).toEqual(["usage", "usage"]);
    expect(windows.shown()).toBe(true);

    windows.open("settings");
    expect(fake.screens).toEqual(["usage", "usage", "settings"]);
});

test("a second window whose hide() throws is still reported as showing", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.open();
    fake.fail.add("hide");
    windows.hide();
    expect(windows.shown()).toBe(true);
});

test("macOS: the main window is the dashboard; open raises it, hide minimizes it, windowState drives shown", () => {
    const fake = fakeDesktop("macos");
    const windows = windowsFor(fake);
    expect(windows.inMain()).toBe(true);
    windows.hideMainWindow();
    expect(fake.calls).toEqual(["setTitle", "setFrame", "minimize"]);
    expect(fake.count("setSkipTaskbar(true)")).toBe(0);

    fake.state = { minimized: true, hidden: false };
    expect(windows.shown()).toBe(false);
    windows.open();
    expect(fake.count("openWindow")).toBe(0);
    expect(fake.count("orderFront")).toBe(1);
    fake.state = { minimized: false, hidden: false };
    expect(windows.shown()).toBe(true);
    windows.hide();
    expect(fake.count("minimize")).toBe(2);
    fake.state = { minimized: true, hidden: false };
    expect(windows.shown()).toBe(false);
    fake.state = { minimized: false, hidden: true };
    expect(windows.shown()).toBe(false);
});

test("without windowState the main window's shown flag follows what this app did, and only successes count", () => {
    const fake = fakeDesktop("macos");
    const windows = windowsFor(fake);
    fake.fail.add("orderFront");
    windows.open();
    expect(windows.shown()).toBe(false);
    fake.fail.delete("orderFront");
    windows.open();
    expect(windows.shown()).toBe(true);
    fake.fail.add("minimize");
    windows.hide();
    expect(windows.shown()).toBe(true);
    fake.fail.delete("minimize");
    windows.hide();
    expect(windows.shown()).toBe(false);
});

test("a host whose Window.open throws falls back to the main window, once, and keeps working", () => {
    const fake = fakeDesktop("linux");
    fake.fail.add("openWindow");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open("settings");
    expect(windows.inMain()).toBe(true);
    expect(fake.screens).toEqual(["settings"]);
    expect(fake.count("orderFront")).toBe(1);
    expect(windows.shown()).toBe(true);
    windows.hide();
    expect(windows.shown()).toBe(false);
    windows.open();
    // The second window is not tried again.
    expect(fake.count("openWindow")).toBe(1);
    expect(fake.count("orderFront")).toBe(2);
});

test("Windows: the placeholder leaves the taskbar, a main window that carries the dashboard has its entry back and keeps it when hidden", () => {
    const fake = fakeDesktop("windows");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    expect(fake.calls).toEqual(["setTitle", "setSkipTaskbar(true)", "minimize"]);

    // Second windows are not taskbar-managed by this app.
    windows.open();
    windows.hide();
    expect(fake.count("setSkipTaskbar(false)")).toBe(0);

    // The tray fails later: the main window is raised with its taskbar entry restored first.
    fake.calls.length = 0;
    windows.onTrayFailed();
    expect(fake.calls).toEqual(["setSkipTaskbar(false)", "setFrame", "orderFront"]);

    // Hiding it now only minimizes: the entry stays so the taskbar can restore it.
    fake.calls.length = 0;
    windows.hide();
    expect(fake.calls).toEqual(["minimize"]);
    windows.open();
    expect(fake.calls).toEqual(["minimize", "setSkipTaskbar(false)", "orderFront"]);
});

test("Windows: a failing taskbar call neither blocks raising the window nor leaves it up at startup", () => {
    const fake = fakeDesktop("windows");
    fake.fail.add("setSkipTaskbar(true)");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    expect(fake.count("minimize")).toBe(1);
    fake.fail.add("setSkipTaskbar(false)");
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(1);
    expect(windows.shown()).toBe(true);
});

test("Linux and macOS never touch the taskbar", () => {
    for (const platform of ["linux", "macos"]) {
        const fake = fakeDesktop(platform);
        const windows = windowsFor(fake);
        windows.hideMainWindow();
        windows.open();
        windows.onTrayFailed();
        expect(fake.calls.filter(call => call.startsWith("setSkipTaskbar"))).toEqual([]);
    }
});

test("a host without nsh/desktop does nothing", () => {
    const fake = fakeDesktop("linux");
    fake.port.isAvailable = false;
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    windows.onTrayFailed();
    expect(fake.calls).toEqual([]);
});

// ----- the second window and the main window both showing; trayFailed retry; tray wiring ----------------------------------

test("tray failure with a second dashboard window showing hides it, so one Hide and one shown() cover what is on screen", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    expect(windows.shown()).toBe(true);
    fake.calls.length = 0;
    windows.onTrayFailed();
    // The main window is raised first; the second window is put away only once that worked.
    expect(fake.calls).toEqual(["setFrame", "orderFront", "hide"]);
    expect(windows.inMain()).toBe(true);
    expect(windows.shown()).toBe(true);
    windows.hide();
    expect(fake.count("minimize")).toBe(1); // this Hide (the startup minimize was cleared above)
    expect(windows.shown()).toBe(false);
});

test("if the second window cannot be hidden when the tray fails, both are tracked and one Hide hides both", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    fake.fail.add("hide");
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(1);
    expect(windows.shown()).toBe(true);

    // Hide: the main window is minimized, the second one's hide throws: still showing, and Hide stays usable.
    windows.hide();
    expect(fake.count("minimize")).toBe(2);
    expect(windows.shown()).toBe(true);

    // Its hide works again: the next Hide finishes the job.
    fake.fail.delete("hide");
    windows.hide();
    expect(windows.shown()).toBe(false);
    expect(fake.count("hide")).toBe(3);
});

test("Window.open throwing while the second window is showing hides it and falls back to the main window", () => {
    for (const platform of ["linux", "windows"]) {
        const fake = fakeDesktop(platform);
        const windows = windowsFor(fake);
        windows.hideMainWindow();
        windows.open();
        expect(windows.shown()).toBe(true);
        // Every open() calls Window.open again (nsh returns the open window for the same id); now the host throws.
        fake.fail.add("openWindow");
        fake.calls.length = 0;
        windows.open();
        expect(fake.calls.filter(call => call === "hide" || call === "orderFront")).toEqual(["orderFront", "hide"]);
        expect(windows.inMain()).toBe(true);
        expect(windows.shown()).toBe(true);
        windows.hide();
        expect(windows.shown()).toBe(false);
    }
});

test("Windows: Window.open throwing falls back to the main window and clears the taskbar flag first", () => {
    const fake = fakeDesktop("windows");
    fake.fail.add("openWindow");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    expect(fake.calls).toEqual(["setTitle", "setSkipTaskbar(true)", "minimize"]);
    fake.calls.length = 0;
    windows.open("settings");
    expect(fake.calls).toEqual(["openWindow", "setSkipTaskbar(false)", "setFrame", "orderFront"]);
    expect(windows.inMain()).toBe(true);
    expect(windows.shown()).toBe(true);
    // Hide only minimizes: the entry stays.
    fake.calls.length = 0;
    windows.hide();
    expect(fake.calls).toEqual(["minimize"]);
});

test("tray failure whose orderFront throws is not latched: the next failure raises the window, and only then it is done", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    fake.fail.add("orderFront");
    windows.onTrayFailed();
    expect(windows.trayFailed()).toBe(true);
    expect(windows.shown()).toBe(false);
    expect(fake.count("orderFront")).toBe(1);

    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(2);

    fake.fail.delete("orderFront");
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(3);
    expect(windows.shown()).toBe(true);

    // Raised: later failures leave it alone.
    windows.onTrayFailed();
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(3);
});

test("tray failure with a second window showing and orderFront throwing: the second window stays visible and tracked, a later success retires it", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    fake.fail.add("orderFront");
    windows.onTrayFailed();
    // Main did not come up, so the second window is not touched: it is still the visible dashboard.
    expect(fake.count("hide")).toBe(0);
    expect(windows.shown()).toBe(true);
    // Hide still reaches it.
    fake.fail.delete("orderFront");
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(2);
    expect(fake.count("hide")).toBe(1);
    expect(windows.shown()).toBe(true);
    // Only main is left showing: one Hide covers it, the second is not hidden again.
    windows.hide();
    expect(windows.shown()).toBe(false);
    expect(fake.count("hide")).toBe(1);
});

test("Window.open throwing with a second window showing and orderFront throwing keeps the second window; a later open retires it", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    fake.fail.add("openWindow");
    fake.fail.add("orderFront");
    windows.open();
    expect(fake.count("hide")).toBe(0);
    expect(windows.shown()).toBe(true);
    fake.fail.delete("orderFront");
    windows.open();
    expect(fake.count("hide")).toBe(1);
    expect(windows.shown()).toBe(true);
    windows.hide();
    expect(windows.shown()).toBe(false);
});

test("if retiring the second window fails after main is raised, it stays tracked and Hide retries it", () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    windows.hideMainWindow();
    windows.open();
    fake.fail.add("hide");
    windows.onTrayFailed();
    expect(fake.count("orderFront")).toBe(1);
    expect(windows.shown()).toBe(true);
    fake.fail.delete("hide");
    windows.hide();
    expect(fake.count("hide")).toBe(2);
    expect(windows.shown()).toBe(false);
});

// App.tsx's wiring: the real installTray over a fake tray port, with the failure reported to the windows.
const noActions: TrayActions = {
    openDashboard: () => undefined,
    hideDashboard: () => undefined,
    dashboardShown: () => true,
    refreshProvider: () => undefined,
    refreshAll: () => undefined,
    runDoctor: () => undefined,
};

test("startTray installs the tray first, then puts the main window away", async () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    const h = harness();
    const order: string[] = [];
    const sent: TrayPort = { available: () => true, set: () => { order.push("tray.set"); } };
    startTray({
        windows,
        port: sent,
        install: port => {
            order.push("install");
            installTray(h.controller, noActions, port);
            order.push("installed");
        },
    });
    await settle();
    expect(order[0]).toBe("install");
    expect(order).toContain("tray.set");
    // The main window is put away after install returned, not before it.
    expect(fake.calls).toEqual(["setTitle", "minimize"]);
    expect(windows.trayFailed()).toBe(false);
});

test("startTray: a tray whose set throws raises the main window and does not minimize it, however often it is re-sent", async () => {
    const fake = fakeDesktop("windows");
    const windows = windowsFor(fake);
    const h = harness();
    let sets = 0;
    const broken: TrayPort = { available: () => true, set: () => { sets += 1; throw new Error("no tray"); } };
    startTray({ windows, port: broken, install: port => installTray(h.controller, noActions, port) });
    await settle();
    expect(sets).toBeGreaterThan(0);
    expect(windows.trayFailed()).toBe(true);
    expect(windows.inMain()).toBe(true);
    expect(fake.count("orderFront")).toBe(1);
    expect(fake.count("minimize")).toBe(0);
    expect(fake.calls).not.toContain("setSkipTaskbar(true)");

    // A changed payload is sent again and fails again: the window is not raised again.
    h.controller.snapshot.set(liveSnapshot());
    await settle();
    expect(sets).toBeGreaterThan(1);
    expect(fake.count("orderFront")).toBe(1);
});

test("startTray: a tray port that is unavailable sets nothing, and the placeholder is still put away", async () => {
    const fake = fakeDesktop("linux");
    const windows = windowsFor(fake);
    const h = harness();
    let calls = 0;
    const none: TrayPort = { available: () => false, set: () => { calls += 1; } };
    startTray({ windows, port: none, install: port => installTray(h.controller, noActions, port) });
    await settle();
    expect(calls).toBe(0);
    expect(windows.trayFailed()).toBe(false);
});
