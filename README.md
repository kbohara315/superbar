# Superbar

Superbar is a tray-resident desktop dashboard for Codex and Claude Code usage, with optional system metrics. It is a native TSX app built with [nsh](https://github.com/longbridge/nsh).

The app has a tray icon and menu, a usage dashboard, configurable refresh and alert settings, and a local setup checker. Provider credentials are read from the signed-in user's existing Codex and Claude Code files; access tokens are sent only in provider requests and are not stored by Superbar.

## Run

Use an `nsh` build containing the `Tray` API at commit [`0e4a20b`](https://github.com/longbridge/nsh/commit/0e4a20bd41ee72a35515cecbf9a7fba88742d911), then run from this directory:

```sh
nsh check
nsh test
nsh run App.tsx
```

See [Development](docs/development.md) for the matching nsh toolchain, tests, and packaging details. See [Usage](docs/usage.md) for dashboard behavior and settings.

## Platforms

The app contains Linux, Windows, and macOS code paths. Linux is the validated desktop host. Windows Rust code has also passed a GNU cross-target check, but Windows and macOS runtime behavior still needs testing on those operating systems. Package each desktop app on its native host; in particular, `nsh package --target windows` run on Linux can produce a Linux executable named `.exe`.

## License

See [LICENSE](LICENSE).
