import { WindowsMetrics, type BatteryStatus, type WindowsMetricsModule } from "superbar/native";
import { compactDuration } from "./model";

// Windows system metrics come from the app's own Rust module (native/, import "superbar/native"): in-process Win32
// calls (GetSystemTimes, GlobalMemoryStatusEx, EnumPageFilesW, GetDiskFreeSpaceExW, GetIfTable2, GetSystemPowerStatus,
// a Toolhelp process snapshot). Nothing here starts a process, a shell or a script, and `nsh.json` grants no Windows
// executable. The module returns raw counters; the baselines, rates and wording are this app's TSX, so they are tested
// with a fake `WindowsSource` on any platform.

/** What the sampler reads on Windows. The real one is the Rust module; tests pass a fake. */
export type WindowsSource = WindowsMetricsModule;
export type { BatteryStatus };

/** The Rust module itself. On a platform other than Windows every function answers `null`. */
export const nativeWindowsSource: WindowsSource = WindowsMetrics;

/** Windows' battery in the app's words. The wording of `batteryReading`: `status` and, only when known, `time`. */
export function windowsBatteryDetail(battery: BatteryStatus): { percent: number; status: string; time: string | null } {
  const percent = battery.percent;
  const status = battery.charging ? "Charging"
    : battery.acPower === true ? (percent >= 100 ? "Full" : "Not charging")
    : battery.acPower === false ? "Discharging" : "";
  // Windows reports no time to full, and its time left is unknown (null) on AC power: no number is made up for either.
  const seconds = battery.secondsLeft;
  const time = status === "Discharging" && typeof seconds === "number" && seconds > 0 && seconds <= 99 * 3600
    ? `${compactDuration(seconds)} left` : null;
  return { percent, status, time };
}

/** "chrome.exe" → "chrome": the name Linux and macOS lists show (no extension). An empty name falls back to the pid. */
export function windowsProcessName(exe: string, pid: number): string {
  return exe.replace(/\.exe$/i, "").trim() || String(pid);
}
