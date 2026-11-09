//! Pure conversions from what Win32 returns to what the module exports. No FFI here, so every rule is tested on every
//! platform (the Windows backend only fills these in).
#![cfg_attr(not(windows), allow(dead_code))]

use crate::metrics::BatteryStatus;

/// `IfOperStatusUp` of `IF_OPER_STATUS`.
pub(crate) const IF_OPER_STATUS_UP: i32 = 1;
/// `IF_TYPE_SOFTWARE_LOOPBACK` (`MIB_IF_TYPE_LOOPBACK`).
pub(crate) const IF_TYPE_LOOPBACK: u32 = 24;
/// `IF_TYPE_TUNNEL`: Teredo, 6to4 and other pseudo-interfaces.
pub(crate) const IF_TYPE_TUNNEL: u32 = 131;
/// Bit 0 of `MIB_IF_ROW2.InterfaceAndOperStatusFlags`: `HardwareInterface`.
const FLAG_HARDWARE_INTERFACE: u8 = 1;
/// The most processes one listing returns: a bound for a pathological snapshot, far above a real machine's count.
pub(crate) const MAX_PROCESSES: usize = 4096;

/// A `FILETIME`'s two halves as one count of 100 ns ticks.
pub(crate) fn filetime(low: u32, high: u32) -> u64 {
    (u64::from(high) << 32) | u64::from(low)
}

/// The text of a NUL-terminated UTF-16 buffer (lossy for unpaired surrogates).
pub(crate) fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

/// Whether a network row is a physical adapter that is up: hardware, operationally up, not loopback or a tunnel. The
/// same selection as `Get-NetAdapter -Physical` with `Status Up`, so virtual switches, VPNs and loopback do not count
/// the same traffic twice.
pub(crate) fn counts_as_physical_up(if_type: u32, oper_status: i32, flags: u8) -> bool {
    oper_status == IF_OPER_STATUS_UP
        && if_type != IF_TYPE_LOOPBACK
        && if_type != IF_TYPE_TUNNEL
        && flags & FLAG_HARDWARE_INTERFACE != 0
}

/// A process is a real one: pid 0 is the "System Idle Process", whose CPU time is the idle time of every core.
pub(crate) fn is_real_process(pid: u32) -> bool {
    pid != 0
}

/// `SYSTEM_POWER_STATUS` as a battery. `None` when there is no system battery (`BatteryFlag` bit 128) or the
/// percentage is unknown (255), so a desktop reads "unavailable", never a made-up charge. `seconds_left` is
/// `BatteryLifeTime`, `None` while Windows reports it unknown (`0xFFFFFFFF`, which is also what it says on AC power);
/// Windows gives no time to full, so a charging battery has none.
pub(crate) fn battery(
    ac_line_status: u8,
    battery_flag: u8,
    percent: u8,
    life_seconds: u32,
) -> Option<BatteryStatus> {
    if battery_flag & 128 != 0 || battery_flag == 255 || percent > 100 {
        return None;
    }
    Some(BatteryStatus {
        percent: u32::from(percent),
        charging: battery_flag & 8 != 0,
        ac_power: match ac_line_status {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        },
        seconds_left: (life_seconds != u32::MAX).then_some(life_seconds),
    })
}

/// Pages as bytes (`f64`: JavaScript's number).
pub(crate) fn pages_to_bytes(pages: usize, page_size: usize) -> f64 {
    pages as f64 * page_size as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filetime_joins_the_halves() {
        assert_eq!(filetime(1, 0), 1);
        assert_eq!(filetime(0, 1), 1 << 32);
        assert_eq!(filetime(u32::MAX, u32::MAX), u64::MAX);
    }

    #[test]
    fn wide_text_stops_at_the_nul_and_survives_bad_surrogates() {
        let ok: Vec<u16> = "Wi-Fi \u{4e2d}"
            .encode_utf16()
            .chain([0, 'x' as u16])
            .collect();
        assert_eq!(wide_to_string(&ok), "Wi-Fi \u{4e2d}");
        assert_eq!(wide_to_string(&[b'a' as u16, b'b' as u16]), "ab");
        assert_eq!(wide_to_string(&[0xD800, 0]), "\u{FFFD}");
        assert_eq!(wide_to_string(&[]), "");
    }

    #[test]
    fn only_physical_adapters_that_are_up_count() {
        assert!(counts_as_physical_up(6, 1, 1)); // Ethernet, up, hardware
        assert!(counts_as_physical_up(71, 1, 0b0000_0101)); // Wi-Fi with another flag set
        assert!(!counts_as_physical_up(6, 2, 1)); // down
        assert!(!counts_as_physical_up(6, 1, 0)); // a virtual switch or VPN
        assert!(!counts_as_physical_up(IF_TYPE_LOOPBACK, 1, 1));
        assert!(!counts_as_physical_up(IF_TYPE_TUNNEL, 1, 1));
        assert!(!counts_as_physical_up(6, 5, 1)); // dormant
    }

    #[test]
    fn the_idle_process_is_not_a_process() {
        assert!(!is_real_process(0));
        assert!(is_real_process(4));
    }

    #[test]
    fn a_battery_needs_a_battery_and_a_known_charge() {
        assert_eq!(battery(1, 128, 255, u32::MAX), None); // no system battery
        assert_eq!(battery(1, 255, 80, 0), None); // unknown status
        assert_eq!(battery(0, 1, 255, 0), None); // unknown percentage
        assert_eq!(battery(0, 1, 101, 0), None);
    }

    #[test]
    fn a_battery_reports_power_charging_and_the_time_it_knows() {
        let on_battery = battery(0, 1, 87, 8400).unwrap();
        assert_eq!(
            on_battery,
            BatteryStatus {
                percent: 87,
                charging: false,
                ac_power: Some(false),
                seconds_left: Some(8400)
            }
        );
        let charging = battery(1, 8 | 1, 55, u32::MAX).unwrap();
        assert_eq!(
            charging,
            BatteryStatus {
                percent: 55,
                charging: true,
                ac_power: Some(true),
                seconds_left: None
            }
        );
        let full = battery(1, 1, 100, u32::MAX).unwrap();
        assert_eq!(
            (full.percent, full.charging, full.ac_power),
            (100, false, Some(true))
        );
        assert_eq!(battery(255, 1, 50, u32::MAX).unwrap().ac_power, None);
    }

    #[test]
    fn pages_become_bytes() {
        assert_eq!(pages_to_bytes(256, 4096), 1_048_576.0);
        assert_eq!(pages_to_bytes(0, 4096), 0.0);
    }
}
