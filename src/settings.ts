// Settings for Superbar on nsh: defaults, validation on load, and the JSON file they are saved in.
// Pure functions only; the controller decides when to read and write. Ranges and defaults are documented in
// ../docs/usage.md.

import { DEFAULT_METRIC_SECONDS } from "./types";
import type { MetricName, ProviderName, Settings } from "./types";

// `Settings` (types.ts) is the shared shape; `systemRefresh` controls automatic metric sampling.

export const PROVIDER_NAMES: readonly ProviderName[] = ["codex", "claude"];
export const METRIC_NAMES: readonly MetricName[] = ["cpu", "memory", "swap", "disk", "network", "battery", "temperature"];

export const PROVIDER_MIN_SECONDS = 60;
export const METRIC_MIN_SECONDS = 1;
export const INTERVAL_MAX_SECONDS = 3600;
export const DISK_THRESHOLD_MIN = 50;
export const DISK_THRESHOLD_MAX = 99;
export const DEFAULT_DISK_THRESHOLD = 90;
export const SETTINGS_VERSION = 1;

export function defaultSettings(): Settings {
  const metrics = {} as Settings["metrics"];
  for (const name of METRIC_NAMES) metrics[name] = { enabled: false, seconds: DEFAULT_METRIC_SECONDS[name] };
  return {
    launchAtLogin: true,
    showRemaining: true,
    alerts: true,
    diskAlertThreshold: DEFAULT_DISK_THRESHOLD,
    providers: { codex: true, claude: true },
    providerRefresh: { enabled: true, seconds: PROVIDER_MIN_SECONDS },
    metrics,
    systemRefresh: { enabled: true },
  };
}

// A whole number of seconds in [min, max]. Anything that is not a finite number gets the fallback.
export function clampWhole(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Validates field by field: a bad field takes its default and the rest of the file is kept. Intervals are clamped to
// their ranges (provider refresh never below 60 seconds).
export function normalizeSettings(raw: unknown): Settings {
  const input = record(raw);
  const defaults = defaultSettings();
  const providers = record(input.providers);
  const providerRefresh = record(input.providerRefresh);
  const metricsInput = record(input.metrics);
  const systemRefresh = record(input.systemRefresh);
  const metrics = {} as Settings["metrics"];
  for (const name of METRIC_NAMES) {
    const entry = record(metricsInput[name]);
    metrics[name] = {
      enabled: bool(entry.enabled, defaults.metrics[name].enabled),
      seconds: clampWhole(entry.seconds, METRIC_MIN_SECONDS, INTERVAL_MAX_SECONDS, defaults.metrics[name].seconds),
    };
  }
  return {
    launchAtLogin: bool(input.launchAtLogin, defaults.launchAtLogin),
    showRemaining: bool(input.showRemaining, defaults.showRemaining),
    alerts: bool(input.alerts, defaults.alerts),
    diskAlertThreshold: clampWhole(input.diskAlertThreshold, DISK_THRESHOLD_MIN, DISK_THRESHOLD_MAX, DEFAULT_DISK_THRESHOLD),
    providers: {
      codex: bool(providers.codex, defaults.providers.codex),
      claude: bool(providers.claude, defaults.providers.claude),
    },
    providerRefresh: {
      enabled: bool(providerRefresh.enabled, defaults.providerRefresh.enabled),
      seconds: clampWhole(providerRefresh.seconds, PROVIDER_MIN_SECONDS, INTERVAL_MAX_SECONDS, PROVIDER_MIN_SECONDS),
    },
    metrics,
    systemRefresh: { enabled: bool(systemRefresh.enabled, defaults.systemRefresh.enabled) },
  };
}

// Parses the saved text. Returns null when it is not a JSON object (damaged), so the caller can say so; a JSON object
// is always accepted, and each bad field takes its default (normalizeSettings).
export function settingsFromText(text: string): Settings | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? normalizeSettings(parsed) : null;
  } catch {
    return null;
  }
}

// Parses the saved text. Missing, unreadable or non-JSON text gives the defaults.
export function parseSettings(text: string | null | undefined): Settings {
  if (typeof text !== "string" || text.trim() === "") return defaultSettings();
  return settingsFromText(text) ?? defaultSettings();
}

// The settings as leaves: a map from each field's dotted path (`metrics.cpu.enabled`) to its value. The controller keeps
// the user's changes this way, so a change to one field can be laid over a loaded value without touching the others.
export function settingsLeaves(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) settingsLeaves(child, prefix === "" ? key : `${prefix}.${key}`, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

// The leaves that differ between two settings (their values in `next`).
export function changedLeaves(previous: Settings, next: Settings): Map<string, unknown> {
  const before = settingsLeaves(previous);
  const changed = new Map<string, unknown>();
  for (const [path, value] of settingsLeaves(next)) {
    if (before.get(path) !== value) changed.set(path, value);
  }
  return changed;
}

// `base` with each leaf of `leaves` laid over it, normalised (ranges and defaults as usual).
export function withLeaves(base: Settings, leaves: ReadonlyMap<string, unknown>): Settings {
  const tree = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [path, value] of leaves) {
    const keys = path.split(".");
    let node = tree;
    for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[keys[keys.length - 1]] = value;
  }
  return normalizeSettings(tree);
}

// The file's text: the format marker (`version`, the settings schema, not a save number) and the normalised settings.
export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ version: SETTINGS_VERSION, ...normalizeSettings(settings) }, null, 2);
}
