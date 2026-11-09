// Text and numbers for the dashboard, as plain functions of the data and the clock. The model functions in ../model.ts
// do the arithmetic.

import {
    displayPercent, errorReason, refreshFailureText, resetClock, resetCountdown, stateText, syncedText, tokenExpiryText,
    usageLevel, usedPercent, windowExpired, windowUsageText,
} from "../model";
import { metricLevel } from "../metrics";
import type { RefreshStatus } from "../controller";
import type { DoctorCheck, MetricName, MetricReading, ProviderName, ProviderSnapshot, UsageDisplay, UsageWindow } from "../types";

export const COLORS = {
    codex: "#10a37f",
    claude: "#d97757",
    alert: "#e5484d",
    neutral: "#6b6f76",
    metric: { cpu: "#5b9cf6", memory: "#a78bfa", swap: "#2dd4bf", disk: "#f5b942", network: "#38bdf8", battery: "#4ade80", temperature: "#fb923c" } as Record<MetricName, string>,
} as const;

export const PROVIDER_TITLE: Record<ProviderName, string> = { codex: "Codex", claude: "Claude Code" };
export const METRIC_TITLE: Record<MetricName, string> = {
    cpu: "CPU", memory: "Memory", swap: "Swap", disk: "Disk", network: "Network", battery: "Battery", temperature: "Temperature",
};
// The two usage windows are always listed under these titles on a provider card.
export const WINDOW_TITLE = { primary: "5-hour", secondary: "Weekly" } as const;

export function displayMode(showRemaining: boolean): UsageDisplay {
    return showRemaining ? "remaining" : "used";
}

export function brandColor(name: ProviderName): string {
    return COLORS[name];
}

// One usage row: the text, the bar (filled with the amount shown) and the reset line.
export interface WindowRowView {
    percentText: string;
    /** Bar fill, 0 to 100, in the amount shown (remaining or used). */
    fill: number;
    fillColor: string;
    resetText: string;
    expired: boolean;
}

export function windowRow(window: UsageWindow | null, nowMs: number, mode: UsageDisplay, brand: string): WindowRowView {
    const used = usedPercent(window, nowMs);
    const shown = displayPercent(used, mode);
    const expired = window !== null && windowExpired(window, nowMs);
    let resetText = "";
    if (window && expired) resetText = "↻ reset passed · awaiting data";
    else if (window) {
        const clock = resetClock(window.reset_at, nowMs);
        const countdown = resetCountdown(window.reset_at, nowMs).replace(/^resets in /, "");
        resetText = `↻ ${countdown}${clock ? ` · ${clock}` : ""}`;
    }
    return {
        percentText: windowUsageText(window, nowMs, mode),
        fill: shown === null ? 0 : shown,
        fillColor: usageLevel(used) === "high" ? COLORS.alert : brand,
        resetText,
        expired,
    };
}

// The card's text: state, the synced time, the token line (its own line, never truncated: the renews / expired
// wording is the point of the line), and the error reason.
export interface CardView {
    state: string;
    synced: string;
    token: string | null;
    reason: string | null;
}

export function cardView(name: ProviderName, data: ProviderSnapshot, nowMs: number, liveExpiresAt: string | null): CardView {
    const reason = errorReason(data, name);
    return {
        state: stateText(data),
        synced: syncedText(data),
        token: tokenExpiryText(data, nowMs, liveExpiresAt),
        reason: reason ? `${reason.code}: ${reason.hint}` : null,
    };
}

// A metric tile's value and caption. Unread metrics show a dash until their first reading.
export interface TileView {
    value: string;
    detail: string;
    fill: number;
    alert: boolean;
    history: number[];
}

export function tileView(name: MetricName, reading: MetricReading | undefined, diskThreshold: number): TileView {
    if (!reading) return { value: "—", detail: METRIC_TITLE[name], fill: 0, alert: false, history: [] };
    const alert = metricLevel(reading, diskThreshold) === "high";
    return {
        value: reading.text,
        detail: reading.detail ?? METRIC_TITLE[name],
        fill: reading.available && typeof reading.percent === "number" ? Math.max(0, Math.min(100, reading.percent)) : 0,
        alert,
        history: reading.history ?? [],
    };
}

// Rates (network, in bytes per second) have no ceiling: the sparkline scales to the busiest sample on screen, but
// never below this floor, so an idle link's noise is not drawn as full-height bars.
export const SPARK_RATE_FLOOR_BYTES_PER_SECOND = 32 * 1024;

// Sparkline bars: each sample as a height in 0..1. Percentages scale to 100; rates scale as described above.
export function sparkHeights(history: readonly number[], unbounded: boolean): number[] {
    if (history.length === 0) return [];
    const scale = unbounded ? Math.max(SPARK_RATE_FLOOR_BYTES_PER_SECOND, ...history) : 100;
    return history.map(value => Math.max(0, Math.min(1, value / scale)));
}

// The header line under the title: `Refreshing…` while a refresh runs, else the failure text of the last refresh.
export function headerStatus(status: RefreshStatus, refreshing: boolean): string {
    if (refreshing) return "Refreshing…";
    switch (status) {
    case "busy": return refreshFailureText("lock_busy");
    case "timeout": return refreshFailureText("timeout");
    case "failed": return refreshFailureText("failed");
    default: return "";
    }
}

// Interval editor text: seconds, or minutes when the unit is `m`.
export function intervalText(seconds: number, unit: "s" | "m"): string {
    const value = unit === "m" ? seconds / 60 : seconds;
    return String(Math.round(value * 10) / 10);
}

// Starts in minutes only when the value is a whole number of minutes.
export function defaultUnit(seconds: number): "s" | "m" {
    return seconds >= 60 && seconds % 60 === 0 ? "m" : "s";
}

export function doctorTag(status: DoctorCheck["status"]): string {
    return `[${status}]`;
}

export function doctorColor(status: DoctorCheck["status"]): string {
    return status === "ok" ? COLORS.codex : status === "warn" ? COLORS.claude : COLORS.alert;
}
