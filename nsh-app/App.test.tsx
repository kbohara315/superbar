import { expect, open, test } from "nsh/test";
import { defaultSettings } from "./src/settings";
import type { DoctorCheck, MetricName, MetricReading, Settings, Snapshot } from "./src/types";
import { HOUR, iso, MINUTE, provider, snapshot, T0, window } from "./tests/fakes";

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
