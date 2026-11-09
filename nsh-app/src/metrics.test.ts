import { expect, test } from "nsh/test";
import manifest from "../nsh.json";
import { MetricsSampler, metricLevel, parseDfRow, parseMacTopCpu, parseMacTopProcesses, parseNetstat, parsePmsetBattery, parsePsProcesses, parseSwapUsage, parseVmStat, shortMetricText, type ProcessRunner, type Reader } from "./metrics";
import type { MetricName, MetricReading } from "./types";
import { WindowsMetrics, type BatteryStatus, type CpuTimes, type DiskSpace, type MemoryStatus, type NetworkInterface, type ProcessList, type ProcessSample, type SwapStatus } from "superbar/native";
import { windowsBatteryDetail, windowsProcessName, type WindowsSource } from "./winmetrics";

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
  const cpu = new MetricsSampler("cpu", f, Date.now, undefined, "linux");
  expect((await cpu.sample()).text).toBe("sampling…");
  f.files.set("/proc/stat", procStat(20, 180));
  const reading = await cpu.sample();
  expect(reading.percent).toBe(10);
  expect(reading.history).toEqual([10]);
});
test("memory and swap parse meminfo usage", async () => {
  const f = new Fixtures(); f.files.set("/proc/meminfo", "MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 400 kB\nSwapFree: 100 kB\n");
  expect((await new MetricsSampler("memory", f, Date.now, undefined, "linux").sample()).percent).toBe(75);
  expect((await new MetricsSampler("swap", f, Date.now, undefined, "linux").sample()).percent).toBe(75);
});

test("zero total swap is handled without division by zero", async () => {
  const f = new Fixtures(); f.files.set("/proc/meminfo", "SwapTotal: 0 kB\nSwapFree: 0 kB\n");
  const reading = await new MetricsSampler("swap", f, Date.now, undefined, "linux").sample();
  expect(reading.available).toBe(true);
  expect(reading.text).toBe("none");
  expect(reading.percent).toBeUndefined();
});

test("network takes two readings and excludes loopback and virtual interfaces", async () => {
  const f = new Fixtures(); let now = 1000; f.files.set("/proc/net/dev", net(1000, 2000));
  const network = new MetricsSampler("network", f, () => now, undefined, "linux");
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
    const network = new MetricsSampler("network", f, () => now, undefined, "linux");
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
  const network = new MetricsSampler("network", f, () => now, undefined, "linux");
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
  const battery = await new MetricsSampler("battery", f, Date.now, undefined, "linux").sample();
  expect(battery.detail).toContain("Discharging");
  expect(metricLevel(battery, 90)).toBe("high");
  expect((await new MetricsSampler("temperature", f, Date.now, undefined, "linux").sample()).text).toBe("87.0 °C");
});

test("top processes scan fixture pids and memory entries", async () => {
  const f = new Fixtures(); f.dirs.set("/proc", ["11", "12", "not-a-pid"]);
  f.files.set("/proc/stat", procStat(10, 90));
  f.files.set("/proc/11/status", "VmRSS: 200 kB\n"); f.files.set("/proc/11/comm", "large\n");
  f.files.set("/proc/12/status", "VmRSS: 50 kB\n"); f.files.set("/proc/12/comm", "small\n");
  const rows = await new MetricsSampler("memory", f, Date.now, undefined, "linux").topProcesses("memory");
  expect(rows[0].name).toBe("large");
  expect(rows[0].text).toContain("KB");
});

test("disk parses df root usage, estimates time to full, and handles command failure", async () => {
  const runner = new DfFixture(); let now = 0;
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner, "linux");
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
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner, "linux");
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
  const retained = (disk as unknown as { disks: { samples: { t: number; free: number }[] } }).disks.samples;
  expect(retained.length).toBe(512);
  expect(reading.detail).toContain("full in");
});

test("disk ETA still works with thirty-second sampling", async () => {
  const runner = new DfFixture(); let now = 0;
  const disk = new MetricsSampler("disk", new Fixtures(), () => now, runner, "linux");
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

// ----- macOS: fake process runner -------------------------------------------------------------------------

/** Answers by the exact command line; an Error value rejects like a missing or ungranted command. */
class FakeRunner implements ProcessRunner {
  answers = new Map<string, { code: number; stdout: string } | Error>();
  calls: string[] = [];
  /** Every command name that was started, for the grant test. */
  commands = new Set<string>();
  on(commandLine: string, stdout: string, code = 0): this { this.answers.set(commandLine, { code, stdout }); return this; }
  async run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
    const key = [command, ...args].join(" ");
    this.commands.add(command);
    this.calls.push(key);
    const answer = this.answers.get(key);
    if (!answer) throw new Error(`unexpected command: ${key}`);
    if (answer instanceof Error) throw answer;
    return answer;
  }
}
const macSampler = (name: MetricName, runner: ProcessRunner, now: () => number = () => 0) => new MetricsSampler(name, new Fixtures(), now, runner, "macos");
const TOP_CPU = "top -l 2 -n 0 -s 1";
const NETSTAT = `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                          1000     0     500000     1000     0     500000     0
lo0        16384 127           127.0.0.1           1000     -     500000     1000     -     500000     -
en0        1500  <Link#6>      aa:bb:cc:dd:ee:ff   5000     0    1000000     3000     0    2000000     0
en0        1500  192.168.1     192.168.1.5         5000     -    1000000     3000     -    2000000     -
en5*       1500  <Link#12>                           50     0       4000       60     0       8000     0
utun0      1380  <Link#9>                           100     0      99999      100     0      99999     0
awdl0      1500  <Link#11>     aa:bb:cc:dd:ee:00     10     0      99999       10     0      99999     0
`;
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               3190.
Pages active:                           241222.
Pages inactive:                         240576.
Pages wired down:                        50000.
Pages purgeable:                         20000.
Anonymous pages:                        100000.
Pages occupied by compressor:            10000.
`;

test("macOS CPU takes the last top interval and is unavailable when top fails or changes format", async () => {
  const runner = new FakeRunner().on(TOP_CPU, "CPU usage: 50.00% user, 30.00% sys, 20.00% idle\nCPU usage: 4.83% user, 9.67% sys, 85.00% idle\n");
  const cpu = macSampler("cpu", runner);
  const reading = await cpu.sample();
  expect(reading.percent).toBe(15); expect(reading.text).toBe("15%"); expect(reading.history).toEqual([15]);
  runner.on(TOP_CPU, "something else\n");
  expect((await cpu.sample()).available).toBe(false);
  runner.on(TOP_CPU, "", 1);
  expect((await cpu.sample()).available).toBe(false);
  expect(parseMacTopCpu("CPU usage: 1,5% user, 2,5% sys, 96,0% idle")).toBe(4);
});

test("macOS memory counts app, wired and compressed pages against hw.memsize; swap reads vm.swapusage", async () => {
  const runner = new FakeRunner().on("vm_stat", VM_STAT).on("sysctl -n hw.memsize", "8589934592\n")
    .on("sysctl -n vm.swapusage", "total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n");
  const memory = await macSampler("memory", runner).sample();
  expect(memory.percent).toBe(27); expect(memory.text).toBe("2.1 GB"); expect(memory.detail).toBe("of 8.0 GB");
  expect(parseVmStat(VM_STAT)).toBe((100000 - 20000 + 50000 + 10000) * 16384);
  const swap = await macSampler("swap", runner).sample();
  expect(swap.percent).toBe(25); expect(swap.text).toBe("512 MB"); expect(swap.detail).toBe("of 2.0 GB");
  runner.on("sysctl -n vm.swapusage", "total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)\n");
  const none = await macSampler("swap", runner).sample();
  expect(none.available).toBe(true); expect(none.text).toBe("none"); expect(none.percent).toBeUndefined();
  runner.on("vm_stat", "garbage\n");
  expect((await macSampler("memory", runner).sample()).available).toBe(false);
  runner.on("vm_stat", VM_STAT).on("sysctl -n hw.memsize", "not a number");
  expect((await macSampler("memory", runner).sample()).available).toBe(false);
});

test("macOS network sums physical en interfaces, handles a blank address column, and ignores new interfaces", async () => {
  expect([...parseNetstat(NETSTAT)!.entries()]).toEqual([["en0", { rx: 1_000_000, tx: 2_000_000 }], ["en5", { rx: 4000, tx: 8000 }]]);
  const runner = new FakeRunner().on("netstat -ib", NETSTAT); let now = 0;
  const network = macSampler("network", runner, () => now);
  expect((await network.sample()).text).toBe("sampling…");
  // en0 moved 4096 down / 2048 up in 2 s; en5 is untouched; en6 is new with large counters and must not read as a burst.
  runner.on("netstat -ib", `${NETSTAT.replace("1000000     3000", "1004096     3000").replace("2000000     0\nen0", "2002048     0\nen0")}en6        1500  <Link#14>                          10     0   90000000   10     0   90000000   0\n`);
  now = 2000;
  const value = await network.sample();
  expect(value.text).toBe("↓ 2.0 KB/s"); expect(value.detail).toBe("↑ 1.0 KB/s");
  expect(value.history).toEqual([3072]);
  runner.on("netstat -ib", "", 1);
  now = 4000;
  expect((await network.sample()).available).toBe(false);
  expect(parseNetstat("no table here")).toBeNull();
});

test("macOS disk uses the Data volume with the container's free space, and falls back to / when it is missing", async () => {
  const header = "Filesystem 1024-blocks Used Available Capacity Mounted on\n";
  const runner = new FakeRunner().on("df -Pk /System/Volumes/Data", `${header}/dev/disk3s5 488245288 300000000 150000000 67% /System/Volumes/Data\n`);
  const first = await macSampler("disk", runner).sample();
  // Capacity says 67% (this volume only); the share of the container that is not free is 69%.
  expect(first.percent).toBe(69); expect(first.detail).toBe("143 GB free");
  runner.on("df -Pk /System/Volumes/Data", "df: /System/Volumes/Data: No such file or directory\n", 1).on("df -Pk /", `${header}/dev/disk1s1 100000 40000 60000 40% /\n`);
  const fallback = await macSampler("disk", runner).sample();
  expect(fallback.percent).toBe(40); expect(fallback.detail).toBe("59 MB free");
  runner.on("df -Pk /", "", 1);
  expect((await macSampler("disk", runner).sample()).available).toBe(false);
  expect(parseDfRow(`${header}/dev/x 100 50 50 50% /Volumes/Other\n`, "/")).toBeNull();
});

test("macOS battery parses pmset states, and a desktop Mac without a battery is unavailable", async () => {
  const batt = (line: string) => `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t${line} present: true\n`;
  const runner = new FakeRunner().on("pmset -g batt", batt("87%; discharging; 4:23 remaining"));
  const battery = await macSampler("battery", runner).sample();
  expect(battery.percent).toBe(87); expect(battery.text).toBe("87%"); expect(battery.detail).toBe("Discharging · 4h 23m left");
  expect(parsePmsetBattery(batt("65%; charging; 1:20 remaining"))).toEqual({ percent: 65, status: "Charging", time: "1h 20m to full" });
  expect(parsePmsetBattery(batt("87%; discharging; (no estimate)"))).toEqual({ percent: 87, status: "Discharging", time: null });
  expect(parsePmsetBattery(batt("100%; charged; 0:00 remaining"))).toEqual({ percent: 100, status: "Full", time: null });
  expect(parsePmsetBattery(batt("80%; AC attached; not charging"))).toEqual({ percent: 80, status: "Not charging", time: null });
  runner.on("pmset -g batt", batt("12%; discharging; 0:30 remaining"));
  const low = await macSampler("battery", runner).sample();
  expect(metricLevel(low, 90)).toBe("high");
  runner.on("pmset -g batt", "Now drawing from 'AC Power'\n");
  expect((await macSampler("battery", runner).sample()).available).toBe(false);
});

const PS_ALL = "ps -Axo pid=,rss=,comm=";
const TOP_PROCS = "top -l 2 -s 1 -o cpu -n 12 -stats pid,cpu,command";
const PS_TABLE = `    1    1024 /sbin/launchd
  412  204800 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
   99   30720 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
  500   51200 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
    0       0 kernel_task
`;
const TOP_TABLE = `PID    %CPU COMMAND
1      30.0 launchd
PID    %CPU COMMAND
412    80.0 Google Chrome He
99     40.0 WindowServer
7      6.0  top
`;

test("macOS top processes: both lists take full names from ps; CPU comes from a top interval as a share of all CPUs without top itself", async () => {
  const runner = new FakeRunner().on(PS_ALL, PS_TABLE).on("sysctl -n hw.logicalcpu", "8\n").on(TOP_PROCS, TOP_TABLE);
  const memory = await macSampler("memory", runner).topProcesses("memory");
  expect(memory.map(r => [r.name, r.text])).toEqual([["Google Chrome Helper (Renderer)", "200 MB"], ["Finder", "50 MB"], ["WindowServer", "30 MB"], ["launchd", "1.0 MB"]]);
  // top cuts the name to "Google Chrome He"; the pid maps it to the same full name the memory list shows.
  const cpu = await macSampler("cpu", runner).topProcesses("cpu");
  expect(cpu.map(r => [r.name, r.text])).toEqual([["Google Chrome Helper (Renderer)", "10%"], ["WindowServer", "5%"]]);
  expect(new Set(cpu.map(r => r.name)).size).toBe(cpu.length);
  expect(memory.map(r => r.name)).toContain(cpu[0].name);

  // ps unavailable: top's own names are used rather than nothing.
  const noPs = new FakeRunner().on(PS_ALL, "", 1).on("sysctl -n hw.logicalcpu", "8\n").on(TOP_PROCS, TOP_TABLE);
  expect((await macSampler("cpu", noPs).topProcesses("cpu")).map(r => r.name)).toEqual(["Google Chrome He", "WindowServer"]);
  // A pid ps does not list (it exited, or it started after ps ran) keeps top's name.
  const stale = new FakeRunner().on(PS_ALL, "    1 1024 /sbin/launchd\n").on("sysctl -n hw.logicalcpu", "8\n").on(TOP_PROCS, TOP_TABLE);
  expect((await macSampler("cpu", stale).topProcesses("cpu")).map(r => r.name)).toEqual(["Google Chrome He", "WindowServer"]);
  runner.on("sysctl -n hw.logicalcpu", "", 1);
  expect(await macSampler("cpu", runner).topProcesses("cpu")).toEqual([]);
  runner.on(PS_ALL, "", 1);
  expect(await macSampler("memory", runner).topProcesses("memory")).toEqual([]);
});

test("macOS process parsers keep the whole name, strip the path, and read pids", () => {
  expect(parsePsProcesses("  12  300 /usr/bin/a b/c d\n  13 0 kernel_task\nnot a row\n")).toEqual([
    { pid: "12", name: "c d", kb: 300 }, { pid: "13", name: "kernel_task", kb: 0 },
  ]);
  expect(parseMacTopProcesses("PID %CPU COMMAND\n1 1.0 old\nPID %CPU COMMAND\n42 12,5 Some App\n")).toEqual([{ pid: "42", name: "Some App", cpu: 12.5 }]);
});

test("macOS temperature stays unavailable and runs nothing", async () => {
  const runner = new FakeRunner();
  expect((await macSampler("temperature", runner).sample()).available).toBe(false);
  expect(runner.calls).toEqual([]);
});

// ----- Windows: a fake of the Rust module -----------------------------------------------------------------------------------

/** The Rust module with canned answers. Each call is recorded; a field set to `null` is "could not be read"; a function value throws or varies per call. */
class FakeWindows implements WindowsSource {
  calls: string[] = [];
  cpu: CpuTimes | null = null;
  mem: MemoryStatus | null = null;
  pages: SwapStatus | null = null;
  volume: DiskSpace | null = null;
  nics: NetworkInterface[] | null = null;
  bat: BatteryStatus | null = null;
  procs: ProcessList | null = null;
  fail: string | null = null;
  private take<T>(name: string, value: T): T { this.calls.push(name); if (this.fail === name) throw new Error(`${name} refused`); return value; }
  supported(): boolean { return true; }
  cpuTimes(): CpuTimes | null { return this.take("cpuTimes", this.cpu); }
  memory(): MemoryStatus | null { return this.take("memory", this.mem); }
  swap(): SwapStatus | null { return this.take("swap", this.pages); }
  disk(): DiskSpace | null { return this.take("disk", this.volume); }
  networkInterfaces(): NetworkInterface[] | null { return this.take("networkInterfaces", this.nics); }
  battery(): BatteryStatus | null { return this.take("battery", this.bat); }
  processes(): ProcessList | null { return this.take("processes", this.procs); }
}
const GIB = 1024 ** 3;
/** One Windows sampler over a fake module and a runner that fails the test if anything is started. */
const winRig = (name: MetricName) => {
  const win = new FakeWindows(), runner = new FakeRunner(), c = { now: 0 };
  const sampler = new MetricsSampler(name, new Fixtures(), () => c.now, runner, "windows", win);
  return { win, runner, c, sampler };
};
const nic = (index: number, name: string, rxBytes: number, txBytes: number): NetworkInterface => ({ index, name, rxBytes, txBytes });
const proc = (pid: number, name: string, cpuTicks: number, workingSet: number, started = 1000): ProcessSample => ({ pid, name, cpuTicks, workingSet, started });

test("Windows CPU: the first reading is a baseline, then busy share = 1 - idle/total with kernel counting idle", async () => {
  const { win, runner, sampler } = winRig("cpu");
  win.cpu = { idle: 1000, kernel: 2000, user: 1000 };
  expect(await sampler.sample()).toMatchObject({ name: "cpu", available: true, text: "sampling…" });
  win.cpu = { idle: 1500, kernel: 3000, user: 1500 }; // total 3000 -> 4500, idle +500 of +1500: 2/3 busy
  const second = await sampler.sample();
  expect(second.percent).toBe(67); expect(second.text).toBe("67%"); expect(second.history).toEqual([67]);
  win.cpu = { idle: 1500, kernel: 3000, user: 1500 }; // the counters did not advance: no divide by zero, a new baseline
  expect((await sampler.sample()).text).toBe("sampling…");
  win.cpu = { idle: 3000, kernel: 4500, user: 1500 }; // all idle
  expect((await sampler.sample()).percent).toBe(0);
  win.cpu = { idle: 3000, kernel: 5500, user: 2500 }; // none idle
  expect((await sampler.sample()).percent).toBe(100);
  expect(runner.calls).toEqual([]);
});

test("Windows CPU is unavailable when the module cannot read it, returns a non-number, or throws", async () => {
  const { win, sampler } = winRig("cpu");
  expect((await sampler.sample()).available).toBe(false); // null
  win.cpu = { idle: NaN, kernel: 1, user: 1 };
  expect((await sampler.sample()).available).toBe(false);
  win.cpu = { idle: 1, kernel: 2, user: 2 }; win.fail = "cpuTimes";
  expect((await sampler.sample()).available).toBe(false);
});

test("Windows memory is total minus available; swap is the page files, and no page file is none", async () => {
  const mem = winRig("memory"), swap = winRig("swap");
  mem.win.mem = { total: 16 * GIB, available: 4 * GIB };
  const m = await mem.sampler.sample();
  expect(m).toMatchObject({ available: true, percent: 75, text: "12 GB", detail: "of 16 GB" });
  mem.win.mem = { total: 0, available: 0 };
  expect((await mem.sampler.sample()).available).toBe(false);
  mem.win.mem = null;
  expect((await mem.sampler.sample()).available).toBe(false);
  swap.win.pages = { total: 3 * GIB, used: GIB / 2 };
  expect(await swap.sampler.sample()).toMatchObject({ available: true, percent: 17, text: "512 MB", detail: "of 3.0 GB" });
  swap.win.pages = { total: 0, used: 0 };
  expect(await swap.sampler.sample()).toMatchObject({ available: true, text: "none" });
  swap.win.pages = null;
  expect((await swap.sampler.sample()).available).toBe(false);
  expect(mem.runner.calls).toEqual([]); expect(swap.runner.calls).toEqual([]);
});

test("Windows network: rates from counter deltas over the clock, adapters tracked by index, a new or vanished adapter is not a burst", async () => {
  const { win, c, sampler } = winRig("network");
  win.nics = [nic(5, "Wi-Fi", 1_000_000, 100_000), nic(9, "Wi-Fi", 500, 500)]; // two adapters may share a name
  c.now = 10_000;
  expect(await sampler.sample()).toMatchObject({ available: true, text: "sampling…" });
  win.nics = [nic(5, "Wi-Fi", 3_048_576, 612_400), nic(9, "Wi-Fi", 500, 500), nic(12, "Ethernet", 9_000_000_000, 9_000_000_000)];
  c.now = 12_000;
  const reading = await sampler.sample();
  expect(reading.text).toBe("↓ 1000 KB/s"); expect(reading.detail).toBe("↑ 250 KB/s");
  expect(reading.rates).toEqual({ rx: 1_024_288, tx: 256_200 });
  expect(reading.history).toEqual([1_024_288 + 256_200]);
  win.nics = [nic(12, "Ethernet", 9_000_001_000, 9_000_000_000)]; // Wi-Fi went away
  c.now = 13_000;
  expect((await sampler.sample()).rates).toEqual({ rx: 1000, tx: 0 });
  win.nics = [nic(12, "Ethernet", 10, 10)]; // the counters reset
  c.now = 14_000;
  expect((await sampler.sample()).rates).toEqual({ rx: 0, tx: 0 });
  win.nics = [];
  c.now = 15_000;
  expect((await sampler.sample()).available).toBe(true);
  win.nics = null;
  expect((await sampler.sample()).available).toBe(false);
});

test("Windows battery: the status comes from power and charging, and no time to full is invented", () => {
  const detail = (b: BatteryStatus) => { const d = windowsBatteryDetail(b); return [d.percent, d.status, d.time]; };
  expect(detail({ percent: 87, charging: false, acPower: false, secondsLeft: 8400 })).toEqual([87, "Discharging", "2h 20m left"]);
  expect(detail({ percent: 87, charging: false, acPower: false, secondsLeft: null })).toEqual([87, "Discharging", null]);
  expect(detail({ percent: 87, charging: false, acPower: false, secondsLeft: 0 })).toEqual([87, "Discharging", null]);
  expect(detail({ percent: 87, charging: false, acPower: false, secondsLeft: 100 * 3600 })).toEqual([87, "Discharging", null]);
  expect(detail({ percent: 55, charging: true, acPower: true, secondsLeft: null })).toEqual([55, "Charging", null]);
  expect(detail({ percent: 55, charging: true, acPower: true, secondsLeft: 3600 })).toEqual([55, "Charging", null]);
  expect(detail({ percent: 100, charging: false, acPower: true, secondsLeft: null })).toEqual([100, "Full", null]);
  expect(detail({ percent: 80, charging: false, acPower: true, secondsLeft: null })).toEqual([80, "Not charging", null]);
  expect(detail({ percent: 80, charging: false, acPower: null, secondsLeft: 3600 })).toEqual([80, "", null]);
  expect(detail({ percent: 80, charging: false })).toEqual([80, "", null]);
});

test("Windows battery sampler: reading text, and a machine without a battery is unavailable", async () => {
  const { win, runner, sampler } = winRig("battery");
  win.bat = { percent: 87, charging: false, acPower: false, secondsLeft: 8400 };
  expect(await sampler.sample()).toMatchObject({ available: true, percent: 87, text: "87%", detail: "Discharging · 2h 20m left" });
  win.bat = { percent: 55, charging: true, acPower: true, secondsLeft: null };
  expect((await sampler.sample()).detail).toBe("Charging");
  win.bat = { percent: 80, charging: false, acPower: null, secondsLeft: null };
  expect((await sampler.sample()).detail).toBeUndefined();
  win.bat = null; // a desktop PC
  expect((await sampler.sample()).available).toBe(false);
  expect(runner.calls).toEqual([]);
});

test("Windows disk reads the system volume and keeps the free-space trend", async () => {
  const { win, c, sampler } = winRig("disk");
  win.volume = { total: 500e9, free: 125e9 };
  const first = await sampler.sample();
  expect(first.percent).toBe(75); expect(first.text).toBe("75%"); expect(first.detail).toBe("116 GB free");
  win.volume = { total: 500e9, free: 100e9 }; c.now = 5 * 60_000; await sampler.sample();
  win.volume = { total: 500e9, free: 75e9 }; c.now = 10 * 60_000;
  expect((await sampler.sample()).detail).toContain("full in");
  for (const bad of [{ total: 0, free: 0 }, { total: 100, free: 200 }, { total: 100, free: -1 }, null]) {
    win.volume = bad; c.now += 60_000;
    expect((await sampler.sample()).available).toBe(false);
  }
});

test("Windows process names lose the .exe, and an empty name is the pid", () => {
  expect(windowsProcessName("chrome.exe", 1)).toBe("chrome");
  expect(windowsProcessName("Code.EXE", 1)).toBe("Code");
  expect(windowsProcessName("my.exe.exe", 1)).toBe("my.exe");
  expect(windowsProcessName("System", 4)).toBe("System");
  expect(windowsProcessName(".exe", 77)).toBe("77");
  expect(windowsProcessName("", 8)).toBe("8");
});

test("Windows memory list: working sets, largest first, five rows", async () => {
  const { win, runner, sampler } = winRig("memory");
  win.procs = { cores: 8, processes: [
    proc(1, "a.exe", 0, 100 * 1024 ** 2), proc(2, "chrome.exe", 0, 2 * GIB), proc(3, "b.exe", 0, 300 * 1024 ** 2),
    proc(4, "c.exe", 0, 50 * 1024 ** 2), proc(5, "d.exe", 0, 400 * 1024 ** 2), proc(6, "e.exe", 0, 10 * 1024 ** 2), proc(7, "idle.exe", 0, 0),
  ] };
  const rows = await sampler.topProcesses("memory");
  expect(rows.map(r => r.name)).toEqual(["chrome", "d", "b", "a", "c"]);
  expect(rows[0]).toEqual({ name: "chrome", value: 2 * GIB / 1024, text: "2.0 GB" });
  expect(win.calls).toEqual(["processes"]); // the memory list does not read the CPU counters
  win.procs = null;
  expect(await sampler.topProcesses("memory")).toEqual([]);
  win.fail = "processes";
  expect(await sampler.topProcesses("memory")).toEqual([]);
  expect(runner.calls).toEqual([]);
});

test("Windows CPU list: first reading shows rows as —, then shares of all CPU time; a reused pid is a new process", async () => {
  const { win, runner, sampler } = winRig("cpu");
  win.cpu = { idle: 0, kernel: 8_000, user: 2_000 }; // machine total 10 000 ticks
  win.procs = { cores: 8, processes: [proc(10, "chrome.exe", 100, 1), proc(11, "msedge.exe", 50, 1), proc(12, "quiet.exe", 7, 1)] };
  expect(await sampler.topProcesses("cpu")).toEqual([
    { name: "chrome", value: 0, text: "—" }, { name: "msedge", value: 0, text: "—" }, { name: "quiet", value: 0, text: "—" },
  ]);
  win.cpu = { idle: 0, kernel: 16_000, user: 4_000 }; // +10 000
  win.procs = { cores: 8, processes: [
    proc(10, "chrome.exe", 1_100, 1), // +1000 of 10 000: 10%
    proc(11, "msedge.exe", 50, 1), // idle: dropped by topEntries
    proc(12, "quiet.exe", 7 + 2_550, 1, 2000), // same pid, started later: a new process, no baseline -> —
    proc(13, "new.exe", 500, 1), // appeared after the baseline: —
  ] };
  expect(await sampler.topProcesses("cpu")).toEqual([{ name: "chrome", value: 10, text: "10%" }]);
  win.cpu = { idle: 0, kernel: 24_000, user: 6_000 }; // +10 000 again
  win.procs = { cores: 8, processes: [proc(10, "chrome.exe", 1_100 + 1_234, 1), proc(12, "quiet.exe", 7 + 2_550 + 50, 1, 2000), proc(13, "new.exe", 500 + 4_000, 1)] };
  expect(await sampler.topProcesses("cpu")).toEqual([
    { name: "new", value: 40, text: "40%" }, { name: "chrome", value: 12.3, text: "12.3%" }, { name: "quiet", value: 0.5, text: "0.5%" },
  ]);
  // A counter that went backwards is not a negative share.
  win.cpu = { idle: 0, kernel: 32_000, user: 8_000 };
  win.procs = { cores: 8, processes: [proc(10, "chrome.exe", 5, 1)] };
  expect(await sampler.topProcesses("cpu")).toEqual([]);
  expect(runner.calls).toEqual([]);
});

test("Windows CPU list is empty when the machine's CPU time or the snapshot cannot be read", async () => {
  const { win, sampler } = winRig("cpu");
  win.procs = { cores: 4, processes: [proc(1, "a.exe", 1, 1)] };
  expect(await sampler.topProcesses("cpu")).toEqual([]); // no cpuTimes
  win.cpu = { idle: 0, kernel: NaN, user: 1 };
  expect(await sampler.topProcesses("cpu")).toEqual([]);
  win.cpu = { idle: 0, kernel: 10, user: 1 }; win.procs = null;
  expect(await sampler.topProcesses("cpu")).toEqual([]);
});

test("Windows temperature stays unavailable and reads nothing", async () => {
  const { win, runner, sampler } = winRig("temperature");
  expect((await sampler.sample()).available).toBe(false);
  expect(win.calls).toEqual([]); expect(runner.calls).toEqual([]);
});

test("every Windows sampler fails closed when the module throws", async () => {
  for (const [name, fn] of [["cpu", "cpuTimes"], ["memory", "memory"], ["swap", "swap"], ["disk", "disk"], ["network", "networkInterfaces"], ["battery", "battery"]] as [MetricName, string][]) {
    const { win, sampler } = winRig(name);
    win.fail = fn;
    expect([name, (await sampler.sample()).available]).toEqual([name, false]);
  }
});

test("the Rust module on this platform: unavailable off Windows, shaped as declared on Windows", () => {
  if (!WindowsMetrics.supported()) {
    expect(WindowsMetrics.cpuTimes()).toBeNull(); expect(WindowsMetrics.memory()).toBeNull(); expect(WindowsMetrics.swap()).toBeNull();
    expect(WindowsMetrics.disk()).toBeNull(); expect(WindowsMetrics.networkInterfaces()).toBeNull();
    expect(WindowsMetrics.battery()).toBeNull(); expect(WindowsMetrics.processes()).toBeNull();
    return;
  }
  // On a Windows host (`nsh test --target windows`): real numbers, checked for shape only.
  const t = WindowsMetrics.cpuTimes()!; expect([t.idle, t.kernel, t.user].every(n => Number.isFinite(n) && n >= 0)).toBe(true);
  expect(t.kernel).toBeGreaterThanOrEqual(t.idle);
  const m = WindowsMetrics.memory()!; expect(m.total).toBeGreaterThan(0); expect(m.available).toBeLessThanOrEqual(m.total);
  const d = WindowsMetrics.disk()!; expect(d.total).toBeGreaterThan(0); expect(d.free).toBeLessThanOrEqual(d.total);
  const sw = WindowsMetrics.swap()!; expect(sw.used).toBeLessThanOrEqual(sw.total);
  const list = WindowsMetrics.processes()!; expect(list.cores).toBeGreaterThan(0); expect(list.processes.length).toBeGreaterThan(0);
  expect(list.processes.every(p => p.pid > 0 && p.name.length > 0 && p.workingSet >= 0 && p.cpuTicks >= 0)).toBe(true);
});

test("the real Rust module feeds a Windows sampler: on a non-Windows host every metric is unavailable and nothing is started", async () => {
  if (WindowsMetrics.supported()) return;
  const runner = new FakeRunner();
  for (const name of ["cpu", "memory", "swap", "disk", "network", "battery", "temperature"] as MetricName[]) {
    expect([name, (await new MetricsSampler(name, new Fixtures(), () => 0, runner, "windows").sample()).available]).toEqual([name, false]);
  }
  expect(await new MetricsSampler("cpu", new Fixtures(), () => 0, runner, "windows").topProcesses("cpu")).toEqual([]);
  expect(runner.calls).toEqual([]);
});

test("an unknown platform reports every metric unavailable without touching the host", async () => {
  const runner = new FakeRunner(), f = new Fixtures();
  for (const name of ["cpu", "memory", "swap", "disk", "network", "battery", "temperature"] as MetricName[]) {
    expect((await new MetricsSampler(name, f, () => 0, runner, "freebsd").sample()).available).toBe(false);
  }
  expect(await new MetricsSampler("cpu", f, () => 0, runner, "freebsd").topProcesses("cpu")).toEqual([]);
  expect(runner.calls).toEqual([]);
});

test("a command the app is not granted makes the metric unavailable instead of throwing", async () => {
  const denied = new FakeRunner().on("pmset -g batt", ""); denied.answers.set("pmset -g batt", Object.assign(new Error("not granted"), { code: "ERR_ACCESS_DENIED" }));
  expect((await macSampler("battery", denied).sample()).available).toBe(false);
});

// ----- Grants --------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** Answers every command with empty success (and a core count), so each code path runs and only the command names matter. */
class RecordingRunner implements ProcessRunner {
  commands = new Set<string>();
  async run(command: string, args: string[]): Promise<{ code: number; stdout: string }> {
    this.commands.add(command);
    return { code: 0, stdout: args.join(" ").includes("hw.logicalcpu") ? "8\n" : "" };
  }
}

test("every command the app runs, on every platform, is exactly granted in nsh.json process.execute", async () => {
  const granted: string[] = manifest.capabilities.process.execute;
  const runner = new RecordingRunner();
  const names: MetricName[] = ["cpu", "memory", "swap", "disk", "network", "battery", "temperature"];
  for (const platform of ["linux", "macos", "windows"]) {
    for (const name of names) {
      const sampler = new MetricsSampler(name, new Fixtures(), () => 0, runner, platform, new FakeWindows());
      await sampler.sample();
      if (name === "cpu" || name === "memory") await sampler.topProcesses(name);
    }
  }
  const executed = [...runner.commands].sort();
  // The runner is exact-match: a command the app starts that nsh.json does not list would be refused at runtime.
  expect(executed.filter(c => !granted.includes(c))).toEqual([]);
  // And nothing is granted that metrics.ts does not use, apart from chmod (store.ts, for the settings file modes).
  expect(granted.filter(c => !executed.includes(c)).sort()).toEqual(["chmod"]);
  // Windows reads the Rust module, not a program: its sampler started no command at all, and no interpreter is granted.
  const windowsRunner = new RecordingRunner();
  for (const name of names) {
    const sampler = new MetricsSampler(name, new Fixtures(), () => 0, windowsRunner, "windows", new FakeWindows());
    await sampler.sample();
    if (name === "cpu" || name === "memory") await sampler.topProcesses(name);
  }
  expect([...windowsRunner.commands]).toEqual([]);
  expect(granted.filter(c => /^(powershell|pwsh|cmd|wmic|bash|sh|cscript|wscript|mshta|rundll32)(\.exe)?$/i.test(c))).toEqual([]);
  // The Rust crate is the app's, and is built into the app's hosts.
  expect(manifest.rust).toBe("native");
  // No wildcard and no path-less pattern: each entry is a bare name.
  expect(granted.every(c => /^[A-Za-z0-9_.-]+$/.test(c))).toBe(true);
});
