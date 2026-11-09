import fs from "fs/promises";
import process from "process";
import { batteryTimeText, compactDuration, fullInText, parseProcStat, parseVmRssKb, processCpuPercent, timeToFullSeconds, topEntries } from "./model";
import type { MetricName, MetricReading, ProcessEntry } from "./types";
import { nativeWindowsSource, windowsBatteryDetail, windowsProcessName, type WindowsSource } from "./winmetrics";

/** Filesystem boundary kept injectable for deterministic proc/sys fixtures. */
export interface Reader {
  readText(path: string): Promise<string>;
  listDir(path: string): Promise<string[]>;
}
export interface ProcessRunner {
  run(command: string, args: string[]): Promise<{ code?: number | null; stdout: string }>;
}
/** Every command is run directly with an argument array (no shell) and a deadline shorter than the controller's. */
const RUN_TIMEOUT_MS = 12_000;
export const hostProcessRunner: ProcessRunner = {
  async run(command, args) { return await process.run(command, args, { timeoutMs: RUN_TIMEOUT_MS }); },
};
export const linuxProcessRunner: ProcessRunner = hostProcessRunner;
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

// ----- Platform parsers ---------------------------------------------------------------------------------------------
// Each parser takes command output and returns null when the output is not what the platform documents, so a changed
// or localized format makes the metric unavailable instead of wrong. All are pure and covered by fixtures.

const num = (text: string | undefined): number => text === undefined ? NaN : Number(text.replace(",", "."));
const lines = (text: string): string[] => text.split(/\r?\n/);
const UNIT_BYTES: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** macOS `top -l 2`: the last `CPU usage:` line is a real interval sample (the first is since boot). */
export function parseMacTopCpu(text: string): number | null {
  let idle: number | null = null;
  for (const line of lines(text)) {
    const m = /^CPU usage:.*?([\d.,]+)%\s*idle/i.exec(line.trim());
    if (m && Number.isFinite(num(m[1]))) idle = num(m[1]);
  }
  return idle === null ? null : Math.max(0, Math.min(100, Math.round(100 - idle)));
}

/** macOS `vm_stat` plus `hw.memsize`: used = app (anonymous - purgeable) + wired + compressed, as Activity Monitor counts. */
export function parseVmStat(text: string): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!(pageSize > 0)) return null;
  const pages = new Map<string, number>();
  for (const line of lines(text)) { const m = /^(.+?):\s+(\d+)\.?\s*$/.exec(line.trim()); if (m) pages.set(m[1], Number(m[2])); }
  const wired = pages.get("Pages wired down"), compressor = pages.get("Pages occupied by compressor") ?? 0;
  const anonymous = pages.get("Anonymous pages"), purgeable = pages.get("Pages purgeable") ?? 0;
  const app = anonymous !== undefined ? Math.max(0, anonymous - purgeable) : pages.get("Pages active");
  if (wired === undefined || app === undefined) return null;
  return (app + wired + compressor) * pageSize;
}

/** macOS `sysctl -n vm.swapusage`: `total = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)`. */
export function parseSwapUsage(text: string): { total: number; used: number } | null {
  const m = /total\s*=\s*([\d.,]+)([KMG])\s+used\s*=\s*([\d.,]+)([KMG])/i.exec(text);
  if (!m) return null;
  const total = num(m[1]) * UNIT_BYTES[m[2].toUpperCase()], used = num(m[3]) * UNIT_BYTES[m[4].toUpperCase()];
  return Number.isFinite(total) && Number.isFinite(used) && total >= 0 && used >= 0 ? { total, used } : null;
}

export type NetCounters = Map<string, { rx: number; tx: number }>;
const MAC_PHYSICAL_IFACE = /^en\d+$/;

/** macOS `netstat -ib`: one `<Link#n>` row per interface; columns are read from the end because Address may be blank. */
export function parseNetstat(text: string): NetCounters | null {
  const rows = lines(text);
  const header = rows.findIndex(line => /^\s*Name\s+Mtu\s+Network/.test(line));
  if (header < 0) return null;
  const columns = rows[header].trim().split(/\s+/);
  const fromEnd = (name: string) => { const i = columns.indexOf(name); return i < 0 ? -1 : columns.length - i; };
  const rxFromEnd = fromEnd("Ibytes"), txFromEnd = fromEnd("Obytes");
  if (rxFromEnd < 0 || txFromEnd < 0) return null;
  const counters: NetCounters = new Map();
  for (const line of rows.slice(header + 1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !fields[2].startsWith("<Link#")) continue;
    const name = fields[0].replace(/\*$/, "");
    if (!MAC_PHYSICAL_IFACE.test(name) || counters.has(name)) continue;
    const rx = Number(fields[fields.length - rxFromEnd]), tx = Number(fields[fields.length - txFromEnd]);
    if (Number.isFinite(rx) && Number.isFinite(tx)) counters.set(name, { rx, tx });
  }
  return counters;
}

/** macOS `pmset -g batt`. Null when no internal battery is listed (desktop Macs). */
export function parsePmsetBattery(text: string): { percent: number; status: string; time: string | null } | null {
  const line = lines(text).find(l => /InternalBattery/.test(l));
  if (!line) return null;
  const detail = line.slice(line.indexOf("\t") >= 0 ? line.indexOf("\t") : line.indexOf(")") + 1).replace(/present:.*$/i, "");
  const percent = Number(/(\d+)%/.exec(detail)?.[1]);
  if (!Number.isFinite(percent) || percent > 100) return null;
  const parts = detail.split(";").slice(1).map(p => p.trim().toLowerCase());
  const joined = parts.join(";");
  const status = /not charging/.test(joined) ? "Not charging"
    : /discharging/.test(joined) ? "Discharging"
    : /charging|finishing charge/.test(joined) ? "Charging"
    : /charged/.test(joined) ? "Full" : "";
  const remaining = /(\d+):(\d{2})\s+remaining/.exec(detail);
  const seconds = remaining ? (Number(remaining[1]) * 60 + Number(remaining[2])) * 60 : 0;
  const time = seconds > 0 && (status === "Discharging" || status === "Charging")
    ? `${compactDuration(seconds)} ${status === "Charging" ? "to full" : "left"}` : null;
  return { percent, status, time };
}

/** POSIX `df -Pk <mount>`: the row whose mount point is exactly `mount`. */
export function parseDfRow(text: string, mount: string): { blocks: number; used: number; available: number; capacity: number } | null {
  const row = lines(text).find(line => line.trimEnd().endsWith(` ${mount}`) && (mount !== "/" || /\s\/$/.test(line.trimEnd())));
  if (!row) return null;
  const fields = row.trim().split(/\s+/);
  if (fields.length < 6) return null;
  const [blocks, used, available] = fields.slice(-5, -2).map(Number);
  const capacity = Number(fields.at(-2)?.replace("%", ""));
  return [blocks, used, available, capacity].every(Number.isFinite) && blocks > 0 && available >= 0 ? { blocks, used, available, capacity } : null;
}

const MAC_DATA_VOLUME = "/System/Volumes/Data";

/**
 * macOS `ps -Axo pid=,rss=,comm=`: pid, resident KB and the executable. Without `-c`, `comm` is the executable's full
 * path (with `-c` the kernel's 16-character name is used, which cuts "Google Chrome Helper" short), so the name is the
 * path's last component. It is the one name source for both process lists, so a process has the same name in each.
 */
export function parsePsProcesses(text: string): { pid: string; name: string; kb: number }[] {
  const out: { pid: string; name: string; kb: number }[] = [];
  for (const line of lines(text)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const path = m[3], name = path.slice(path.lastIndexOf("/") + 1) || path;
    out.push({ pid: m[1], name, kb: Number(m[2]) });
  }
  return out;
}

/** The last `PID %CPU COMMAND` table of `top -l 2 -stats pid,cpu,command`; %CPU is per core (100 = one full core). COMMAND is truncated by top, so it is only a fallback name. */
export function parseMacTopProcesses(text: string): { pid: string; name: string; cpu: number }[] {
  const rows = lines(text);
  const header = rows.map((l, i) => /^\s*PID\s+%CPU\s+COMMAND/.test(l) ? i : -1).filter(i => i >= 0).at(-1);
  if (header === undefined) return [];
  const out: { pid: string; name: string; cpu: number }[] = [];
  for (const line of rows.slice(header + 1)) {
    const m = /^\s*(\d+)\s+([\d.,]+)\s+(.+?)\s*$/.exec(line);
    if (m && Number.isFinite(num(m[2]))) out.push({ pid: m[1], name: m[3], cpu: num(m[2]) });
  }
  return out;
}

/** Disk sampler state shared by every platform: bounded history, an ETA refreshed at most every 30 s. */
class DiskTrend {
  private samples: { t: number; free: number }[] = [];
  private etaSeconds: number | null = null;
  private etaEvaluatedAt: number | null = null;
  reading(percent: number, freeBytes: number, at: number): MetricReading {
    const last = this.samples.at(-1);
    if (!last || at - last.t >= DISK_SAMPLE_MIN_SPACING_MS) {
      this.samples.push({ t: at, free: freeBytes });
      if (this.samples.length > DISK_SAMPLE_LIMIT) this.samples.shift();
    }
    if (this.etaEvaluatedAt === null || at - this.etaEvaluatedAt >= DISK_ETA_REFRESH_MS) {
      this.etaSeconds = timeToFullSeconds(this.samples, at);
      this.etaEvaluatedAt = at;
    }
    const eta = fullInText(this.etaSeconds);
    return { name: "disk", available: true, percent, text: `${percent}%`, detail: [`${size(freeBytes)} free`, eta].filter(Boolean).join(" · ") };
  }
}

/**
 * One sampler per metric. Linux reads /proc and /sys through the injected Reader; macOS runs fixed system tools
 * directly (no shell) through the injected ProcessRunner; Windows reads the app's own Rust module in-process through
 * the injected WindowsSource (Win32 calls, no subprocess). A metric whose source is missing or unparsable is
 * `unavailable`, never an estimate.
 */
export class MetricsSampler {
  private history: number[] = [];
  private baseline: { idle: number; total: number } | null = null;
  private networkBaseline: { counters: NetCounters; at: number } | null = null;
  private networkHistoryValue: number | null = null;
  private processBaseline: { total: number; ticks: Map<string, number> } | null = null;
  private lastNetwork: MetricReading | null = null;
  private readonly disks = new DiskTrend();
  private cores: number | null = null;
  constructor(
    readonly name: MetricName,
    private readonly reader: Reader = linuxReader,
    private readonly now: () => number = Date.now,
    private readonly runner: ProcessRunner = hostProcessRunner,
    private readonly platform: string = process.platform,
    private readonly win: WindowsSource = nativeWindowsSource,
  ) {}

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

  private get mac(): boolean { return this.platform === "macos"; }
  private get windows(): boolean { return this.platform === "windows"; }
  private get linux(): boolean { return this.platform === "linux"; }

  /** Stdout of a successful command, or null (non-zero exit). Rejections are caught by sample()/topProcesses(). */
  private async out(command: string, args: string[]): Promise<string | null> {
    const result = await this.runner.run(command, args);
    return result.code === 0 || result.code === undefined ? result.stdout : null;
  }
  private async cpu(): Promise<MetricReading> {
    if (this.mac) {
      const text = await this.out("top", ["-l", "2", "-n", "0", "-s", "1"]);
      const percent = text === null ? null : parseMacTopCpu(text);
      return percent === null ? unavailable("cpu") : { name: "cpu", available: true, percent, text: `${percent}%` };
    }
    let idle: number, total: number;
    if (this.windows) {
      // GetSystemTimes: `kernel` includes `idle`, so busy time is kernel + user - idle and the total is kernel + user.
      const times = this.win.cpuTimes();
      if (!times || ![times.idle, times.kernel, times.user].every(Number.isFinite)) return unavailable("cpu");
      idle = times.idle; total = times.kernel + times.user;
    } else {
      if (!this.linux) return unavailable("cpu");
      const line = (await this.reader.readText("/proc/stat")).split("\n")[0];
      const fields = line.trim().split(/\s+/).slice(1).map(Number);
      if (fields.length < 4 || fields.some(n => !Number.isFinite(n))) return unavailable("cpu");
      total = fields.reduce((a, b) => a + b, 0); idle = fields[3] + (fields[4] ?? 0);
    }
    const prev = this.baseline;
    this.baseline = { idle, total };
    if (!prev || total <= prev.total) return { name: "cpu", available: true, text: "sampling…" };
    const percent = Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)))));
    return { name: "cpu", available: true, percent, text: `${percent}%` };
  }

  private memoryReading(swap: boolean, usedBytes: number, totalBytes: number): MetricReading {
    if (!(totalBytes > 0)) return { name: swap ? "swap" : "memory", available: true, text: "none" };
    const used = Math.max(0, Math.min(totalBytes, usedBytes));
    return { name: swap ? "swap" : "memory", available: true, percent: Math.round(100 * used / totalBytes), text: size(used), detail: `of ${size(totalBytes)}` };
  }

  private async memory(swap: boolean): Promise<MetricReading> {
    const name = this.name;
    if (this.mac) {
      if (swap) {
        const text = await this.out("sysctl", ["-n", "vm.swapusage"]);
        const usage = text === null ? null : parseSwapUsage(text);
        return usage === null ? unavailable(name) : this.memoryReading(true, usage.used, usage.total);
      }
      const [vm, mem] = await Promise.all([this.out("vm_stat", []), this.out("sysctl", ["-n", "hw.memsize"])]);
      const used = vm === null ? null : parseVmStat(vm), total = mem === null ? NaN : Number(mem.trim());
      return used === null || !(total > 0) ? unavailable(name) : this.memoryReading(false, used, total);
    }
    if (this.windows) {
      if (swap) { // Bytes over all page files; no page file is `{0, 0}`, which reads "none", not a failure.
        const pages = this.win.swap();
        return pages && pages.total >= 0 && pages.used >= 0 ? this.memoryReading(true, pages.used, pages.total) : unavailable(name);
      }
      const memory = this.win.memory();
      return !memory || !(memory.total > 0) || !(memory.available >= 0) ? unavailable(name) : this.memoryReading(false, memory.total - memory.available, memory.total);
    }
    if (!this.linux) return unavailable(name);
    const text = await this.reader.readText("/proc/meminfo");
    const mem = new Map<string, number>();
    for (const line of text.split("\n")) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) mem.set(m[1], Number(m[2])); }
    const total = mem.get(swap ? "SwapTotal" : "MemTotal") ?? 0;
    const free = mem.get(swap ? "SwapFree" : "MemAvailable") ?? 0;
    if (!(total > 0)) return { name, available: true, text: "none" };
    const used = Math.max(0, total - free), percent = Math.round(100 * used / total);
    return { name, available: true, percent, text: duration(used), detail: `of ${duration(total)}` };
  }

  /** Counters and the clock once the read returned (Windows' read is a synchronous in-process call). */
  private async networkCounters(): Promise<{ counters: NetCounters; at: number } | null> {
    const counters: NetCounters = new Map();
    if (this.mac) {
      const text = await this.out("netstat", ["-ib"]);
      const parsed = text === null ? null : parseNetstat(text);
      return parsed === null ? null : { counters: parsed, at: this.now() };
    }
    if (this.windows) {
      const interfaces = this.win.networkInterfaces();
      if (!interfaces) return null;
      // Keyed by interface index: two adapters may share a friendly name.
      for (const nic of interfaces) counters.set(String(nic.index), { rx: nic.rxBytes, tx: nic.txBytes });
      return { counters, at: this.now() };
    }
    for (const line of (await this.reader.readText("/proc/net/dev")).split("\n")) {
      if (!line.includes(":")) continue;
      const [iface, rest] = line.split(":"); if (VIRTUAL_IFACE.test(iface.trim())) continue;
      const values = rest.trim().split(/\s+/).map(Number);
      if (values.length >= 9) counters.set(iface.trim(), { rx: values[0], tx: values[8] });
    }
    return { counters, at: this.now() };
  }

  private async network(): Promise<MetricReading> {
    this.networkHistoryValue = null;
    if (!this.linux && !this.mac && !this.windows) return unavailable("network");
    const read = await this.networkCounters();
    if (read === null) return unavailable("network");
    const { counters, at } = read, prev = this.networkBaseline;
    this.networkBaseline = { counters, at };
    if (!prev || at <= prev.at) return this.lastNetwork = { name: "network", available: true, text: "sampling…" };
    // Rates come from interfaces present in both samples only, so an adapter that appears or vanishes between two
    // samples is not read as a burst of traffic; a counter that went backwards (a reset) counts as zero.
    let rx = 0, tx = 0;
    for (const [name, now] of counters) {
      const before = prev.counters.get(name);
      if (before) { rx += Math.max(0, now.rx - before.rx); tx += Math.max(0, now.tx - before.tx); }
    }
    const downBytesPerSecond = rx * 1000 / (at - prev.at);
    const upBytesPerSecond = tx * 1000 / (at - prev.at);
    this.networkHistoryValue = downBytesPerSecond + upBytesPerSecond;
    return this.lastNetwork = {
      name: "network", available: true,
      text: `↓ ${formatRate(downBytesPerSecond / 1024)}`,
      detail: `↑ ${formatRate(upBytesPerSecond / 1024)}`,
      rates: { rx: downBytesPerSecond, tx: upBytesPerSecond },
    };
  }

  /** POSIX df -Pk is invoked directly (no shell); only the exact mount row is accepted. Windows reads the system volume in-process. */
  private async disk(): Promise<MetricReading> {
    const at = this.now();
    if (this.windows) {
      const { total, free } = this.win.disk() ?? { total: NaN, free: NaN };
      if (!(total > 0) || !(free >= 0) || free > total) return unavailable("disk");
      return this.disks.reading(Math.round(100 * (total - free) / total), free, at);
    }
    if (!this.linux && !this.mac) return unavailable("disk");
    // macOS: `/` is the read-only system volume; user data lives on the Data volume, in the same APFS container.
    let row = null, mount = "/";
    for (mount of this.mac ? [MAC_DATA_VOLUME, "/"] : ["/"]) {
      const result = await this.runner.run("df", ["-Pk", mount]);
      row = result.code === 0 ? parseDfRow(result.stdout, mount) : null;
      if (row) break;
    }
    if (!row) return unavailable("disk");
    const free = row.available * 1024;
    // On APFS Used covers one volume only, so the used share is everything that is not free in the container.
    const percent = this.mac && mount === MAC_DATA_VOLUME ? Math.round(100 * (row.blocks - row.available) / row.blocks) : row.capacity;
    return this.disks.reading(percent, free, at);
  }

  private batteryReading(parsed: { percent: number; status: string; time: string | null }): MetricReading {
    const detail = [parsed.status, parsed.time].filter(Boolean).join(" · ");
    return { name: "battery", available: true, percent: parsed.percent, text: `${Math.round(parsed.percent)}%`, detail: detail || undefined };
  }

  private async battery(): Promise<MetricReading> {
    if (this.mac) {
      const text = await this.out("pmset", ["-g", "batt"]);
      const parsed = text === null ? null : parsePmsetBattery(text);
      return parsed ? this.batteryReading(parsed) : unavailable("battery");
    }
    if (this.windows) {
      const battery = this.win.battery();
      return battery ? this.batteryReading(windowsBatteryDetail(battery)) : unavailable("battery");
    }
    if (!this.linux) return unavailable("battery");
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

  /**
   * Linux only. macOS exposes no temperature without root (powermetrics) or private SMC keys, and Windows' only
   * stock source (MSAcpi_ThermalZoneTemperature) needs administrator rights and is not a CPU/GPU reading on most
   * machines, so both stay unavailable rather than showing a number that means something else.
   */
  private async temperature(): Promise<MetricReading> {
    if (!this.linux) return unavailable("temperature");
    let hottest: number | null = null;
    for (let i = 0; i < THERMAL_ZONES; i++) {
      try { const raw = (await this.reader.readText(`/sys/class/thermal/thermal_zone${i}/temp`)).trim(); const n = Number(raw); if (raw && Number.isFinite(n) && (hottest === null || n > hottest)) hottest = n; } catch { /* missing zone */ }
    }
    return hottest === null ? unavailable("temperature") : { name: "temperature", available: true, percent: Math.max(0, Math.min(100, hottest / 1000)), text: `${(hottest / 1000).toFixed(1)} °C` };
  }

  /** Logical CPU count, to turn macOS's per-core `top` percentages into a share of all CPUs like Linux's. */
  private async cpuCount(): Promise<number | null> {
    if (this.cores !== null) return this.cores;
    const text = await this.out("sysctl", ["-n", "hw.logicalcpu"]);
    const n = text === null ? NaN : Number(text.trim());
    if (n > 0) this.cores = n;
    return this.cores;
  }

  async topProcesses(kind: "cpu" | "memory"): Promise<ProcessEntry[]> {
    try {
      if (this.mac) return await this.macTopProcesses(kind);
      if (this.windows) return this.winTopProcesses(kind);
      if (!this.linux) return [];
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

  private async macTopProcesses(kind: "cpu" | "memory"): Promise<ProcessEntry[]> {
    // Names for both lists come from `ps` (full executable path, last component); `top` truncates its COMMAND column.
    const PS = ["-Axo", "pid=,rss=,comm="];
    if (kind === "memory") {
      const text = await this.out("ps", PS);
      if (text === null) return [];
      return topEntries(parsePsProcesses(text).filter(p => p.kb > 0).map(p => ({ name: p.name, value: p.kb, text: duration(p.kb) })), 5);
    }
    const cores = await this.cpuCount();
    if (cores === null) return [];
    // A real interval sample (the first of two is since boot); `top` itself is left out because the sampling is its cost.
    const [top, ps] = await Promise.all([
      this.out("top", ["-l", "2", "-s", "1", "-o", "cpu", "-n", "12", "-stats", "pid,cpu,command"]),
      this.out("ps", PS).catch(() => null), // names only: without them top's own (possibly cut-off) names are used
    ]);
    if (top === null) return [];
    const names = new Map((ps === null ? [] : parsePsProcesses(ps)).map(p => [p.pid, p.name]));
    const rows = parseMacTopProcesses(top).map(p => ({ ...p, name: names.get(p.pid) ?? p.name })).filter(p => p.name !== "top")
      .map(p => { const value = Math.round(10 * p.cpu / cores) / 10; return { name: p.name, value, text: `${value}%` }; });
    return topEntries(rows, 5);
  }

  /** Windows process lists, from the Rust module's Toolhelp snapshot (readable processes only; others are left out). */
  private winTopProcesses(kind: "cpu" | "memory"): ProcessEntry[] {
    // CPU shares are over the machine's own CPU time between two readings, like Linux's /proc/stat jiffies; read right
    // before the snapshot (both are synchronous calls, a few milliseconds apart).
    const times = kind === "cpu" ? this.win.cpuTimes() : null;
    const list = this.win.processes();
    if (!list) return [];
    if (kind === "memory") {
      return topEntries(list.processes.map(p => { const kb = p.workingSet / 1024; return { name: windowsProcessName(p.name, p.pid), value: kb, text: duration(kb) }; }), 5);
    }
    if (!times || ![times.kernel, times.user].every(Number.isFinite)) return [];
    const total = times.kernel + times.user, previous = this.processBaseline, ticks = new Map<string, number>(), entries: ProcessEntry[] = [];
    for (const p of list.processes) {
      // pid and start time: a restarted process under a reused pid is a new process, not a counter that went backwards.
      const key = `${p.pid}:${p.started}`;
      ticks.set(key, p.cpuTicks);
      const value = processCpuPercent(p.cpuTicks, previous?.ticks.get(key), total, previous?.total ?? 0);
      entries.push({ name: windowsProcessName(p.name, p.pid), value: value ?? NaN, text: value === null ? "—" : `${value}%` });
    }
    this.processBaseline = { total, ticks };
    // Keep first-sample rows visible as `—` while the process CPU baseline is established.
    return previous ? topEntries(entries, 5) : entries.slice(0, 5).map(entry => ({ ...entry, value: 0 }));
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
