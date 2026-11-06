# Usage

Superbar adds provider usage pills and optional system metrics to the GNOME top bar. The menu contains provider cards, enabled metric tiles, and a settings screen.

## Provider usage

The panel shows one pill per enabled provider with its icon. The pill's number is the **5-hour (primary) window only**: by default its remaining percentage (a 5-hour window at 2% used shows `98%`), or its used percentage with the display setting off (`2%`). The weekly window never changes the number. If the 5-hour window is missing or has reset, the pill shows `—`.

The pill turns red when **either** window reaches 90% used, so a nearly exhausted weekly limit is still visible. When that red comes from the weekly window while the 5-hour number is healthy, the pill appends ` wk!`, for example `98% wk!`. A red pill with a plain number means the 5-hour window itself is at 90% used or more. Codex uses green and Claude Code orange otherwise. The colour is always decided on used percentage, so red means the same thing in both modes. Both windows are listed on the provider card in the menu. Stale provider data is dimmed.

**Show remaining usage (off = show used)** in the menu's settings screen, or in the Usage group of the preferences window, switches every Codex and Claude Code percentage to used. It is on by default. The pill, the card percentages, the usage bars, the alert wording and the `status --line` output all follow it. The bars fill with the amount shown: with remaining, a fresh window is full and empties as you use it. System metric percentages are unaffected.

Each provider card shows its live, stale, or offline state, last successful sync time, and, when the credential file records one, the access-token expiry. It is read from the credential file on each render, so a token that Claude Code or Codex renewed since the last fetch is shown correctly. The card says `token expires in 20m`. An expired access token is normal, because the CLI renews it on next use, so the card says `token renews on next use`. Only when the last refresh failed with `authentication_required` does it say `token expired · sign in again`. If the credential file is missing, the card falls back to the expiry saved with the last fetch. If the last refresh left an error, a reason line shows the safe error code and a fix hint, for example `authentication_required: Run `claude` to sign in again`, `rate_limited: Rate limited; retrying with backoff`, or `response_invalid: Provider API may have changed`. Each card also shows its primary and secondary usage windows. Each window includes its percentage (`20% left`, or `80% used` with the setting off), a usage bar, and reset countdown/local reset time when the provider supplies one. The primary window is typically the 5-hour limit; the secondary is typically weekly, though labels and availability depend on provider data.

A window whose reset time has passed no longer describes a current period. It shows `reset · usage unknown` (or `reset passed · awaiting data`), has an empty bar, and does not count toward the pill until fresh data arrives.

After at least three samples spanning ten minutes, a window shows a burn-rate line: `at this pace the limit runs out at HH:MM (resets HH:MM)` when it would reach 100% used before its reset, or `safe until reset` otherwise. The wording is the same in both display modes. Samples are kept only in memory for the current reset period, so the line disappears after a reset and after a restart.

Use the refresh button on a provider card to refresh only that provider. The menu header refresh button fetches both providers and samples enabled metrics. If a fetch fails, the extension keeps the last successful values and marks the failure. The header then says `Refresh busy` when another refresh already holds the runtime lock, `Refresh timed out` when the fetch timed out, and `Refresh failed` otherwise. If there is no previous snapshot, provider values show unavailable.

Automatic provider refresh backs off after rate limiting. Each consecutive full refresh (the timer, or the header refresh button) that reports `rate_limited` doubles the interval (for example 60s, then 120s, 240s, and so on), capped at 15 minutes. A full refresh without rate limiting restores the normal interval. Manual refreshes still run during a backoff; a card refresh button refreshes one provider and does not change the backoff.

Run `superbar doctor` from a terminal to check the runtime directory and credential files; see the [CLI reference](cli.md).

## Alerts

Superbar sends GNOME notifications for:

- a provider usage window reaching 80% or 90% used (the thresholds are always judged on used; the message reads `Claude Code 5-hour: 20% left` or `80% used` to match the display setting);
- a provider usage window resetting, when it had some usage before the reset;
- disk usage reaching the disk alert threshold.

Each threshold fires once per window period. Only fresh provider data raises a usage alert, so carried-forward values never do. Disk alerts fire once when usage reaches the threshold and re-arm when usage falls below it. Disk alerts need the Disk metric to be enabled, since its samples come from the regular disk reading.

Turn notifications off with **Usage and disk alerts** in the menu's settings screen, or the **Usage and disk notifications** switch in the Alerts group of the preferences window. The disk threshold defaults to 90% used and is set in the preferences window (50–99%).

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

Metrics are read from Linux `/proc`, `/sys`, and filesystem data without launching a subprocess.

The disk tile shows a time-to-full estimate, such as `55.9 GB free · full in 3h 12m`, once recent free-space samples show space shrinking across at least ten minutes. The battery tile adds the time remaining (`Discharging · 2h 14m left`, or `to full` while charging) when the system exposes energy or charge and rate readings.

Clicking the CPU or memory tile opens a list of its top five processes, each with its name and either its share of all CPUs or its resident memory. Clicking the same tile closes the list. CPU shares need two readings, so the first one shows `sampling…`. Superbar reads at most 512 processes from `/proc` per update. Network rates sum interfaces other than loopback and common virtual interfaces. CPU and network need two readings to calculate a rate; after the first baseline reading, Superbar takes a follow-up reading about one second later. Battery or temperature may show unavailable if the expected sensors are not exposed by the system.

Values at high levels use alert coloring: 90% for usage metrics (disk uses the disk alert threshold above), 15% or below for a non-charging battery, and 85°C for temperature. Network rates have no fixed alert threshold.

## Settings and refresh intervals

The gear button opens settings inside the menu; its back button returns to usage. Closing the menu also returns to the usage screen. The GNOME Extensions preferences window exposes the same display switches and refresh intervals.

Provider usage and system metrics have independent automatic-refresh switches and intervals. Provider refresh defaults to 60 seconds and cannot be set below 60 seconds. System intervals can be set from 1 second to 1 hour. Defaults are CPU 2s, memory 5s, swap 10s, disk 30s, network 1s, battery 30s, and temperature 5s. The menu settings editor accepts seconds or minutes; the preferences window accepts seconds.

The extension imposes a 40-second timeout on a provider fetch. The CLI's provider-fetch worker has its own 35-second deadline; see the [CLI reference](cli.md).
