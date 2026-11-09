# Usage

Superbar runs in the desktop tray and opens its own dashboard. The tray icon shows one gauge per enabled provider; its menu offers quick status, refresh, setup-check, dashboard, hide, and quit actions. A primary click opens the dashboard. The app can also run without a tray, in which case its main window remains available.

## Provider usage

The dashboard shows a card for each enabled provider. A card includes the live, stale, or offline state, last successful sync, access-token expiry when available, safe error details, and both usage windows. Each window shows its percentage, reset countdown or local reset time when supplied, and a progress bar. The primary window is usually the 5-hour limit; the secondary is usually weekly, but labels depend on provider data.

The tray gauge represents the **primary (usually 5-hour) window**. By default it shows remaining usage (a window with 2% used reads 98%); turn off **Show remaining usage** to show used usage instead. A high alert is shown when either provider window reaches 90% used. When only the secondary window is high, the tray summary marks it with `wk!`. Missing or reset primary usage has no gauge value. Stale data is dimmed. Tray colors may be reduced to a single foreground color on macOS and Windows, where the desktop draws template icons; the different gauge shapes still distinguish normal, high, and missing values.

After at least three samples spanning ten minutes, a usage window can show a burn-rate estimate: when the current pace would exhaust it before reset, Superbar shows an estimated time; otherwise it says it is safe until reset. These samples stay in memory and are cleared on app restart or when the provider window resets.

Use a card's refresh button to refresh one provider. The dashboard refresh button or tray's **Refresh now** action refreshes both providers and samples enabled metrics. The tray menu also offers per-provider refresh actions. A failed refresh keeps the last successful values and marks them stale or shows an error. Full automatic refresh backs off after rate limiting, doubling from the configured interval up to 15 minutes; a successful full refresh restores the normal interval. Manual refresh remains available during backoff.

Superbar reads the existing Codex and Claude Code credentials from the user's home directory. It does not display or persist access-token values. On macOS, Claude Code credentials stored only in Keychain are not currently supported; the file-based credential path is required.

## Alerts

When **Usage and disk alerts** is enabled, Superbar can send desktop notifications for:

- provider usage windows reaching 80% or 90% used;
- a provider window resetting after it had recorded usage;
- disk usage reaching the configured threshold.

Usage thresholds are always calculated from the amount used, regardless of whether the UI shows remaining or used percentages. Each usage threshold fires once per window period. Only fresh provider data raises a usage alert. Disk alerts fire once when usage reaches the threshold and re-arm after it falls below. Disk alerts require the Disk metric to be enabled. The disk threshold defaults to 90% and can be set from 50% to 99% in Settings.

## System metrics

Metrics are disabled by default. Enable individual metrics in **Settings**; they appear as dashboard tiles and compact status text in the tray menu. Clicking a tile samples it immediately. CPU and memory tiles can be opened to see their top five processes.

| Metric | Display |
|---|---|
| CPU | Usage percentage and a short history sparkline |
| Memory | Used amount, total amount, and percentage |
| Swap | Used amount, total amount, and percentage |
| Disk | System-volume usage and free space, with a trend-based time-to-full estimate when enough samples exist |
| Network | Receive/transmit rates and a short history sparkline |
| Battery | Capacity, charging state, and remaining time when the host reports it |
| Temperature | Hottest reported thermal-zone reading; currently Linux only |

Metric sources vary by platform. Linux reads `/proc` and `/sys` and uses fixed system commands where needed. macOS uses system commands such as `top`, `vm_stat`, `sysctl`, `netstat`, `pmset`, `df`, and `ps`. Windows uses the app's native Rust module and does not start a command interpreter or subprocess for metrics. A metric is reported unavailable when its source is missing or cannot be parsed; Superbar does not estimate unavailable values. CPU and network rates need two readings, so they briefly show `sampling…` after startup. Windows process entries that cannot be queried with the current user's permissions are omitted.

High values use alert coloring: 90% for usage metrics (Disk uses its configured threshold), 15% or lower for a non-charging battery, and 85°C for temperature. Network rates have no fixed alert threshold.

## Settings and refresh intervals

Open Settings with the gear button in the dashboard. Provider refresh and system-metric refresh have independent automatic-refresh controls. Provider refresh defaults to 60 seconds and cannot be set below 60 seconds. Each metric interval can be set from 1 second to 1 hour. Defaults are CPU 2s, memory 5s, swap 10s, disk 30s, network 1s, battery 30s, and temperature 5s. Settings are saved under nsh's per-user data directory.

The Settings screen runs a local setup check when opened. Choose **Run again** to repeat it; the check reports credential and storage readiness without displaying secret values.

## Window behavior

On Linux and Windows, the dashboard normally opens in a separate window while the app's main window is kept out of the way. On macOS, or if opening a second window or installing the tray is unavailable, the main app window is used as the dashboard. Closing the main window can quit the app; this behavior depends on the nsh host and cannot currently be intercepted by the TSX API. Use **Hide dashboard** to hide it without quitting.
