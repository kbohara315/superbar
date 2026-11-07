# Superbar on nsh: working notes

Replacement for the GNOME extension (../extension) and Zig CLI (../src), written in TSX on nsh.
Those stay untouched; this app lives alongside them. Source of truth for behaviour: ../docs/usage.md and ../docs/cli.md.

## Toolchain (already installed)
- `export PATH=$HOME/.nsh/source/target/release:$PATH` (nsh 0.4.0 built from main, has `Tray` in `nsh/desktop`; the released 0.4.0 does NOT).
- Tests (headless, no display): `nsh test`  | typecheck: `nsh check` | run: `nsh run App.tsx` (needs the desktop session).
- Docs of record: ~/.nsh/source/website/docs/*.md and website/modules/*.md (nsh-desktop.md, standard-modules.md, globals.md).

## Platform facts
- Capabilities live in nsh.json. Allowed keys: network, webview, statusBar, clipboard, picker, speech, openUrl, process, fs, host. `notifications: true` IS a valid capability key on nsh main (it was rejected by the released 0.4.0); it is required for alerts.
- fs roots: `${homeDir}`, `${dataDir}`. Read: ~/.codex, ~/.claude, /proc, /sys. Write: ${dataDir}.
- `Notifications` is imported from "nsh" (requestPermission(), show({id,title,body})).
- Tray: `Tray.set({icon, tooltip, menu, onClick})` from "nsh/desktop"; TSX only; follows signals inside an effect. Icon is an SVG/image src. This GNOME has the AppIndicator extension.
- Second window: `Window.open(Component, {id,title,size,frame})` (Linux/Windows). Returned window has focus()/hide()/close().
- `fetch`, `fs/promises`, `process` (run/spawn/env/platform) behave like Node/WHATWG; see standard-modules.md.
- Shared types: src/types.ts (do not change without the coordinator).

## Lifecycle and asset facts (from T4)
- The app is tray-resident. Linux has no API to hide the main window completely: it is minimized at startup (can reappear via Alt+Tab). The dashboard is `Window.open(..., {id:"dashboard"})`; nsh has no close interception, so closing destroys it and the next open starts on the usage screen. Hide-on-tray-click uses `hide()`.
- SVG/asset imports must sit under the entry's directory (`../` imports 404 in the dev server): use `src/ui/assets/` imported from `App.tsx`.
- The tray icon is a square 24x24 gauge per provider (panel icons can't carry text), with three shapes so the state reads without colour: a ring with its amount as the arc; a solid filled DISC in the alert red when either window is at 90% used (the only filled shape); a solid grey RING when there is no 5-hour value (never dimmed). The glanceable text is in the MENU: its first lines are disabled (pill line with window and ` wk!` / ` !` / `(stale)`, metrics line, status line). On GNOME the AppIndicator extension does not show the SNI tooltip, and a click opens the menu; the tooltip carries the same strings for panels that do show it.
- Tray updates: the tray is re-sent only when its icon, tooltip or menu content changed (installTray compares the payload).
- Tray Title: nsh's Tray takes no title and the Linux dev host hard-codes `"nsh"` (`nsh-linux-host/src/lib.rs`); `nsh run --name` is rejected on Linux. A packaged build takes its title from `nsh.json`'s name (`nsh-linux-app` reads `app.json`). So a dev run's tray Title stays `nsh`.
- Tray clicks: nsh's `AppWindow` reports neither focus nor visibility, so a tray click always raises the dashboard; hiding is the menu's "Hide dashboard". The controller's schedule runs on `performance.now()` (monotonic); wall-clock is for display only.
- Capabilities (nsh.json): fs read ${homeDir}/.codex, ${homeDir}/.claude, /proc, /sys, ${dataDir}; write ${dataDir}; process.execute chmod, df; process.env CODEX_HOME; network chatgpt.com, api.anthropic.com.
- Known limits: CODEX_HOME only works inside ~/.codex (fs roots are static). Headless `nsh test` denies native fs/process (use injected fakes; real-host checks need `nsh run` or `nsh test --target linux`).
- Screenshots via the XDG portal write ~/Pictures/Screenshot.png: check it does not already exist before taking one.
- Async work (controller.ts ASYNC AUDIT): every external call goes through `bounded(token, task, ms)` (never invoked for a stale generation; timeout and stop() settle it); queued metric/process-list runs check their gate before each invocation; all timers are token-guarded and cancelled by stop(). Settings are written by the store's queue (see below), not by the controller's generation: a stop never cancels a write, and the store's queue outlives stop()/start().

## Settings file (store.ts)
- One file: `${dataDir}/settings.json`. A save writes `settings.json.<id>.tmp`, chmods it 0600 and checks it, then renames it over settings.json. The folder is 0700 (made so on save, required on read; POSIX only, windows skips the modes).
- Ordering: every read and write of the folder goes through one serial queue at module level. A write is issued only after the previous underlying write has settled. Writes waiting in the queue are coalesced (only the newest is written next). A read waits behind the writes requested before it.
- A write that never settles holds the queue. The controller then shows "Not saved: the settings write is still running..." after SAVE_TIMEOUT_MS, without issuing a second write; the note clears when the newest save lands.
- One way in (controller.ts applySettings): every change of the settings, a user's edit, the first load and a late read, is published by `applySettings(next)`, which runs the runtime transitions (provider timer, alert permission, each metric's sampler and timer, system refresh) by diffing previous and next, and then applies the persistence rule. There is no second path. Only a started generation runs transitions.
- Re-entrancy (controller.ts applySettings): applications run one at a time. A change requested while one runs (a transition's callback changing the settings, such as a sampler's read or a permission answer) is queued as `pendingApply` and applied next; the save reads the current settings, and a superseded application does not save. Each transition step checks that its generation is still running, so a stop inside a callback runs no further sampler, timer or permission work.
- Queue bookkeeping (store.ts): edits queued behind a waiting write share its one completion promise, so the controller watches each save promise once and holds one stall timer per write, however many edits arrive.
- Persistence rule (saveIfNotOnDisk): once a read has settled (`baseKnown`), the applied settings are written whenever they differ from `lastWritten`, the text the disk is believed to hold (handed to the store, or said by the last read). A no-op reconcile writes nothing. A failed save clears `lastWritten`, so the next change or read writes again. Before a read settles nothing is written.
- Reconciliation (applyRead): the read's answer is the base (for a missing, damaged or untrusted file, the defaults); the overlay of changes made since the read was requested is laid over it. If a write was handed out after the read was requested, the queue runs it after the read, so the disk ends with that text and no second write is made. A read that is superseded, or whose generation was stopped, changes nothing; the next start reads again.
- Limit: a known failed save is not kept across a restart: the file is the truth, and the read reverts the displayed value to it (the file's value is shown and saved, not the failed one).
- Notes: the loading note (`Settings are still loading from disk…`) is shown while a read is pending and clears when it settles; the unusable-file note clears when a save lands; the write note clears when the newest save lands.
- Reads never follow symlinks and never throw: a symlink, a directory, a group/other-readable file, a file over 64 KiB, or a folder that is not 0700 is `untrusted` and gives the defaults with a note. Damaged JSON gives the defaults with a note. A missing file gives the defaults with no note.
- Temp files: on read, `settings.json.<hex-and-dashes>.tmp` regular files older than 10 minutes are removed. Only names matching that pattern exactly, and only as listed in the folder.
- Interim `settings.<digits>.json` files from earlier builds are not read, migrated or removed. The legacy `settings.json` is the file itself.
- Limitation (documented, not solved): one Superbar instance is expected. Two instances writing the same folder: the last writer wins, and every write is an atomic rename, so the file is always one whole valid version.
- The `version: 1` field in settings.json is the settings schema marker, not a save number.
