# Development

## Requirements and build

Use Zig 0.17.0 or later. The build defaults to size optimization and strips debug information.

```sh
zig build
zig build test
```

`zig build test` runs Zig unit tests and the isolated CLI integration test. It does not contact real provider endpoints. Extension tests are standalone Node.js scripts:

```sh
node extension/tests/model.test.js
node extension/tests/indicator.test.js
```

Current Node.js releases detect ES module syntax automatically. Older Node.js versions need `node --experimental-default-type=module` instead.

The extension tests use Node mocks for GNOME Shell objects; they do not run inside GNOME Shell.

Build variants can be selected with Zig's `-Doptimize` option:

```sh
zig build -Doptimize=debug
zig build -Doptimize=safe -Dstrip=false
zig build -Doptimize=fast
```

Debug builds are unoptimized. Safe builds retain safety checks; `-Dstrip=false` preserves debug information. Fast builds prioritize runtime speed.

## Install and runtime validation

Build before running the installer:

```sh
scripts/install.sh
```

The installer places the CLI at `~/.local/bin/superbar` and the extension at `~/.local/share/gnome-shell/extensions/superbar@kbohara315.github.io`. It records managed file hashes in an install manifest and refuses to overwrite unknown or modified files. Enable Superbar in the GNOME Extensions app. Uninstall with `scripts/uninstall.sh`; it removes only files verified against the manifest.

Automated tests cover the CLI and extension behavior through mocks. The installer and uninstaller do not currently have automated tests. A passing mock test is not a substitute for validating the extension in a live GNOME Shell 50 Wayland session. If GNOME does not discover a newly installed extension, sign out and back in after saving your work. Do not restart GNOME Shell on Wayland as a workaround.

## Project layout

- `src/`: Zig CLI, provider fetching, and runtime snapshot storage.
- `extension/`: GNOME Shell extension, preferences, settings schema, and tests.
- `scripts/`: per-user installer and uninstaller.
- `tests/`: isolated CLI integration test.
