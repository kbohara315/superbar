// The tray: the icon, the menu (with the glanceable state at its top) and the tooltip. The icon is one gauge per
// enabled provider: a ring filled with the 5-hour amount shown, or the solid alert disc when a window is high.
// Pure builders are exported for tests; `installTray` keeps the tray in step with the controller's signals and only
// sends the tray what changed.
//
// Why the menu carries the text: on GNOME the AppIndicator extension does not show the tooltip, and a click opens the
// menu (only a double-click activates the item). So the state a user glances at is the menu's first lines.
// The tooltip is set with the same strings for panels that do show it (KDE, Waybar).

import { effect } from "nsh";
import { isAvailable, Tray } from "nsh/desktop";
import type { MenuItem, TrayOptions } from "nsh/desktop";
import { displayPercent, pillHigh, pillText, usedPercent } from "./model";
import { metricLevel, shortMetricText } from "./metrics";
import { METRIC_NAMES } from "./settings";
import type { Controller, RefreshStatus } from "./controller";
import type { MetricName, MetricReading, ProviderName, Settings, Snapshot, UsageDisplay, UsageWindow } from "./types";

export const TRAY_COLORS = {
    codex: "#10a37f",
    claude: "#d97757",
    alert: "#e5484d",
    neutral: "#6b6f76",
} as const;

// Opacities of the gauge's parts. Contrast on the dark panels (WCAG ratio, computed in tray.test.ts):
//   solid elements (any colour, 1.0): 3.7 to 6.7:1 on black and #131313; the neutral grey is the lowest at 3.7:1;
//   the track at TRACK_OPACITY, for the provider colours: 2.3 to 2.4:1 on black and #131313 (it only needs to be
//   visible behind an arc);
//   a stale gauge at STALE_OPACITY: 3.1 to 4.1:1 on black and #131313 (the alert red is the lowest at 3.1:1 on
//   #131313, the orange the highest at 4.1:1 on black).
// The 0.28 track of an earlier build was 1.3:1 and vanished; a stale gauge at 0.5 was 2.3:1.
export const TRACK_OPACITY = 0.5;
export const STALE_OPACITY = 0.75;

// Marks the high state in the pill line. U+26A0 is in DejaVu Sans, the fallback GNOME's menu font uses.
export const HIGH_MARK = "⚠";

const SHORT_NAME: Record<ProviderName, string> = { codex: "cx", claude: "cl" };
const TITLE: Record<ProviderName, string> = { codex: "Codex", claude: "Claude Code" };
const METRIC_LABEL: Partial<Record<MetricName, string>> = { cpu: "CPU", memory: "Mem", swap: "Swap", disk: "Disk", battery: "Batt" };

export interface TrayPill {
    name: ProviderName;
    /** The pill's own text: the 5-hour value, display mode, ` wk!` and ` !` (from model.ts pillText, plus the failure). */
    value: string;
    /** The 5-hour amount shown, 0 to 100, or null without a value. */
    shown: number | null;
    /** The weekly window is high while the 5-hour one is not (the pill's ` wk!`). */
    weekly: boolean;
    /** Either window is at 90% used (model.ts pillHigh): the pill is red. */
    high: boolean;
    /** The last refresh failed (the pill's ` !`). */
    failed: boolean;
    color: string;
    /** Stale provider data is dimmed. */
    dim: boolean;
}

export interface TrayInput {
    snapshot: Snapshot | null;
    names: readonly ProviderName[];
    now: number;
    mode: UsageDisplay;
    /** The last refresh failed; the pills then carry the `!` marker, as the extension does. */
    failed: boolean;
}

// One gauge per enabled provider. The value is pillText (5-hour window, display mode, `wk!`); the gauge fills with
// the amount shown, and its colour is pillHigh (either window at 90% used). No usable value is an empty gauge.
export function trayPills(input: TrayInput): TrayPill[] {
    return input.names.map(name => {
        const data = input.snapshot?.providers[name] ?? null;
        if (!data) return { name, value: "—", shown: null, weekly: false, high: false, failed: input.failed, color: TRAY_COLORS.neutral, dim: false };
        const hasUsage = usedPercent(data.windows.primary, input.now) !== null
            || usedPercent(data.windows.secondary, input.now) !== null;
        const high = pillHigh(data, input.now);
        const shown = displayPercent(usedPercent(data.windows.primary, input.now), input.mode);
        // The colour says the provider; the shape says the state. No 5-hour value (an expired or unused 5-hour window)
        // is the grey neutral ring, even when the weekly window has a value: that ring is not the provider's amount.
        const color = high ? TRAY_COLORS.alert
            : !hasUsage || data.state === "unavailable" || shown === null ? TRAY_COLORS.neutral
            : TRAY_COLORS[name];
        const base = pillText(data, input.now, input.mode);
        const value = base + (input.failed ? " !" : "");
        return { name, value, shown, weekly: base.endsWith(" wk!"), high, failed: input.failed, color, dim: data.state === "stale" };
    });
}

// A square 24-point icon: one gauge per enabled provider, side by side. Panels scale the icon to a square slot, so no
// numbers are drawn here. Three shapes, so the state reads without colour (colour-blind users see the same red and
// green and orange as one hue family at small sizes):
//   - high (either window at 90% used): a solid, full-opacity alert DISC (a filled circle with the outer size of a
//     ring). It is the only filled shape, whatever the display mode and fill direction, so it cannot be mistaken for
//     a full ring, and the arc is not drawn;
//   - no 5-hour value: a solid neutral RING, never dimmed (the first-run state, and an expired 5-hour window);
//   - otherwise: a ring: a faint track (TRACK_OPACITY) with the solid arc of the amount shown.
// A stale valued gauge is drawn at STALE_OPACITY.
export function trayIconSvg(pills: readonly TrayPill[]): string {
    const size = 24;
    const shown: TrayPill[] = pills.length > 0 ? [...pills] : [{ name: "codex", value: "—", shown: null, weekly: false, high: false, failed: false, color: TRAY_COLORS.neutral, dim: false }];
    const slot = size / shown.length;
    // The stroke first (it scales with the size), then the radius, so that two gauges keep a gap of 2 points between
    // their outer edges: 1.33px at the 16px a panel draws the 24-point icon at. A single gauge keeps its size.
    const stroke = Math.max(2.2, Math.min(3.4, Math.min(slot / 2 - 1.5, 8.5) / 2.4));
    const radius = Math.min(slot / 2 - stroke / 2 - 1, 8.5);
    const circumference = 2 * Math.PI * radius;
    const parts = shown.map((pill, index) => {
        const cx = slot * index + slot / 2;
        const cy = size / 2;
        const ring = (extra: string) => `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${pill.color}"${extra} stroke-width="${stroke}"`;
        const opacity = pill.dim ? STALE_OPACITY : 1;
        if (pill.high) {
            // The disc's outer edge matches the ring's, so the alert gauge keeps the footprint of the others.
            return `<g opacity="${opacity}"><circle cx="${cx}" cy="${cy}" r="${radius + stroke / 2}" fill="${pill.color}" stroke="none"/></g>`;
        }
        // A gauge with no value is never dimmed: it is the first-run state and must stay visible. Stale dims only the
        // valued gauges.
        if (pill.shown === null) {
            return `<g>${ring("")}/></g>`;
        }
        const fraction = Math.max(0, Math.min(1, pill.shown / 100));
        const track = `${ring(` stroke-opacity="${TRACK_OPACITY}"`)}/>`;
        const arc = fraction > 0
            ? `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${pill.color}" stroke-width="${stroke}" `
              + `stroke-dasharray="${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}" `
              + `transform="rotate(-90 ${cx} ${cy})"/>`
            : "";
        return `<g opacity="${opacity}">${track}${arc}</g>`;
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${parts.join("")}</svg>`;
}

export function trayIconUrl(svg: string): string {
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// `5h`, `7d`, `90m`: a window's length from its duration. Without a duration, the label in short form: `Weekly` is
// `wk`, `5-hour` is `5h`; any other label is shown as it is.
export function windowLengthText(window: UsageWindow): string {
    const seconds = window.duration_seconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return shortLabel(window.label);
    if (seconds % 86400 === 0) return `${seconds / 86400}d`;
    if (seconds % 3600 === 0) return `${seconds / 3600}h`;
    return `${Math.round(seconds / 60)}m`;
}

function shortLabel(label: string): string {
    const text = label.trim().toLowerCase();
    if (text.includes("week")) return "wk";
    if (/^5[- ]?h/.test(text) || text.includes("5-hour") || text.includes("5 hour")) return "5h";
    return label;
}

// The tightest usable window (the highest used percent) of one provider, as `status --line` picks it. A tie keeps the
// 5-hour window (the primary is considered first).
function tightest(snapshot: Snapshot, name: ProviderName, now: number): UsageWindow | null {
    const data = snapshot.providers[name];
    let best: UsageWindow | null = null;
    let bestUsed = -1;
    for (const window of [data.windows.primary, data.windows.secondary]) {
        const used = usedPercent(window, now);
        if (window && used !== null && used > bestUsed) {
            best = window;
            bestUsed = used;
        }
    }
    return best;
}

// The first menu line, and the tooltip's first part: every provider's 5-hour pill, the window named and the pill's
// markers. The markers, in this order, each as a separate word:
//   `wk!`  the weekly window is at 90% used and the 5-hour one is not (the pill's own marker, from pillText);
//   `⚠`    the pill is red (either window at 90% used) and `wk!` does not already say why. This is the one that
//          reads "near the limit" when the 5-hour window itself is high;
//   `!`    the last refresh failed (the pill's failure marker, as the extension shows it);
//   `(stale)` the provider's data is stale.
// Examples: `Codex 5h 75% left`, `Claude Code 5h 5% left ⚠`, `Codex 5h 90% left wk!`, `Codex 5h 75% left !`,
// `Claude Code 5h 5% left ⚠ !`, `Codex 5h 75% left (stale)`. Null with no provider enabled.
export function pillLine(pills: readonly TrayPill[], mode: UsageDisplay): string | null {
    if (pills.length === 0) return null;
    return pills.map(pill => {
        const amount = pill.shown === null ? "—" : `${pill.shown}% ${mode === "remaining" ? "left" : "used"}`;
        const marks = [
            pill.weekly ? "wk!" : "",
            pill.high && !pill.weekly ? HIGH_MARK : "",
            pill.failed ? "!" : "",
            pill.dim ? "(stale)" : "",
        ].filter(mark => mark !== "");
        return [`${TITLE[pill.name]} 5h ${amount}`, ...marks].join(" ");
    }).join(" · ");
}

// One metric's short value (the dashboard's and the extension capsule's forms, from metrics.ts shortMetricText), with
// ` !` at the alert level the dashboard uses (metricLevel).
export function metricShort(name: MetricName, reading: MetricReading | undefined, diskThreshold: number): string {
    const label = METRIC_LABEL[name];
    const value = reading ? shortMetricText(reading) : "—";
    const text = [label, value].filter(Boolean).join(" ");
    return reading && metricLevel(reading, diskThreshold) === "high" ? `${text} !` : text;
}

// The enabled metrics in settings order; null when none is enabled.
export function metricsLine(settings: Settings, metrics: Partial<Record<MetricName, MetricReading>>): string | null {
    const enabled = METRIC_NAMES.filter(name => settings.metrics[name].enabled);
    if (enabled.length === 0) return null;
    return enabled.map(name => metricShort(name, metrics[name], settings.diskAlertThreshold)).join(" · ");
}

// The CLI's status line (`cx 58% left 5h · cl 29% left 5h`, or `cx 42% 5h · cl 71% 5h` with the display set to used),
// but only for providers whose tightest usable window is NOT the 5-hour one: the pill line already shows the 5-hour
// numbers, so repeating them would print the same numbers twice. Null when no provider has a weekly window tighter
// than its 5-hour one (or none is enabled).
export function statusLine(input: TrayInput): string | null {
    const segments: string[] = [];
    for (const name of input.names) {
        const data = input.snapshot?.providers[name];
        if (!input.snapshot || !data || data.state === "unavailable") continue;
        const window = tightest(input.snapshot, name, input.now);
        if (!window || window === data.windows.primary) continue;
        const used = usedPercent(window, input.now);
        if (used === null) continue;
        const shown = displayPercent(used, input.mode) ?? 0;
        const short = SHORT_NAME[name];
        segments.push(input.mode === "remaining" ? `${short} ${shown}% left ${windowLengthText(window)}` : `${short} ${shown}% ${windowLengthText(window)}`);
    }
    return segments.length > 0 ? segments.join(" · ") : null;
}

export interface TrayTextInput extends TrayInput {
    settings: Settings;
    metrics: Partial<Record<MetricName, MetricReading>>;
}

// One of the three informational slots. A slot with nothing to say shows a placeholder, and `placeholder` is set, so the
// tooltip can leave it out while the menu keeps the slot.
export interface InfoSlot {
    text: string;
    placeholder: boolean;
}

// The three informational slots, in order, ALWAYS three. nsh numbers the menu items by position, so a slot that
// appeared or disappeared would shift the ids of everything below it; placeholders keep the shape fixed while the
// text changes.
export function infoSlots(input: TrayTextInput): InfoSlot[] {
    const pills = trayPills(input);
    const pill = pillLine(pills, input.mode);
    const metrics = metricsLine(input.settings, input.metrics);
    const status = statusLine(input);
    return [
        pill !== null ? { text: pill, placeholder: false } : { text: "No providers shown", placeholder: true },
        metrics !== null ? { text: metrics, placeholder: false } : { text: "Metrics off · enable in Settings", placeholder: true },
        status !== null ? { text: status, placeholder: false }
            : input.names.length === 0 ? { text: "No providers shown", placeholder: true }
            : { text: "The 5-hour limit is the tightest", placeholder: true },
    ];
}

export function infoLines(input: TrayTextInput): string[] {
    return infoSlots(input).map(slot => slot.text);
}

const TOOLTIP_SEPARATOR = " — ";

// The tooltip: the informational slots that have something to say, joined on one line (a newline in a tooltip is not
// shown reliably).
export function trayTooltip(input: TrayTextInput): string {
    const lines = infoSlots(input).filter(slot => !slot.placeholder).map(slot => slot.text);
    return lines.length > 0 ? lines.join(TOOLTIP_SEPARATOR) : "Superbar";
}

export interface TrayActions {
    /** The menu's Open dashboard item, and a primary click on the icon. */
    openDashboard(): void;
    /** The menu's Hide dashboard item. */
    hideDashboard(): void;
    /** Whether the dashboard window is showing (Hide dashboard is enabled only then). */
    dashboardShown(): boolean;
    refreshProvider(name: ProviderName): void;
    refreshAll(): void;
    runDoctor(): void;
}

// The menu. Its shape is fixed for live updates: the three information slots (enabled; a click opens the dashboard),
// a separator, then the actions and Quit. nsh numbers the items by position, so the info slots never change count.
// Known exception: the "Refresh <provider>" items appear only for enabled providers. Enabling or disabling a provider
// changes the count below the slots, so a menu that is open at that moment may need one more click.
export function trayMenu(controller: Controller, actions: TrayActions, slots: readonly InfoSlot[]): MenuItem[] {
    const settings = controller.settings();
    const busy = controller.refreshing() !== null;
    const items: MenuItem[] = slots.map(slot => ({ label: slot.text, onSelect: actions.openDashboard }));
    items.push({ type: "separator" });
    items.push(
        { label: "Open dashboard", onSelect: actions.openDashboard },
        { label: "Hide dashboard", disabled: !actions.dashboardShown(), onSelect: actions.hideDashboard },
        { label: "Refresh now", disabled: busy || !controller.ready(), onSelect: actions.refreshAll },
    );
    for (const name of ["codex", "claude"] as const) {
        if (!settings.providers[name]) continue;
        items.push({ label: `Refresh ${TITLE[name]}`, disabled: busy, onSelect: () => actions.refreshProvider(name) });
    }
    items.push({ label: "Run doctor", onSelect: actions.runDoctor });
    items.push({ type: "separator" });
    items.push({ role: "quit" });
    return items;
}

// What the tray shows now: the icon, the tooltip, the menu and the click action.
export interface TrayPayload {
    icon: string;
    tooltip: string;
    menu: MenuItem[];
    onClick: () => void;
}

export function trayPayload(controller: Controller, actions: TrayActions): TrayPayload {
    const settings = controller.settings();
    const names = (["codex", "claude"] as const).filter(name => settings.providers[name]);
    // Metrics are read only while one is enabled, so an idle tray does not depend on them.
    const anyMetric = METRIC_NAMES.some(name => settings.metrics[name].enabled);
    const input = {
        snapshot: controller.snapshot(),
        names,
        now: controller.now(),
        mode: (settings.showRemaining ? "remaining" : "used") as UsageDisplay,
        failed: isFailure(controller.status()) && controller.snapshot() !== null,
    };
    const text = { ...input, settings, metrics: anyMetric ? controller.metrics() : {} };
    return {
        icon: trayIconUrl(trayIconSvg(trayPills(input))),
        tooltip: trayTooltip(text),
        menu: trayMenu(controller, actions, infoSlots(text)),
        onClick: actions.openDashboard,
    };
}

// The part of nsh's Tray this module uses, so a test can receive the payload without a desktop.
export interface TrayPort {
    available(): boolean;
    set(options: TrayOptions): void;
}

export const nshTrayPort: TrayPort = {
    available: () => isAvailable,
    set: options => Tray.set(options),
};

// Keeps the tray in step with the controller: the effect re-runs whenever a signal it read changes. A payload identical
// to the last one sent is not sent again (every set re-draws the icon and re-publishes the menu). Desktops only.
// Platform limit: nsh's Tray takes no title, so a dev run shows the host's name ("nsh"); a packaged app shows its
// nsh.json name.
export function installTray(controller: Controller, actions: TrayActions, port: TrayPort = nshTrayPort): void {
    let last: string | null = null;
    effect(() => {
        if (!port.available()) return;
        const payload = trayPayload(controller, actions);
        // Menu items carry functions, which JSON drops: the key is the menu's visible content plus icon and tooltip.
        const key = JSON.stringify({ icon: payload.icon, tooltip: payload.tooltip, menu: payload.menu });
        if (key === last) return;
        last = key;
        try {
            port.set({ icon: payload.icon, tooltip: payload.tooltip, menu: payload.menu, onClick: payload.onClick });
        } catch {
            // A platform without a tray keeps the dashboard reachable from the app's window.
        }
    });
}

function isFailure(status: RefreshStatus): boolean {
    return status === "busy" || status === "timeout" || status === "failed";
}
