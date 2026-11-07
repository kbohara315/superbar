import fs from "fs/promises";
import process from "process";
import { batteryTimeText, fullInText, parseProcStat, parseVmRssKb, processCpuPercent, timeToFullSeconds, topEntries } from "./model";
import type { MetricName, MetricReading, ProcessEntry } from "./types";

/** Filesystem boundary kept injectable for deterministic proc/sys fixtures. */
export interface Reader {
  readText(path: string): Promise<string>;
  listDir(path: string): Promise<string[]>;
}
export interface ProcessRunner {
  run(command: string, args: string[]): Promise<{ code?: number | null; stdout: string }>;
}
export const linuxProcessRunner: ProcessRunner = {
  async run(command, args) { return await process.run(command, args); },
};
export const linuxReader: Reader = {
  async readText(path) { return await fs.readFile(path, "utf8"); },
  async listDir(path) { return await fs.readdir(path); },
};

const HISTORY_LIMIT = 30;
const MAX_PROCESS_SCAN = 512;
const DISK_SAMPLE_MIN_SPACING_MS = 5_000;
const DISK_SAMPLE_LIMIT = 512;
const DISK_ETA_REFRESH_MS = 30_000;
const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|tun|tap)/i;
const THERMAL_ZONES = 16;
const unavailable = (name: MetricName): MetricReading => ({ name, available: false, text: "unavailable" });
const size = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};
const duration = (kb: number): string => size(kb * 1024);
const formatRate = (kbPerSecond: number): string => kbPerSecond >= 1024
  ? `${(kbPerSecond / 1024).toFixed(1)} MB/s`
  : `${kbPerSecond.toFixed(kbPerSecond < 10 ? 1 : 0)} KB/s`;
const shortRate = (kbPerSecond: number): string => kbPerSecond >= 1000
  ? `${(kbPerSecond / 1024).toFixed(1)}M`
  : `${Math.round(kbPerSecond)}K`;

/** Linux readers are isolated here; future OS-specific implementations can implement Reader and this sampler contract. */
export class MetricsSampler {
  private history: number[] = [];
  private baseline: { idle: number; total: number } | null = null;
  private networkBaseline: { rx: number; tx: number; at: number } | null = null;
  private networkHistoryValue: number | null = null;
  private processBaseline: { total: number; ticks: Map<string, number> } | null = null;
  private diskSamples: { t: number; free: number }[] = [];
  private diskEtaSeconds: number | null = null;
  private diskEtaEvaluatedAt: number | null = null;
  constructor(readonly name: MetricName, private readonly reader: Reader = linuxReader, private readonly now: () => number = Date.now, private readonly runner: ProcessRunner = linuxProcessRunner) {}

  async sample(): Promise<MetricReading> {
    try {
      let reading: MetricReading;
      switch (this.name) {
        case "cpu": reading = await this.cpu(); break;
        case "memory": reading = await this.memory(false); break;
        case "swap": reading = await this.memory(true); break;
        case "disk": reading = await this.disk(); break;
        case "network": reading = await this.network(); break;
        case "battery": reading = await this.battery(); break;
        case "temperature": reading = await this.temperature(); break;
      }
      const historyValue = this.name === "network" ? this.networkHistoryValue : reading.percent;
      if (reading.available && typeof historyValue === "number") {
        this.history.push(historyValue);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
      }
      if (reading.available) reading.history = [...this.history];
      return reading;
    } catch { return unavailable(this.name); }
  }

  private async cpu(): Promise<MetricReading> {
    const line = (await this.reader.readText("/proc/stat")).split("\n")[0];
    const fields = line.trim().split(/\s+/).slice(1).map(Number);
    if (fields.length < 4 || fields.some(n => !Number.isFinite(n))) return unavailable("cpu");
    const total = fields.reduce((a, b) => a + b, 0), idle = fields[3] + (fields[4] ?? 0), prev = this.baseline;
    this.baseline = { idle, total };
    if (!prev || total <= prev.total) return { name: "cpu", available: true, text: "sampling…" };
    const percent = Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)))));
    return { name: "cpu", available: true, percent, text: `${percent}%` };
  }

  private async memory(swap: boolean): Promise<MetricReading> {
    const text = await this.reader.readText("/proc/meminfo");
    const mem = new Map<string, number>();
    for (const line of text.split("\n")) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) mem.set(m[1], Number(m[2])); }
    const total = mem.get(swap ? "SwapTotal" : "MemTotal") ?? 0;
    const free = mem.get(swap ? "SwapFree" : "MemAvailable") ?? 0;
    if (!(total > 0)) return { name: this.name, available: true, text: "none" };
    const used = Math.max(0, total - free), percent = Math.round(100 * used / total);
    return { name: this.name, available: true, percent, text: duration(used), detail: `of ${duration(total)}` };
  }

  private async network(): Promise<MetricReading> {
    this.networkHistoryValue = null;
    let rx = 0, tx = 0;
    for (const line of (await this.reader.readText("/proc/net/dev")).split("\n")) {
      if (!line.includes(":")) continue;
      const [iface, rest] = line.split(":"); if (VIRTUAL_IFACE.test(iface.trim())) continue;
      const values = rest.trim().split(/\s+/).map(Number);
      if (values.length >= 9) { rx += values[0]; tx += values[8]; }
    }
    const at = this.now(), prev = this.networkBaseline; this.networkBaseline = { rx, tx, at };
    if (!prev || at <= prev.at) return { name: "network", available: true, text: "sampling…" };
    const downBytesPerSecond = Math.max(0, (rx - prev.rx) * 1000 / (at - prev.at));
    const upBytesPerSecond = Math.max(0, (tx - prev.tx) * 1000 / (at - prev.at));
    this.networkHistoryValue = downBytesPerSecond + upBytesPerSecond;
    return {
      name: "network", available: true,
      text: `↓ ${formatRate(downBytesPerSecond / 1024)}`,
      detail: `↑ ${formatRate(upBytesPerSecond / 1024)}`,
      rates: { rx: downBytesPerSecond, tx: upBytesPerSecond },
    };
  }

  /** POSIX df -Pk is invoked directly (no shell); only the root mount row is accepted. */
  private async disk(): Promise<MetricReading> {
    const result = await this.runner.run("df", ["-Pk", "/"]);
    if (result.code !== 0) return unavailable("disk");
    const row = result.stdout.split(/\r?\n/).find(line => /\s\/$/.test(line.trimEnd()));
    if (!row) return unavailable("disk");
    const fields = row.trim().split(/\s+/);
    if (fields.length < 6) return unavailable("disk");
    const [blocks, usedBlocks, availableBlocks] = fields.slice(-5, -2).map(Number);
    const capacity = Number(fields.at(-2)?.replace("%", ""));
    if (![blocks, usedBlocks, availableBlocks, capacity].every(Number.isFinite) || blocks <= 0 || availableBlocks < 0) return unavailable("disk");
    const free = availableBlocks * 1024, at = this.now();
    const lastSample = this.diskSamples.at(-1);
    if (!lastSample || at - lastSample.t >= DISK_SAMPLE_MIN_SPACING_MS) {
      this.diskSamples.push({ t: at, free });
      if (this.diskSamples.length > DISK_SAMPLE_LIMIT) this.diskSamples.shift();
    }
    if (this.diskEtaEvaluatedAt === null || at - this.diskEtaEvaluatedAt >= DISK_ETA_REFRESH_MS) {
      this.diskEtaSeconds = timeToFullSeconds(this.diskSamples, at);
      this.diskEtaEvaluatedAt = at;
    }
    const eta = fullInText(this.diskEtaSeconds);
    return { name: "disk", available: true, percent: capacity, text: `${capacity}%`, detail: [`${size(free)} free`, eta].filter(Boolean).join(" · ") };
  }

  private async battery(): Promise<MetricReading> {
    for (const batt of ["BAT0", "BAT1"]) {
      const base = `/sys/class/power_supply/${batt}`;
      try {
        const capacityText = (await this.reader.readText(`${base}/capacity`)).trim();
        if (!capacityText) continue;
        const capacity = Number(capacityText);
        if (!Number.isFinite(capacity)) continue;
        let status = ""; try { status = (await this.reader.readText(`${base}/status`)).trim(); } catch {}
        const readings: Record<string, number | string | undefined> = { status };
        for (const key of ["energy_now", "energy_full", "power_now", "charge_now", "charge_full", "current_now"]) {
          try { readings[key] = Number((await this.reader.readText(`${base}/${key}`)).trim()); } catch { /* optional sensor */ }
        }
        const time = batteryTimeText(readings as Parameters<typeof batteryTimeText>[0]);
        return { name: "battery", available: true, percent: capacity, text: `${Math.round(capacity)}%`, detail: [status, time].filter(Boolean).join(" · ") || undefined };
      } catch { /* try next battery */ }
    }
    return unavailable("battery");
  }

  private async temperature(): Promise<MetricReading> {
    let hottest: number | null = null;
    for (let i = 0; i < THERMAL_ZONES; i++) {
      try { const raw = (await this.reader.readText(`/sys/class/thermal/thermal_zone${i}/temp`)).trim(); const n = Number(raw); if (raw && Number.isFinite(n) && (hottest === null || n > hottest)) hottest = n; } catch { /* missing zone */ }
    }
    return hottest === null ? unavailable("temperature") : { name: "temperature", available: true, percent: Math.max(0, Math.min(100, hottest / 1000)), text: `${(hottest / 1000).toFixed(1)} °C` };
  }

  async topProcesses(kind: "cpu" | "memory"): Promise<ProcessEntry[]> {
    try {
      const pids = (await this.reader.listDir("/proc")).filter(x => /^\d+$/.test(x)).slice(0, MAX_PROCESS_SCAN);
      const stat = (await this.reader.readText("/proc/stat")).split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
      const total = stat.reduce((a, b) => a + b, 0), previous = this.processBaseline, ticks = new Map<string, number>(), entries: ProcessEntry[] = [];
      for (const pid of pids) try {
        if (kind === "cpu") {
          const info = parseProcStat(await this.reader.readText(`/proc/${pid}/stat`)); if (!info) continue;
          ticks.set(pid, info.ticks);
          const value = processCpuPercent(info.ticks, previous?.ticks.get(pid), total, previous?.total ?? 0);
          entries.push({ name: info.name, value: value ?? NaN, text: value === null ? "—" : `${value}%` });
        } else {
          const kb = parseVmRssKb(await this.reader.readText(`/proc/${pid}/status`)); if (kb === null) continue;
          let name = pid; try { name = (await this.reader.readText(`/proc/${pid}/comm`)).trim() || pid; } catch {}
          entries.push({ name, value: kb, text: duration(kb) });
        }
      } catch { /* process exited or became unreadable */ }
      if (kind === "cpu") this.processBaseline = { total, ticks };
      // Keep first-sample rows visible as `—` while the process CPU baseline is established.
      return kind === "cpu" && !previous
        ? entries.slice(0, 5).map(entry => ({ ...entry, value: 0 }))
        : topEntries(entries, 5);
    } catch { return []; }
  }
}

export function metricLevel(reading: MetricReading, diskThreshold: number): "normal" | "high" {
  if (!reading.available) return "normal";
  if (reading.name === "battery") return (reading.percent ?? 100) <= 15 && !reading.detail?.startsWith("Charging") ? "high" : "normal";
  if (reading.name === "temperature") return (reading.percent ?? 0) >= 85 ? "high" : "normal";
  if (reading.name === "network") return "normal";
  return (reading.percent ?? 0) >= (reading.name === "disk" ? diskThreshold : 90) ? "high" : "normal";
}

/** Compact system-metric text for the top-bar capsule, matching the GNOME extension. */
export function shortMetricText(reading: MetricReading): string {
  if (!reading.available) return "—";
  switch (reading.name) {
    case "cpu":
      return typeof reading.percent === "number" ? `${Math.round(reading.percent)}%` : reading.text === "sampling…" ? "…" : "—";
    case "memory":
    case "swap":
    case "disk":
    case "battery":
      return typeof reading.percent === "number" ? `${Math.round(reading.percent)}%` : "—";
    case "network": {
      if (reading.rates && Number.isFinite(reading.rates.rx) && Number.isFinite(reading.rates.tx)) {
        return `↓${shortRate(Math.max(0, reading.rates.rx) / 1024)} ↑${shortRate(Math.max(0, reading.rates.tx) / 1024)}`;
      }
      // Older or baseline readings may only have display strings; preserve the capsule fallback for them.
      const rate = (text: string | undefined, direction: "↓" | "↑"): string | null => {
        if (!text) return null;
        const match = new RegExp(`^${direction}\\s+([\\d.]+)\\s+(KB|MB)/s$`).exec(text);
        if (!match) return null;
        const value = Number(match[1]);
        if (!Number.isFinite(value)) return null;
        return shortRate(match[2] === "MB" ? value * 1024 : value);
      };
      if (reading.text === "sampling…") return "…";
      const down = rate(reading.text, "↓"), up = rate(reading.detail, "↑");
      return down !== null && up !== null ? `↓${down} ↑${up}` : "—";
    }
    case "temperature": {
      const value = /^([\d.]+)\s*°\s*C$/.exec(reading.text);
      return value && Number.isFinite(Number(value[1])) ? `${Math.round(Number(value[1]))}°` : "—";
    }
  }
}
