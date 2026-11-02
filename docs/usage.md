# Usage

Superbar adds provider usage pills and optional system metrics to the GNOME top bar. The menu contains provider cards, enabled metric tiles, and a settings screen.

## Provider usage

The panel shows one pill per enabled provider with its icon and primary-window usage percentage. `—` means the value is unavailable. Codex uses green and Claude Code orange; the pill turns red when either reported usage window reaches 90%. Stale provider data is dimmed.

Each provider card shows its live, stale, or offline state, last successful sync time, and primary and secondary usage windows. Each window includes the percentage used, a usage bar, and reset countdown/local reset time when the provider supplies one. The primary window is typically the 5-hour limit; the secondary is typically weekly, though labels and availability depend on provider data.

Use the refresh button on a provider card to refresh only that provider. The menu header refresh button fetches both providers and samples enabled metrics. If a fetch fails, the extension keeps the last successful values and marks the failure. If there is no previous snapshot, provider values show unavailable.

## System metrics

System metrics are off by default. Enable them in the menu's settings screen or the Superbar preferences window in GNOME Extensions. Enabled metrics appear together in a compact top-bar capsule and as tiles in the menu. Tiles are arranged in two columns; network uses a full row. Clicking a tile samples that metric immediately.

| Metric | Display |
|---|---|
| CPU | Usage percentage and a short history sparkline |
| Memory | Used amount, total amount, and percentage |
| Swap | Used amount, total amount, and percentage |
| Disk | Root filesystem usage and free space |
| Network | Receive/transmit rates and a short history sparkline |
| Battery | Capacity and charging status when available |
| Temperature | Hottest reported thermal-zone reading |

Metrics are read from Linux `/proc`, `/sys`, and filesystem data without launching a subprocess. Network rates sum interfaces other than loopback and common virtual interfaces. CPU and network need two readings to calculate a rate; after the first baseline reading, Superbar takes a follow-up reading about one second later. Battery or temperature may show unavailable if the expected sensors are not exposed by the system.

Values at high levels use alert coloring: generally 90% for usage metrics, 15% or below for a non-charging battery, and 85°C for temperature. Network rates have no fixed alert threshold.

## Settings and refresh intervals

The gear button opens settings inside the menu; its back button returns to usage. Closing the menu also returns to the usage screen. The GNOME Extensions preferences window exposes the same display switches and refresh intervals.

Provider usage and system metrics have independent automatic-refresh switches and intervals. Provider refresh defaults to 60 seconds and cannot be set below 60 seconds. System intervals can be set from 1 second to 1 hour. Defaults are CPU 2s, memory 5s, swap 10s, disk 30s, network 1s, battery 30s, and temperature 5s. The menu settings editor accepts seconds or minutes; the preferences window accepts seconds.

The extension imposes a 40-second timeout on a provider fetch. The CLI's provider-fetch worker has its own 35-second deadline; see the [CLI reference](cli.md).
