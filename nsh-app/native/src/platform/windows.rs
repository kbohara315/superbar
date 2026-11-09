//! The Windows backend: Win32 calls made in-process, no subprocess, no shell, no WMI/PowerShell.
//!
//! Each function makes the documented calls, checks every return value, and hands raw numbers to [`crate::decode`].
//! A failed call is `None`: nothing is estimated. NOT built or run on a Windows host by the author (see NOTES.md).

use core::{ffi::c_void, mem, ptr};

use windows_sys::Win32::{
    Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, NO_ERROR},
    NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_ROW2, MIB_IF_TABLE2},
    Storage::FileSystem::GetDiskFreeSpaceExW,
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
            TH32CS_SNAPPROCESS,
        },
        Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS},
        ProcessStatus::{
            ENUM_PAGE_FILE_INFORMATION, EnumPageFilesW, GetPerformanceInfo, GetProcessMemoryInfo,
            PERFORMANCE_INFORMATION, PROCESS_MEMORY_COUNTERS,
        },
        SystemInformation::{GetSystemWindowsDirectoryW, GlobalMemoryStatusEx, MEMORYSTATUSEX},
        Threading::{
            ALL_PROCESSOR_GROUPS, GetActiveProcessorCount, GetProcessTimes, GetSystemTimes,
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
};

use crate::{
    decode,
    metrics::{
        BatteryStatus, CpuTimes, DiskSpace, MemoryStatus, NetworkInterface, ProcessList,
        ProcessSample, SwapStatus,
    },
};

pub(crate) const SUPPORTED: bool = true;

/// Closes a kernel handle when dropped.
struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle was returned by a successful call and is closed exactly once, here.
        unsafe { CloseHandle(self.0) };
    }
}

/// Frees a table `GetIfTable2` allocated when dropped.
struct MibTable(*mut MIB_IF_TABLE2);

impl Drop for MibTable {
    fn drop(&mut self) {
        // SAFETY: the pointer came from a successful `GetIfTable2` and is freed exactly once, here.
        unsafe { FreeMibTable(self.0.cast::<c_void>()) };
    }
}

fn zeroed_filetime() -> FILETIME {
    FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    }
}

fn ticks(time: &FILETIME) -> u64 {
    decode::filetime(time.dwLowDateTime, time.dwHighDateTime)
}

pub(crate) fn cpu_times() -> Option<CpuTimes> {
    let (mut idle, mut kernel, mut user) =
        (zeroed_filetime(), zeroed_filetime(), zeroed_filetime());
    // SAFETY: three valid, writable FILETIMEs.
    if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
        return None;
    }
    Some(CpuTimes {
        idle: ticks(&idle) as f64,
        kernel: ticks(&kernel) as f64,
        user: ticks(&user) as f64,
    })
}

pub(crate) fn memory() -> Option<MemoryStatus> {
    // SAFETY: MEMORYSTATUSEX is plain data; `dwLength` is set as the call requires.
    let mut status: MEMORYSTATUSEX = unsafe { mem::zeroed() };
    status.dwLength = mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: a valid, writable MEMORYSTATUSEX with its length set.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return None;
    }
    Some(MemoryStatus {
        total: status.ullTotalPhys as f64,
        available: status.ullAvailPhys as f64,
    })
}

/// Totals of the page files, in pages, as `EnumPageFilesW` reports them.
struct PageFiles {
    total: u64,
    used: u64,
}

/// `EnumPageFilesW`'s callback: adds one page file. Returns TRUE to continue.
unsafe extern "system" fn add_page_file(
    context: *mut c_void,
    info: *mut ENUM_PAGE_FILE_INFORMATION,
    _name: *const u16,
) -> i32 {
    // SAFETY: `context` is the `PageFiles` `swap` passed, alive for the whole enumeration; `info` is the system's.
    if let (Some(files), Some(info)) = (unsafe { context.cast::<PageFiles>().as_mut() }, unsafe {
        info.as_ref()
    }) {
        files.total += info.TotalSize as u64;
        files.used += info.TotalInUse as u64;
    }
    1
}

pub(crate) fn swap() -> Option<SwapStatus> {
    // SAFETY: PERFORMANCE_INFORMATION is plain data; `cb` is set as the call requires.
    let mut performance: PERFORMANCE_INFORMATION = unsafe { mem::zeroed() };
    let cb = mem::size_of::<PERFORMANCE_INFORMATION>() as u32;
    performance.cb = cb;
    // SAFETY: a valid, writable structure with its size.
    if unsafe { GetPerformanceInfo(&mut performance, cb) } == 0 || performance.PageSize == 0 {
        return None;
    }
    let mut files = PageFiles { total: 0, used: 0 };
    // SAFETY: the callback only reads what the system passes and writes to `files`, which outlives the call.
    if unsafe {
        EnumPageFilesW(
            Some(add_page_file),
            ptr::from_mut(&mut files).cast::<c_void>(),
        )
    } == 0
    {
        return None;
    }
    let page = performance.PageSize;
    Some(SwapStatus {
        total: decode::pages_to_bytes(files.total as usize, page),
        used: decode::pages_to_bytes(files.used as usize, page),
    })
}

pub(crate) fn disk() -> Option<DiskSpace> {
    // Any directory on the volume works for GetDiskFreeSpaceExW; the Windows directory is on the system volume.
    let mut path = [0u16; 260];
    // SAFETY: a writable buffer of the length passed.
    let length =
        unsafe { GetSystemWindowsDirectoryW(path.as_mut_ptr(), path.len() as u32) } as usize;
    if length == 0 || length >= path.len() {
        return None;
    }
    let (mut free, mut total, mut total_free) = (0u64, 0u64, 0u64);
    // SAFETY: `path` is NUL-terminated (the call wrote it and the rest is zero); three writable u64s.
    if unsafe { GetDiskFreeSpaceExW(path.as_ptr(), &mut free, &mut total, &mut total_free) } == 0 {
        return None;
    }
    Some(DiskSpace {
        total: total as f64,
        free: free as f64,
    })
}

pub(crate) fn network_interfaces() -> Option<Vec<NetworkInterface>> {
    let mut table: *mut MIB_IF_TABLE2 = ptr::null_mut();
    // SAFETY: a writable pointer; on success the system allocates a table that `MibTable` frees.
    if unsafe { GetIfTable2(&mut table) } != NO_ERROR || table.is_null() {
        return None;
    }
    let table = MibTable(table);
    // SAFETY: `NumEntries` rows follow the header, contiguous from `Table` (a one-element array only by declaration),
    // and stay valid until `MibTable` drops.
    let rows: &[MIB_IF_ROW2] = unsafe {
        let count = (*table.0).NumEntries as usize;
        core::slice::from_raw_parts(ptr::addr_of!((*table.0).Table).cast::<MIB_IF_ROW2>(), count)
    };
    let mut interfaces = Vec::new();
    for row in rows {
        if !decode::counts_as_physical_up(
            row.Type,
            row.OperStatus,
            row.InterfaceAndOperStatusFlags._bitfield,
        ) {
            continue;
        }
        let name = decode::wide_to_string(&row.Alias);
        interfaces.push(NetworkInterface {
            index: row.InterfaceIndex,
            name: if name.is_empty() {
                format!("Interface {}", row.InterfaceIndex)
            } else {
                name
            },
            rx_bytes: row.InOctets as f64,
            tx_bytes: row.OutOctets as f64,
        });
    }
    Some(interfaces)
}

pub(crate) fn battery() -> Option<BatteryStatus> {
    // SAFETY: SYSTEM_POWER_STATUS is plain data.
    let mut status: SYSTEM_POWER_STATUS = unsafe { mem::zeroed() };
    // SAFETY: a valid, writable structure.
    if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
        return None;
    }
    decode::battery(
        status.ACLineStatus,
        status.BatteryFlag,
        status.BatteryLifePercent,
        status.BatteryLifeTime,
    )
}

/// One process's numbers, or `None` for one the user may not open (system and protected processes) or that exited.
fn process_sample(pid: u32, exe: &[u16]) -> Option<ProcessSample> {
    // SAFETY: a plain call; a null handle is a refusal.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let handle = Handle(handle);
    let (mut created, mut exited, mut kernel, mut user) = (
        zeroed_filetime(),
        zeroed_filetime(),
        zeroed_filetime(),
        zeroed_filetime(),
    );
    // SAFETY: a process handle with query rights and four writable FILETIMEs.
    if unsafe { GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user) } == 0
    {
        return None;
    }
    // SAFETY: PROCESS_MEMORY_COUNTERS is plain data; `cb` is set as the call requires.
    let mut memory: PROCESS_MEMORY_COUNTERS = unsafe { mem::zeroed() };
    let cb = mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    memory.cb = cb;
    // SAFETY: a process handle with query rights and a writable structure with its size.
    if unsafe { GetProcessMemoryInfo(handle.0, &mut memory, cb) } == 0 {
        return None;
    }
    Some(ProcessSample {
        pid,
        started: ticks(&created) as f64,
        name: decode::wide_to_string(exe),
        cpu_ticks: (ticks(&kernel) + ticks(&user)) as f64,
        working_set: memory.WorkingSetSize as f64,
    })
}

pub(crate) fn processes() -> Option<ProcessList> {
    // SAFETY: a plain call; the invalid handle value is a failure.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return None;
    }
    let snapshot = Handle(snapshot);
    // SAFETY: PROCESSENTRY32W is plain data; `dwSize` is set as the calls require.
    let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
    entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: a snapshot handle and a writable entry with its size set.
    let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
    let mut processes = Vec::new();
    while more && processes.len() < decode::MAX_PROCESSES {
        if decode::is_real_process(entry.th32ProcessID) {
            if let Some(sample) = process_sample(entry.th32ProcessID, &entry.szExeFile) {
                processes.push(sample);
            }
        }
        // SAFETY: as for the first call.
        more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
    }
    // SAFETY: a plain call.
    let cores = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
    (cores > 0).then_some(ProcessList { cores, processes })
}
