import { expect, test } from "nsh/test";
import { DEFAULT_METRIC_SECONDS } from "./types";
import { clampWhole, defaultSettings, normalizeSettings, parseSettings, serializeSettings, settingsFromText } from "./settings";

test("defaults follow the usage spec: remaining, alerts, 90% disk, both providers, metrics off", () => {
    const s = defaultSettings();
    expect(s.showRemaining).toBe(true);
    expect(s.alerts).toBe(true);
    expect(s.diskAlertThreshold).toBe(90);
    expect(s.providers).toEqual({ codex: true, claude: true });
    expect(s.providerRefresh).toEqual({ enabled: true, seconds: 60 });
    expect(s.systemRefresh).toEqual({ enabled: true });
    expect(s.metrics.cpu).toEqual({ enabled: false, seconds: DEFAULT_METRIC_SECONDS.cpu });
    expect(s.metrics.temperature).toEqual({ enabled: false, seconds: DEFAULT_METRIC_SECONDS.temperature });
});

test("whole numbers are clamped into range and non-numbers take the fallback", () => {
    expect(clampWhole(12.6, 1, 3600, 5)).toBe(13);
    expect(clampWhole(0, 1, 3600, 5)).toBe(1);
    expect(clampWhole(99999, 1, 3600, 5)).toBe(3600);
    expect(clampWhole("30", 1, 3600, 5)).toBe(5);
    expect(clampWhole(Number.NaN, 1, 3600, 5)).toBe(5);
});

test("provider refresh is never below 60 seconds and metric intervals stay within 1s to 1h", () => {
    const s = normalizeSettings({
        providerRefresh: { enabled: true, seconds: 5 },
        metrics: { cpu: { enabled: true, seconds: 0 }, memory: { enabled: true, seconds: 999999 } },
    });
    expect(s.providerRefresh.seconds).toBe(60);
    expect(s.metrics.cpu).toEqual({ enabled: true, seconds: 1 });
    expect(s.metrics.memory).toEqual({ enabled: true, seconds: 3600 });
});

test("the disk threshold is kept within 50 to 99", () => {
    expect(normalizeSettings({ diskAlertThreshold: 20 }).diskAlertThreshold).toBe(50);
    expect(normalizeSettings({ diskAlertThreshold: 100 }).diskAlertThreshold).toBe(99);
    expect(normalizeSettings({ diskAlertThreshold: 75 }).diskAlertThreshold).toBe(75);
});

test("a bad field takes its default while the valid fields of the file are kept", () => {
    const s = normalizeSettings({ showRemaining: "yes", alerts: false, providers: { codex: false, claude: "maybe" } });
    expect(s.showRemaining).toBe(true);
    expect(s.alerts).toBe(false);
    expect(s.providers).toEqual({ codex: false, claude: true });
});

test("a missing, empty or corrupt file gives the defaults", () => {
    expect(parseSettings(null)).toEqual(defaultSettings());
    expect(parseSettings("")).toEqual(defaultSettings());
    expect(parseSettings("{not json")).toEqual(defaultSettings());
    expect(parseSettings("[1,2,3]")).toEqual(defaultSettings());
    expect(parseSettings("42")).toEqual(defaultSettings());
});

test("settings survive a save and load round trip", () => {
    const changed = normalizeSettings({
        showRemaining: false,
        alerts: false,
        diskAlertThreshold: 80,
        providers: { codex: true, claude: false },
        providerRefresh: { enabled: false, seconds: 300 },
        metrics: { disk: { enabled: true, seconds: 45 }, network: { enabled: true, seconds: 2 } },
        systemRefresh: { enabled: false },
    });
    const text = serializeSettings(changed);
    expect(JSON.parse(text).version).toBe(1);
    expect(JSON.parse(text).seq).toBe(undefined);
    expect(parseSettings(text)).toEqual(changed);
});

test("a file saved before systemRefresh existed loads it on, and a bad value takes the default", () => {
    const older = JSON.stringify({ version: 1, alerts: false, metrics: { cpu: { enabled: true, seconds: 2 } } });
    expect(parseSettings(older).systemRefresh).toEqual({ enabled: true });
    expect(parseSettings(older).alerts).toBe(false);
    expect(normalizeSettings({ systemRefresh: { enabled: "no" } }).systemRefresh).toEqual({ enabled: true });
    expect(normalizeSettings({ systemRefresh: { enabled: false } }).systemRefresh).toEqual({ enabled: false });
});

test("settingsFromText: a JSON object is accepted (bad fields take defaults); damaged text and non-objects give null", () => {
    expect(settingsFromText("{\"alerts\":false,\"diskAlertThreshold\":\"oops\"}")?.alerts).toBe(false);
    expect(settingsFromText("{\"diskAlertThreshold\":\"oops\"}")?.diskAlertThreshold).toBe(defaultSettings().diskAlertThreshold);
    expect(settingsFromText("{oops")).toBe(null);
    expect(settingsFromText("[1,2]")).toBe(null);
    expect(settingsFromText("42")).toBe(null);
});
