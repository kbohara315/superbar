//! The exported module and its result types.

use nsh_core::prelude::*;

use crate::platform;

/// Cumulative CPU time of every logical processor together, in 100 ns ticks since boot.
///
/// CPU use between two readings is `1 - Δidle / (Δkernel + Δuser)`: `kernel` includes `idle`, as `GetSystemTimes`
/// documents.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct CpuTimes {
    /// Time spent idle.
    pub idle: f64,
    /// Time spent in kernel mode, idle time included.
    pub kernel: f64,
    /// Time spent in user mode.
    pub user: f64,
}

/// Physical memory, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct MemoryStatus {
    /// Installed memory the OS can use.
    pub total: f64,
    /// Memory that can be given to a process without paging.
    pub available: f64,
}

/// The page files together, in bytes. No page file is a valid answer: both are 0.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct SwapStatus {
    /// Size of all page files.
    pub total: f64,
    /// The part in use.
    pub used: f64,
}

/// A volume's space, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct DiskSpace {
    /// The volume's size, as the current user's quota sees it.
    pub total: f64,
    /// Free space available to the current user.
    pub free: f64,
}

/// Byte counters of one network interface since it came up.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct NetworkInterface {
    /// The interface index: stable while the interface exists, and what tells two adapters of one name apart.
    pub index: u32,
    /// The adapter's friendly name ("Wi-Fi", "Ethernet 2").
    pub name: String,
    /// Bytes received.
    pub rx_bytes: f64,
    /// Bytes sent.
    pub tx_bytes: f64,
}

/// The system battery.
#[derive(Debug, Clone, Copy, PartialEq, JsObject)]
pub struct BatteryStatus {
    /// Charge, 0 to 100.
    pub percent: u32,
    /// Whether it is charging.
    pub charging: bool,
    /// Whether the machine is on AC power; `null` when Windows does not know.
    pub ac_power: Option<bool>,
    /// Estimated seconds of charge left; `null` when Windows does not know, always so while on AC power. Windows has
    /// no time to full, so there is none while charging.
    pub seconds_left: Option<u32>,
}

/// One process.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ProcessSample {
    /// The process id.
    pub pid: u32,
    /// When the process started (100 ns ticks): with `pid` it tells a restarted process from a reused id.
    pub started: f64,
    /// The executable's file name ("chrome.exe").
    pub name: String,
    /// CPU time used so far (kernel and user, 100 ns ticks).
    pub cpu_ticks: f64,
    /// Working set in bytes.
    pub working_set: f64,
}

/// The processes the current user may inspect.
#[derive(Debug, Clone, PartialEq, JsObject)]
pub struct ProcessList {
    /// Logical processors (all groups): CPU time shares are over this many.
    pub cores: u32,
    /// The readable processes. Processes Windows does not let the current user open are left out, not guessed.
    pub processes: Vec<ProcessSample>,
}

/// Windows system metrics, read in-process through Win32. Every function is a plain synchronous call that takes no
/// input and returns numbers; `null` means "could not be read here", and on a platform other than Windows every
/// function says so.
#[module]
pub struct WindowsMetrics;

#[module]
impl WindowsMetrics {
    /// Whether this is Windows, the only platform that reads anything.
    pub fn supported() -> bool {
        platform::SUPPORTED
    }

    /// Cumulative CPU times of the machine (`GetSystemTimes`).
    pub fn cpu_times() -> Option<CpuTimes> {
        platform::cpu_times()
    }

    /// Physical memory (`GlobalMemoryStatusEx`).
    pub fn memory() -> Option<MemoryStatus> {
        platform::memory()
    }

    /// The page files (`EnumPageFilesW`).
    pub fn swap() -> Option<SwapStatus> {
        platform::swap()
    }

    /// Space on the system volume (`GetDiskFreeSpaceExW` on the Windows directory).
    pub fn disk() -> Option<DiskSpace> {
        platform::disk()
    }

    /// Byte counters of the physical network adapters that are up (`GetIfTable2`).
    pub fn network_interfaces() -> Option<Vec<NetworkInterface>> {
        platform::network_interfaces()
    }

    /// The system battery (`GetSystemPowerStatus`); `null` on a machine without one.
    pub fn battery() -> Option<BatteryStatus> {
        platform::battery()
    }

    /// The readable processes (a Toolhelp snapshot, `GetProcessTimes`, `GetProcessMemoryInfo`).
    pub fn processes() -> Option<ProcessList> {
        platform::processes()
    }
}
