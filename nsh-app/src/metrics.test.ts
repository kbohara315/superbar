import { expect, test } from "nsh/test";
import { MetricsSampler, metricLevel, shortMetricText, type ProcessRunner, type Reader } from "./metrics";
import type { MetricReading } from "./types";

class Fixtures implements Reader {
  files = new Map<string, string>();
  dirs = new Map<string, string[]>();
  async readText(path: string): Promise<string> { const value = this.files.get(path); if (value === undefined) throw new Error(`missing ${path}`); return value; }
  async listDir(path: string): Promise<string[]> { return this.dirs.get(path) ?? []; }
}
class DfFixture implements ProcessRunner {
  output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 40000 60000 40% /\n";
  code = 0;
  async run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
    expect(command).toBe("df"); expect(args).toEqual(["-Pk", "/"]);
    return { code: this.code, stdout: this.output };
  }
}
const procStat = (user: number, idle: number) => `cpu ${user} 0 0 ${idle} 0 0 0 0\n`;
const net = (rx: number, tx: number) => `Inter-| Receive | Transmit\n face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed\n eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n lo: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0\n docker0: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0\n`;

test("CPU needs a baseline and then samples percentage history", async () => {
  const f = new Fixtures(); f.files.set("/proc/stat", procStat(10, 90));
  const cpu = new MetricsSampler("cpu", f);
  expect((await cpu.sample()).text).toBe("sampling…");
  f.files.set("/proc/stat", procStat(20, 180));
  const reading = await cpu.sample();
  expect(reading.percent).toBe(10);
  expect(reading.history).toEqual([10]);
});

test("memory and swap parse meminfo usage", async () => {
  const f = new Fixtures(); f.files.set("/proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 400 kB\nSwapFree: 100 kB\n");
  expect((await new MetricsSampler("memory", f).sample()).percent).toBe(75);
  expect((await new MetricsSampler("swap", f).sample()).percent).toBe(75);
});

test("zero total swap is handled without division by zero", async () => {
  const f = new Fixtures(); f.files.set("/proc/meminfo", "SwapTotal: 0 kB\nSwapFree: 0 kB\n");
  const reading = await new MetricsSampler("swap", f).sample();
  expect(reading.available).toBe(true);
  expect(reading.text).toBe("none");
  expect(reading.percent).toBeUndefined();
});

test("network takes two readings and excludes loopback and virtual interfaces", async () => {
  const f = new Fixtures(); let now = 1000; f.files.set("/proc/net/dev", net(1000, 2000));
  const network = new MetricsSampler("network", f, () => now);
  const baseline = await network.sample();
  expect(baseline.text).toBe("sampling…");
  expect(shortMetricText(baseline)).toBe("…");
  expect(baseline.rates).toBeUndefined();
  f.files.set("/proc/net/dev", net(3048, 4048)); now += 1000;
  const value = await network.sample();
  expect(value.text).toBe("↓ 2.0 KB/s"); expect(value.detail).toBe("↑ 2.0 KB/s");
  expect(value.percent).toBeUndefined();
  expect(value.history).toEqual([4096]);
});

test("network rate text and capsule form match extension thresholds and raw-rate rounding", async () => {
  const readingAtRate = async (kbPerSecond: number): Promise<MetricReading> => {
    const f = new Fixtures(); let now = 0;
    const network = new MetricsSampler("network", f, () => now);
    f.files.set("/proc/net/dev", net(0, 0)); await network.sample();
    f.files.set("/proc/net/dev", net(Math.round(kbPerSecond * 1024 * 10), 0)); now = 10_000;
    return await network.sample();
  };
  expect((await readingAtRate(0.5)).text).toBe("↓ 0.5 KB/s");
  expect((await readingAtRate(1.5)).text).toBe("↓ 1.5 KB/s");
  expect((await readingAtRate(2048)).text).toBe("↓ 2.0 MB/s");
  expect((await readingAtRate(5120)).text).toBe("↓ 5.0 MB/s");

  const cases: [number, string, string][] = [
    [999.6, "↓ 1000 KB/s", "↓1000K ↑0K"],
    [1000.4, "↓ 1000 KB/s", "↓1.0M ↑0K"],
    [1023.6, "↓ 1024 KB/s", "↓1.0M ↑0K"],
    [1024.4, "↓ 1.0 MB/s", "↓1.0M ↑0K"],
  ];
  for (const [kbPerSecond, expectedTile, expectedCompact] of cases) {
    const reading = await readingAtRate(kbPerSecond);
    expect(reading.text).toBe(expectedTile);
    expect(shortMetricText(reading)).toBe(expectedCompact);
    expect(reading.rates?.rx).toBeGreaterThan(0);
    expect(reading.rates?.tx).toBe(0);
  }
});

test("shortMetricText formats every metric and unavailable readings", () => {
  const readings: MetricReading[] = [
    { name: "cpu", available: true, text: "27%", percent: 27 },
    { name: "memory", available: true, text: "4 GB", percent: 32 },
    { name: "swap", available: true, text: "1 GB", percent: 25 },
    { name: "disk", available: true, text: "91%", percent: 91 },
    { name: "network", available: true, text: "↓ 12.0 KB/s", detail: "↑ 3 KB/s", rates: { rx: 12 * 1024, tx: 3 * 1024 } },
    { name: "battery", available: true, text: "98%", percent: 98 },
    { name: "temperature", available: true, text: "45.4 °C", percent: 45.4 },
    { name: "cpu", available: false, text: "unavailable" },
  ];
  expect(readings.map(shortMetricText)).toEqual(["27%", "32%", "25%", "91%", "↓12K ↑3K", "98%", "45°", "—"]);
  expect(shortMetricText({ name: "cpu", available: true, text: "sampling…" })).toBe("…");
});

test("network sparkline retains raw combined byte rates and clamps counter resets", async () => {
  const f = new Fixtures(); let now = 0;
  const network = new MetricsSampler("network", f, () => now);
  f.files.set("/proc/net/dev", net(100_000_000, 100_000_000));
  await network.sample();
  f.files.set("/proc/net/dev", net(100_204_800, 100_000_000)); now += 1000;
  const at200 = await network.sample();
  f.files.set("/proc/net/dev", net(102_252_800, 100_000_000)); now += 1000;
  const at2000 = await network.sample();
  f.files.set("/proc/net/dev", net(0, 0)); now += 1000;
  const reset = await network.sample();
  expect(at200.history).toEqual([204_800]);
  expect(at2000.history).toEqual([204_800, 2_048_000]);
  expect(reset.history).toEqual([204_800, 2_048_000, 0]);
  expect(reset.history?.every(rate => rate >= 0)).toBe(true);
});

test("battery and hottest thermal zone are read from sysfs", async () => {
  const f = new Fixtures();
  f.files.set("/sys/class/power_supply/BAT0/capacity", "12\n");
  f.files.set("/sys/class/power_supply/BAT0/status", "Discharging\n");
  f.files.set("/sys/class/power_supply/BAT0/energy_now", "100"); f.files.set("/sys/class/power_supply/BAT0/energy_full", "200"); f.files.set("/sys/class/power_supply/BAT0/power_now", "10");
  f.files.set("/sys/class/thermal/thermal_zone0/temp", "71000"); f.files.set("/sys/class/thermal/thermal_zone1/temp", "87000");
  const battery = await new MetricsSampler("battery", f).sample();
  expect(battery.detail).toContain("Discharging");
  expect(metricLevel(battery, 90)).toBe("high");
  expect((await new MetricsSampler("temperature", f).sample()).text).toBe("87.0 °C");
});

test("top processes scan fixture pids and memory entries", async () => {
  const f = new Fixtures(); f.dirs.set("/proc", ["11", "12", "not-a-pid"]);
  f.files.set("/proc/stat", procStat(10, 90));
  f.files.set("/proc/11/status", "VmRSS: 200 kB\n"); f.files.set("/proc/11/comm", "large\n");
  f.files.set("/proc/12/status", "VmRSS: 50 kB\n"); f.files.set("/proc/12/comm", "small\n");
  const rows = await new MetricsSampler("memory", f).topProcesses("memory");
  expect(rows[0].name).toBe("large");
  expect(rows[0].text).toContain("KB");
});

test("disk parses df root usage, estimates time to full, and handles command failure", async () => {
  const runner = new DfFixture(); let now = 0;
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner);
  const first = await disk.sample();
  expect(first.percent).toBe(40); expect(first.detail).toContain("59 MB free");
  runner.output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 50000 50000 50% /\n";
  now = 5 * 60_000; await disk.sample();
  runner.output = "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 60000 40000 60% /\n";
  now = 10 * 60_000;
  expect((await disk.sample()).detail).toContain("full in");
  runner.code = 1;
  expect((await disk.sample()).available).toBe(false);
});

test("disk ETA matures at one-second cadence and retained samples stay bounded", async () => {
  const runner = new DfFixture(); let now = 0;
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner);
  let reading = await disk.sample();
  for (let second = 0; second <= 660; second++) {
    const available = 60_000 - second * 10;
    const used = 100_000 - available;
    runner.output = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 ${used} ${available} ${Math.round(used / 1000)}% /\n`;
    now = second * 1000;
    reading = await disk.sample();
  }
  expect(reading.detail).toContain("full in");

  // Continue well beyond the initial history window; retention must remain capped.
  for (let second = 661; second <= 4_000; second++) {
    const available = 60_000 - second * 10;
    const used = 100_000 - available;
    runner.output = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 ${used} ${available} ${Math.round(used / 1000)}% /\n`;
    now = second * 1000;
    reading = await disk.sample();
  }
  const retained = (disk as unknown as { diskSamples: { t: number; free: number }[] }).diskSamples;
  expect(retained.length).toBe(512);
  expect(reading.detail).toContain("full in");
});

test("disk ETA still works with thirty-second sampling", async () => {
  const runner = new DfFixture(); let now = 0;
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner);
  let reading = await disk.sample();
  for (let sample = 0; sample <= 22; sample++) {
    const available = 60_000 - sample * 1_000;
    const used = 100_000 - available;
    runner.output = `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 100000 ${used} ${available} ${Math.round(used / 1000)}% /\n`;
    now = sample * 30_000;
    reading = await disk.sample();
  }
  expect(reading.detail).toContain("full in");
});
