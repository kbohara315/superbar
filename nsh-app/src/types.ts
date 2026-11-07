// Shared contract between providers.ts, model.ts, metrics.ts and ui/*.
// Mirrors the Superbar snapshot schema v1 (see ../docs/cli.md). Do not change without the coordinator.

export type ProviderName = "codex" | "claude";
export type ProviderState = "fresh" | "stale" | "unavailable";
export type UsageDisplay = "remaining" | "used";

export interface UsageWindow {
  label: string;
  used_percent: number; // 0..100, always stored as USED
  reset_at: string | null; // UTC ISO 8601
  duration_seconds?: number | null;
}
export interface ProviderError { code: string; message: string }
export interface ProviderSnapshot {
  state: ProviderState;
  last_success_at: string | null;
  windows: { primary: UsageWindow | null; secondary: UsageWindow | null };
  error: ProviderError | null;
  expires_at: string | null; // credential access-token expiry, never the token
}
export interface Snapshot {
  schema_version: 1;
  generated_at: string;
  providers: Record<ProviderName, ProviderSnapshot>;
}

export type MetricName = "cpu" | "memory" | "swap" | "disk" | "network" | "battery" | "temperature";
export interface MetricReading {
  name: MetricName;
  available: boolean;
  percent?: number; // 0..100 when meaningful
  text: string; // primary display text
  detail?: string; // secondary line
  history?: number[]; // sparkline samples, newest last
  rates?: { rx: number; tx: number }; // network only: raw unrounded bytes/second, so compact text is derived from the real rate
}
export interface ProcessEntry { name: string; value: number; text: string }

export interface Settings {
  showRemaining: boolean; // default true
  alerts: boolean; // default true
  diskAlertThreshold: number; // 50..99, default 90
  providers: Record<ProviderName, boolean>; // enabled, default both true
  providerRefresh: { enabled: boolean; seconds: number }; // min 60, default 60
  systemRefresh: { enabled: boolean }; // global automatic system-metric refresh switch, default true
  metrics: Record<MetricName, { enabled: boolean; seconds: number }>; // all disabled by default
}
export const DEFAULT_METRIC_SECONDS: Record<MetricName, number> = {
  cpu: 2, memory: 5, swap: 10, disk: 30, network: 1, battery: 30, temperature: 5,
};

export interface DoctorCheck { name: string; status: "ok" | "warn" | "fail"; detail: string }
