import { expect, test } from "nsh/test";
import type { MetricName, MetricReading, Snapshot, UsageWindow, ProviderSnapshot } from "./types";
import { defaultSettings } from "./settings";
import { harness, iso, settle, T0 } from "../tests/fakes";
import {
    installTray, infoSlots, infoLines, metricShort, metricsLine, pillLine, statusLine, trayIconSvg, trayIconUrl, trayMenu,
    trayPayload, trayPills, trayTooltip, windowLengthText, HIGH_MARK, STALE_OPACITY, TRACK_OPACITY, TRAY_COLORS,
    TrayActions, TrayPill, TrayPort,
} from "./tray";

const DAY = 86400;
const FIVE_HOURS = 5 * 3600;

function win(label: string, used: number, duration: number | null): UsageWindow {
    return { label, used_percent: used, reset_at: iso(T0 + 3600_000), duration_seconds: duration };
}
function prov(state: ProviderSnapshot["state"], primary: UsageWindow | null, secondary: UsageWindow | null = null): ProviderSnapshot {
    return { state, last_success_at: iso(T0), windows: { primary, secondary }, error: null, expires_at: null };
}
function snap(codex: ProviderSnapshot, claude: ProviderSnapshot): Snapshot {
    return { schema_version: 1, generated_at: iso(T0), providers: { codex, claude } };
}
const BOTH = ["codex", "claude"] as const;
const reading = (name: MetricName, fields: Partial<MetricReading>): MetricReading => ({ name, available: true, text: "", ...fields });
const actions: TrayActions = {
    openDashboard: () => undefined,
    hideDashboard: () => undefined,
    dashboardShown: () => true,
    refreshProvider: () => undefined,
    refreshAll: () => undefined,
    runDoctor: () => undefined,
};

// WCAG contrast, the same formula a designer's checker uses. Translucent colours are composited over the panel first.
function linear(channel: number): number {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
}
function composite(hex: string, alpha: number, panel: string): string {
    const channels = (h: string) => [1, 3, 5].map(i => Number.parseInt(h.slice(i, i + 2), 16));
    const fg = channels(hex);
    const bg = channels(panel);
    return `#${fg.map((f, i) => Math.round(alpha * f + (1 - alpha) * bg[i]).toString(16).padStart(2, "0")).join("")}`;
}
function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// Codex: 5-hour 25% used, weekly 37%. Claude: 5-hour 50% used.
const sample = (): Snapshot => snap(
    prov("fresh", win("5-hour", 25, FIVE_HOURS), win("Weekly", 37, 7 * DAY)),
    prov("fresh", win("5-hour", 50, FIVE_HOURS), null),
);
const base = { now: T0, mode: "remaining" as const, failed: false };

// The alert gauge's shape: a filled disc (fill set to a colour, no stroke). Every other gauge part is a ring (fill none).
function alertDiscs(svg: string): number {
    return [...svg.matchAll(/<circle[^>]*\/>/g)]
        .map(match => match[0])
        .filter(circle => circle.includes(`fill="${TRAY_COLORS.alert}"`) && circle.includes('stroke="none"'))
        .length;
}
function filledCircles(svg: string): number {
    return [...svg.matchAll(/<circle[^>]*\/>/g)].map(match => match[0]).filter(circle => !circle.includes('fill="none"')).length;
}

// ----- the pill line: window named, markers ----------------------------------------------------------------------------

test("the pill line names each provider's 5-hour window and shows what the pill shows", () => {
    const pills = trayPills({ ...base, snapshot: sample(), names: BOTH });
    expect(pillLine(pills, "remaining")).toBe("Codex 5h 75% left · Claude Code 5h 50% left");
    expect(pillLine(trayPills({ ...base, mode: "used", snapshot: sample(), names: BOTH }), "used")).toBe("Codex 5h 25% used · Claude Code 5h 50% used");
});

test("a high weekly window adds wk! to the pill line, and only then", () => {
    const hot = snap(prov("fresh", win("5-hour", 10, FIVE_HOURS), win("Weekly", 92, 7 * DAY)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    expect(pillLine(trayPills({ ...base, snapshot: hot, names: BOTH }), "remaining")).toBe("Codex 5h 90% left wk! · Claude Code 5h 90% left");
    expect(pillLine(trayPills({ ...base, snapshot: sample(), names: BOTH }), "remaining")?.includes("wk!")).toBe(false);
});

test("a 5-hour window at 90% used shows the high marker ⚠, since wk! does not explain it", () => {
    const bothHigh = snap(prov("fresh", win("5-hour", 92, FIVE_HOURS), win("Weekly", 95, 7 * DAY)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    expect(pillLine(trayPills({ ...base, snapshot: bothHigh, names: ["codex"] }), "remaining")).toBe(`Codex 5h 8% left ${HIGH_MARK}`);
});

test("the high marker and the failure marker are distinct: high only, failed only, both, wk!+failed, stale", () => {
    const high = snap(prov("fresh", win("5-hour", 95, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const weeklyHigh = snap(prov("fresh", win("5-hour", 10, FIVE_HOURS), win("Weekly", 92, 7 * DAY)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const line = (snapshot: Snapshot, failed = false, stale = false) => {
        const withStale = stale ? snap(prov("stale", snapshot.providers.codex.windows.primary, snapshot.providers.codex.windows.secondary), snapshot.providers.claude) : snapshot;
        return pillLine(trayPills({ ...base, snapshot: withStale, names: ["codex"], failed }), "remaining");
    };
    expect(line(high)).toBe(`Codex 5h 5% left ${HIGH_MARK}`);
    expect(line(sample(), true)).toBe("Codex 5h 75% left !");
    expect(line(high, true)).toBe(`Codex 5h 5% left ${HIGH_MARK} !`);
    expect(line(weeklyHigh, true)).toBe("Codex 5h 90% left wk! !");
    expect(line(sample(), false, true)).toBe("Codex 5h 75% left (stale)");
    expect(line(high, false, true)).toBe(`Codex 5h 5% left ${HIGH_MARK} (stale)`);
});

test("a provider with no 5-hour value shows a dash, and no provider enabled means no pill line", () => {
    const none = snap(prov("unavailable", null), prov("fresh", win("5-hour", 50, FIVE_HOURS)));
    expect(pillLine(trayPills({ ...base, snapshot: none, names: BOTH }), "remaining")).toBe("Codex 5h — · Claude Code 5h 50% left");
    expect(pillLine([], "remaining")).toBe(null);
});

// ----- the icon: the alert state is unmissable, the contrast floor holds ----------------------------------------------

test("a pill at 90, 95 and 100% used draws a full-opacity alert disc, in both display modes", () => {
    for (const used of [90, 95, 100]) {
        for (const mode of ["remaining", "used"] as const) {
            const snapshot = snap(prov("fresh", win("5-hour", used, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
            const svg = trayIconSvg(trayPills({ ...base, mode, snapshot, names: BOTH }));
            expect(alertDiscs(svg)).toBe(1);
            expect(svg.includes('<g opacity="1">')).toBe(true); // every valued gauge is in a group: opacity 1, or the stale one
            expect(svg.includes('stroke-dasharray="')).toBe(true); // Claude's arc is still drawn; Codex's is not
        }
    }
});

test("the alert gauge is a filled disc and a fresh 100%-left ring has none: the shape differs, not only the colour", () => {
    // Fresh and full: the ring with a full arc, in the provider colour. It must have no filled element.
    const fresh = snap(prov("fresh", win("5-hour", 0, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const freshSvg = trayIconSvg(trayPills({ ...base, snapshot: fresh, names: ["codex"] }));
    expect(filledCircles(freshSvg)).toBe(0);
    expect(alertDiscs(freshSvg)).toBe(0);
    // Exhausted: the alert disc, the one filled element, in the alert colour.
    const exhausted = snap(prov("fresh", win("5-hour", 100, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const exhaustedSvg = trayIconSvg(trayPills({ ...base, snapshot: exhausted, names: ["codex"] }));
    expect(filledCircles(exhaustedSvg)).toBe(1);
    expect(alertDiscs(exhaustedSvg)).toBe(1);
    // The disc has the outer size of a ring: radius plus half the stroke (one gauge in 24 points: 8.5 and 3.4).
    expect(exhaustedSvg.includes(`r="${8.5 + 3.4 / 2}"`)).toBe(true);
});

test("the high state does not depend on the arc: at 0% left the gauge is still the alert disc, not an empty track", () => {
    const snapshot = snap(prov("fresh", win("5-hour", 100, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const svg = trayIconSvg(trayPills({ ...base, snapshot, names: ["codex"] }));
    expect(alertDiscs(svg)).toBe(1);
    expect(svg.includes('stroke-opacity="')).toBe(false);
    expect(svg.includes("stroke-dasharray")).toBe(false);
});

test("a 5-hour window that has expired, with a 20% weekly window, is the grey neutral ring in both display modes", () => {
    // The 5-hour window's reset has passed: its usage is unknown, so the gauge has no 5-hour value. The weekly window is
    // usable, which must not paint a full ring in the provider's colour (the menu says `Codex 5h —`).
    const expired = { ...win("5-hour", 20, FIVE_HOURS), reset_at: iso(T0 - 60_000) };
    for (const mode of ["remaining", "used"] as const) {
        const snapshot = snap(prov("fresh", expired, win("Weekly", 20, 7 * DAY)), prov("unavailable", null));
        const pills = trayPills({ ...base, mode, snapshot, names: ["codex"] });
        expect(pills[0].shown).toBe(null);
        expect(pills[0].color).toBe(TRAY_COLORS.neutral);
        const svg = trayIconSvg(pills);
        expect(svg.includes(`stroke="${TRAY_COLORS.neutral}"`)).toBe(true);
        expect(svg.includes(`stroke="${TRAY_COLORS.codex}"`)).toBe(false);
        expect(filledCircles(svg)).toBe(0);
        expect(svg.includes('stroke-opacity="')).toBe(false);
        expect(pillLine(pills, mode)).toBe("Codex 5h —");
    }
});

test("the neutral ring (no value) is solid; a stale alert pill is dimmed to the stale opacity and keeps its disc", () => {
    const neutral = trayIconSvg([{ name: "claude", value: "—", shown: null, weekly: false, high: false, failed: false, color: TRAY_COLORS.neutral, dim: false }]);
    expect(neutral.includes(`stroke="${TRAY_COLORS.neutral}"`)).toBe(true);
    expect(neutral.includes('stroke-opacity="')).toBe(false);
    expect(neutral.includes("stroke-dasharray")).toBe(false);
    const staleAlert = snap(prov("stale", win("5-hour", 96, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS)));
    const svg = trayIconSvg(trayPills({ ...base, snapshot: staleAlert, names: ["codex"] }));
    expect(svg.includes(`opacity="${STALE_OPACITY}"`)).toBe(true);
    expect(alertDiscs(svg)).toBe(1);
});

test("the icon is square with one gauge per provider, filled with the amount shown", () => {
    const svg = trayIconSvg(trayPills({ ...base, snapshot: sample(), names: BOTH }));
    expect(svg).toContain('width="24" height="24"');
    expect(svg).toContain(TRAY_COLORS.codex);
    expect(svg).toContain(TRAY_COLORS.claude);
    // Two gauges share 24 points: radius 3.9, circumference 24.50. Codex shows 75% left, so its arc is 18.38 long.
    expect(svg.includes('stroke-dasharray="18.38 24.50"')).toBe(true);
    expect(svg.includes("<text")).toBe(false);
    expect(trayIconUrl(svg).startsWith("data:image/svg+xml,")).toBe(true);
});

test("contrast: every solid element clears 3:1 on the dark panels; the track clears 2:1; a stale valued gauge clears 3:1", () => {
    const panels = ["#000000", "#131313"];
    for (const panel of panels) {
        // Solid elements: the alert disc, a provider's arc, and the neutral ring of a gauge with no value. The disc's
        // colour and footprint are the same as the ring it replaces, so its contrast is the colour's own.
        for (const colour of [TRAY_COLORS.alert, TRAY_COLORS.codex, TRAY_COLORS.claude, TRAY_COLORS.neutral]) {
            expect(contrast(colour, panel) >= 3).toBe(true);
        }
        // Stale dims only valued gauges: the alert disc and the provider arcs.
        for (const colour of [TRAY_COLORS.alert, TRAY_COLORS.codex, TRAY_COLORS.claude]) {
            expect(contrast(composite(colour, STALE_OPACITY, panel), panel) >= 3).toBe(true);
            // The track is drawn behind a provider's arc only.
        }
        for (const colour of [TRAY_COLORS.codex, TRAY_COLORS.claude]) {
            expect(contrast(composite(colour, TRACK_OPACITY, panel), panel) >= 2).toBe(true);
        }
    }
});

test("the stale track (its 0.5 opacity times the 0.75 stale opacity) stays visible: it is a guide, the arc above it carries the value", () => {
    // Measured, not a floor the design meets: the stale track is 1.7 to 1.8:1 on the dark panels. Its arc is 3.7 to 4.1:1.
    for (const panel of ["#000000", "#131313"]) {
        for (const colour of [TRAY_COLORS.codex, TRAY_COLORS.claude]) {
            const track = composite(colour, TRACK_OPACITY * STALE_OPACITY, panel);
            expect(contrast(track, panel) >= 1.7).toBe(true);
            expect(contrast(composite(colour, STALE_OPACITY, panel), panel) >= 3.7).toBe(true);
        }
    }
});

// Two gauges at the 16px a panel draws the 24-point icon at: their outer edges (ring radius plus half the stroke) must
// leave at least 1px between them. Read back from the generated SVG, not from the formula.
// A ring's outer edge is its radius plus half its stroke; a disc (no stroke) is its radius.
function outerEdgesAt16px(svg: string): { left: number; right: number } {
    const circles = [...svg.matchAll(/<circle cx="([\d.]+)" cy="[\d.]+" r="([\d.]+)"([^>]*)\/>/g)];
    const edges = circles.map(match => {
        const width = /stroke-width="([\d.]+)"/.exec(match[3]);
        return { cx: Number(match[1]), outer: Number(match[2]) + (width ? Number(width[1]) / 2 : 0) };
    });
    const left = edges.reduce((a, b) => (a.cx < b.cx ? a : b));
    const right = edges.reduce((a, b) => (a.cx > b.cx ? a : b));
    return { left: left.cx + left.outer, right: right.cx - right.outer };
}

test("two gauges keep at least 1px between their outer edges at 16px, and a single gauge keeps its size", () => {
    const pair = trayIconSvg(trayPills({ ...base, snapshot: sample(), names: BOTH }));
    const gap = outerEdgesAt16px(pair);
    expect((gap.right - gap.left) * 16 / 24 >= 1).toBe(true);
    // Codex is high (a disc) beside a ring: the disc's edge is the ring's outer edge, so the gap holds.
    const alertPair = trayIconSvg(trayPills({ ...base, snapshot: snap(prov("fresh", win("5-hour", 100, FIVE_HOURS)), prov("fresh", win("5-hour", 10, FIVE_HOURS))), names: BOTH }));
    const alertGap = outerEdgesAt16px(alertPair);
    expect((alertGap.right - alertGap.left) * 16 / 24 >= 1).toBe(true);
    const single = trayIconSvg(trayPills({ ...base, snapshot: sample(), names: ["codex"] }));
    expect(single.includes(`r="8.5"`)).toBe(true);
});

test("a stale gauge with no value is not dimmed (it is the first-run state)", () => {
    const svg = trayIconSvg([{ name: "claude", value: "—", shown: null, weekly: false, high: false, failed: false, color: TRAY_COLORS.neutral, dim: true }]);
    expect(svg.includes('opacity="0.75"')).toBe(false);
});

// ----- the metrics line and the status line ---------------------------------------------------------------------------

test("the metrics line lists only enabled metrics, in the shared short forms, with ! at alert level", () => {
    const settings = defaultSettings();
    settings.metrics.cpu = { enabled: true, seconds: 2 };
    settings.metrics.network = { enabled: true, seconds: 1 };
    settings.metrics.disk = { enabled: true, seconds: 30 };
    const metrics = {
        cpu: reading("cpu", { percent: 27, text: "27%" }),
        network: reading("network", { text: "↓ 12.0 KB/s", detail: "↑ 3.0 KB/s", rates: { rx: 12 * 1024, tx: 3 * 1024 } }),
        disk: reading("disk", { percent: 92, text: "92%" }),
        memory: reading("memory", { percent: 32, text: "9 GB" }),
    };
    expect(metricsLine(settings, metrics)).toBe("CPU 27% · Disk 92% ! · ↓12K ↑3K");
});

test("a network rate in MB/s is shown as MB/s, not dropped", () => {
    const network = reading("network", { text: "↓ 2.5 MB/s", detail: "↑ 0.4 MB/s", rates: { rx: 2.5 * 1024 * 1024, tx: 0.4 * 1024 * 1024 } });
    expect(metricShort("network", network, 90)).toBe("↓2.5M ↑410K");
});

test("no enabled metric means no metrics line; a battery at 15% or below, not charging, is marked", () => {
    expect(metricsLine(defaultSettings(), {})).toBe(null);
    expect(metricShort("battery", reading("battery", { percent: 12, text: "12%", detail: "Discharging · 40m left" }), 90)).toBe("Batt 12% !");
    expect(metricShort("battery", reading("battery", { percent: 12, text: "12%", detail: "Charging" }), 90)).toBe("Batt 12%");
});

test("the status line names only providers whose tightest window is not the 5-hour one, so no number is printed twice", () => {
    // Codex's weekly window is tighter (63% left, 7 days); Claude's only window is its 5-hour one, already in the pill line.
    expect(statusLine({ ...base, snapshot: sample(), names: BOTH })).toBe("cx 63% left 7d");
    expect(statusLine({ ...base, mode: "used", snapshot: sample(), names: BOTH })).toBe("cx 37% 7d");
    const fiveHourOnly = snap(prov("fresh", win("5-hour", 25, FIVE_HOURS), win("Weekly", 10, 7 * DAY)), prov("fresh", win("5-hour", 50, FIVE_HOURS)));
    expect(statusLine({ ...base, snapshot: fiveHourOnly, names: BOTH })).toBe(null);
    expect(statusLine({ ...base, snapshot: sample(), names: [] })).toBe(null);
});

test("window lengths read as 5h, 7d, 90m; without a duration the label is shortened (Weekly is wk), other labels stay", () => {
    expect(windowLengthText(win("x", 0, FIVE_HOURS))).toBe("5h");
    expect(windowLengthText(win("x", 0, 7 * DAY))).toBe("7d");
    expect(windowLengthText(win("x", 0, 5400))).toBe("90m");
    expect(windowLengthText(win("Weekly", 0, null))).toBe("wk");
    expect(windowLengthText(win("5-hour", 0, null))).toBe("5h");
    expect(windowLengthText(win("Monthly", 0, null))).toBe("Monthly");
});

test("the status line never falls back to a long label: a weekly window with no duration reads `cx 40% left wk`", () => {
    const noDuration = snap(prov("fresh", win("5-hour", 20, FIVE_HOURS), win("Weekly", 60, null)), prov("unavailable", null));
    expect(statusLine({ ...base, snapshot: noDuration, names: ["codex"] })).toBe("cx 40% left wk");
    expect(statusLine({ ...base, mode: "used", snapshot: noDuration, names: ["codex"] })).toBe("cx 60% wk");
});

// ----- the tooltip and the menu ---------------------------------------------------------------------------------------

test("the tooltip is the informational slots that have something to say, joined on one line", () => {
    const settings = defaultSettings();
    settings.metrics.cpu = { enabled: true, seconds: 2 };
    const input = { ...base, snapshot: sample(), names: BOTH, settings, metrics: { cpu: reading("cpu", { percent: 27, text: "27%" }) } };
    expect(trayTooltip(input)).toBe("Codex 5h 75% left · Claude Code 5h 50% left — CPU 27% — cx 63% left 7d");
    expect(infoLines(input)).toEqual(["Codex 5h 75% left · Claude Code 5h 50% left", "CPU 27%", "cx 63% left 7d"]);
    expect(trayTooltip({ ...base, snapshot: null, names: [], settings: defaultSettings(), metrics: {} })).toBe("Superbar");
});

test("the three information slots are always present, so the menu's shape does not change as their text does", () => {
    const empty = infoSlots({ ...base, snapshot: null, names: [], settings: defaultSettings(), metrics: {} });
    const full = infoSlots({ ...base, snapshot: sample(), names: BOTH, settings: { ...defaultSettings(), metrics: { ...defaultSettings().metrics, cpu: { enabled: true, seconds: 2 } } }, metrics: {} });
    const flat = infoSlots({ ...base, snapshot: sample(), names: BOTH, settings: defaultSettings(), metrics: {} });
    expect(empty.length).toBe(3);
    expect(full.length).toBe(3);
    expect(flat.length).toBe(3);
    expect(empty.every(slot => slot.placeholder)).toBe(true);
    expect(full.some(slot => slot.placeholder)).toBe(false);
    expect(flat[1]).toEqual({ text: "Metrics off · enable in Settings", placeholder: true });
    expect(flat[2]).toEqual({ text: "cx 63% left 7d", placeholder: false });
    expect(full[2].text).toBe("cx 63% left 7d");
    // With no weekly window tighter than the 5-hour one, the third slot says so in plain words.
    const fiveHourOnly = snap(prov("fresh", win("5-hour", 25, FIVE_HOURS), win("Weekly", 10, 7 * DAY)), prov("fresh", win("5-hour", 50, FIVE_HOURS)));
    const plain = infoSlots({ ...base, snapshot: fiveHourOnly, names: BOTH, settings: defaultSettings(), metrics: {} });
    expect(plain[2]).toEqual({ text: "The 5-hour limit is the tightest", placeholder: true });
    expect(plain.length).toBe(3);
    // The tooltip leaves placeholders out.
    expect(trayTooltip({ ...base, snapshot: sample(), names: BOTH, settings: defaultSettings(), metrics: {} })).toBe("Codex 5h 75% left · Claude Code 5h 50% left — cx 63% left 7d");
});

test("the menu starts with the three enabled info slots (a click opens the dashboard), then a separator, then the actions", () => {
    const h = harness();
    h.controller.snapshot.set(sample());
    const slots = [
        { text: "Codex 5h 75% left · Claude Code 5h 50% left", placeholder: false },
        { text: "No metrics shown", placeholder: true },
        { text: "cx 63% left 7d", placeholder: false },
    ];
    const menu = trayMenu(h.controller, actions, slots);
    for (const item of menu.slice(0, 3)) {
        expect((item as { disabled?: boolean }).disabled).toBe(undefined);
        expect(typeof (item as { onSelect?: unknown }).onSelect).toBe("function");
    }
    expect(menu.slice(0, 3).map(item => ("label" in item ? item.label : ""))).toEqual(slots.map(slot => slot.text));
    expect((menu[3] as { type?: string }).type).toBe("separator");
    const labels = menu.slice(4).map(item => {
        const entry = item as { label?: string; type?: string; role?: string };
        return entry.label ?? entry.type ?? entry.role;
    });
    expect(labels).toEqual(["Open dashboard", "Hide dashboard", "Refresh now", "Refresh Codex", "Refresh Claude Code", "Run doctor", "separator", "quit"]);
});

test("Hide dashboard is enabled only while the dashboard window is showing", () => {
    const h = harness();
    const hide = (shown: boolean) => trayMenu(h.controller, { ...actions, dashboardShown: () => shown }, infoSlots({ ...base, snapshot: null, names: [], settings: defaultSettings(), metrics: {} }))
        .find(item => (item as { label?: string }).label === "Hide dashboard") as { disabled?: boolean };
    expect(hide(true).disabled).toBe(false);
    expect(hide(false).disabled).toBe(true);
});

// ----- what reaches the tray ------------------------------------------------------------------------------------------

test("Tray.set receives the tooltip and the menu lines, including the failure marker", async () => {
    const h = harness();
    h.controller.snapshot.set(sample());
    h.controller.settings.set({ ...defaultSettings(), metrics: { ...defaultSettings().metrics, cpu: { enabled: true, seconds: 2 } } });
    h.controller.metrics.set({ cpu: reading("cpu", { percent: 27, text: "27%" }) });
    h.controller.status.set("failed");
    const calls: { tooltip?: string; labels: string[] }[] = [];
    const port: TrayPort = {
        available: () => true,
        set: options => calls.push({
            tooltip: options.tooltip,
            labels: (options.menu ?? []).map(item => (item && "label" in item && item.label) || ""),
        }),
    };
    installTray(h.controller, actions, port);
    await settle();
    const last = calls.at(-1);
    expect(last?.tooltip).toBe("Codex 5h 75% left ! · Claude Code 5h 50% left ! — CPU 27% — cx 63% left 7d");
    expect(last?.labels.slice(0, 3)).toEqual(["Codex 5h 75% left ! · Claude Code 5h 50% left !", "CPU 27%", "cx 63% left 7d"]);
    expect(last?.labels.includes("Hide dashboard")).toBe(true);
});

test("the tray is sent only when something it shows changed: a counting fake sees one set per distinct payload", async () => {
    const h = harness();
    h.controller.snapshot.set(sample());
    h.controller.settings.set({ ...defaultSettings(), metrics: { ...defaultSettings().metrics, cpu: { enabled: true, seconds: 2 } } });
    h.controller.metrics.set({ cpu: reading("cpu", { percent: 27, text: "27%" }) });
    let sets = 0;
    const port: TrayPort = { available: () => true, set: () => { sets += 1; } };
    installTray(h.controller, actions, port);
    await settle();
    expect(sets).toBe(1);
    // Thirty ticks of the clock, and metric readings that round to the same text: nothing visible changes.
    for (let tick = 1; tick <= 30; tick++) {
        h.controller.now.set(T0 + tick * 30_000);
        h.controller.metrics.set({ cpu: reading("cpu", { percent: 27.2, text: "27%" }) });
        await settle();
    }
    expect(sets).toBe(1);
    // A visible change (the CPU reading moves) sends the tray once more.
    h.controller.metrics.set({ cpu: reading("cpu", { percent: 41, text: "41%" }) });
    await settle();
    expect(sets).toBe(2);
});

test("without a desktop tray, nothing is set", async () => {
    const h = harness();
    let calls = 0;
    const port: TrayPort = { available: () => false, set: () => { calls += 1; } };
    installTray(h.controller, actions, port);
    await settle();
    expect(calls).toBe(0);
});

test("the payload's click action opens the dashboard; hiding is the menu's own item", () => {
    const h = harness();
    const open = () => undefined;
    const payload = trayPayload(h.controller, { ...actions, openDashboard: open });
    expect(payload.onClick).toBe(open);
    expect(trayIconUrl("<svg/>").startsWith("data:image/svg+xml,")).toBe(true);
});

// Keep the helper types referenced (documents the pill shape the tests build by hand).
const handBuilt: TrayPill = { name: "codex", value: "—", shown: null, weekly: false, high: false, failed: false, color: TRAY_COLORS.neutral, dim: false };
void handBuilt;

test("Refresh now is disabled until the app is ready (the first read has been applied or has timed out)", async () => {
    const h = harness();
    const refreshNow = () => trayMenu(h.controller, actions, infoSlots({ ...base, snapshot: null, names: [], settings: defaultSettings(), metrics: {} }))
        .find(item => "label" in item && item.label === "Refresh now");
    expect((refreshNow() as { disabled?: boolean } | undefined)?.disabled).toBe(true);
    await h.controller.start();
    await settle();
    expect((refreshNow() as { disabled?: boolean } | undefined)?.disabled).toBe(false);
});
