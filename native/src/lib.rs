//! Superbar's native code: Windows system metrics, read in-process.
//!
//! `src/winmetrics.ts` imports [`WindowsMetrics`] from `superbar/native` (`nsh.json` `"rust"`); `src/metrics.ts` uses it through that file. It is a
//! narrow, typed API that returns numbers and nothing else: no command, path, URL or script goes in, and no
//! subprocess is ever started (the Windows backend calls Win32 directly). On other platforms every function answers
//! "unavailable" (`null` or empty), so the TSX decides what to show and Linux and macOS keep their own sources.
//!
//! Layout: [`metrics`] has the exported module and its result types, [`decode`] the pure conversions (tested on every
//! platform), and `platform` the Windows FFI (`cfg(windows)`) or the stub that replaces it.

mod decode;
mod metrics;
mod platform;

use nsh_core::prelude::*;

pub use crate::metrics::{
    BatteryStatus, CpuTimes, DiskSpace, MemoryStatus, NetworkInterface, ProcessList, ProcessSample,
    SwapStatus, WindowsMetrics,
};

/// The crate's UI set (`nsh.json` `"rust"`): what `src/winmetrics.ts` imports from `superbar/native`.
#[native_module("superbar/native")]
fn native(registry: &mut Registry) {
    registry.module::<WindowsMetrics>();
}
