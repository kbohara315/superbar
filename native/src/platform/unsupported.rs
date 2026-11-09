//! Every platform but Windows: nothing is read.

use crate::metrics::{
    BatteryStatus, CpuTimes, DiskSpace, MemoryStatus, NetworkInterface, ProcessList, SwapStatus,
};

pub(crate) const SUPPORTED: bool = false;

pub(crate) fn cpu_times() -> Option<CpuTimes> {
    None
}
pub(crate) fn memory() -> Option<MemoryStatus> {
    None
}
pub(crate) fn swap() -> Option<SwapStatus> {
    None
}
pub(crate) fn disk() -> Option<DiskSpace> {
    None
}
pub(crate) fn network_interfaces() -> Option<Vec<NetworkInterface>> {
    None
}
pub(crate) fn battery() -> Option<BatteryStatus> {
    None
}
pub(crate) fn processes() -> Option<ProcessList> {
    None
}

#[cfg(test)]
mod tests {
    #[test]
    #[allow(clippy::assertions_on_constants)]
    fn nothing_is_read_off_windows() {
        assert!(!super::SUPPORTED);
        assert!(
            super::cpu_times().is_none() && super::memory().is_none() && super::swap().is_none()
        );
        assert!(super::disk().is_none() && super::network_interfaces().is_none());
        assert!(super::battery().is_none() && super::processes().is_none());
    }
}
