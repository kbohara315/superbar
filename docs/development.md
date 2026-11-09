# Development

## Toolchain

This app uses `nsh` and a native Rust crate in `native/`. The crate pins `nsh-core` and `nsh-base` to commit [`0e4a20bd41ee72a35515cecbf9a7fba88742d911`](https://github.com/longbridge/nsh/commit/0e4a20bd41ee72a35515cecbf9a7fba88742d911). Use an `nsh` build from the same commit: it contains the `Tray` API used by this app. The released `nsh 0.4.0` has the same version string but a different commit and does not provide that API.

The first Rust build needs network access to fetch the pinned nsh repository and crates.io dependencies. The generated `.nsh/` directory and Rust `target/` output are local build artifacts and are ignored by Git.

## Check and test

Run from the repository root with the matching `nsh` executable on `PATH`:

```sh
nsh check
nsh test
nsh run App.tsx
```

`nsh test` runs the app's headless TSX tests and the native crate's unit tests. The TSX tests use fakes for host APIs and do not require a display. `nsh run` starts the desktop app and needs a graphical session.

The native crate can also be checked directly:

```sh
cargo fmt --manifest-path native/Cargo.toml -- --check
cargo test --manifest-path native/Cargo.toml --locked
```

The Windows module can be type-checked from Linux with the GNU target and MinGW-w64 installed:

```sh
cargo check --manifest-path native/Cargo.toml --locked --target x86_64-pc-windows-gnu
```

This is a cross-target compile check, not a Windows runtime test. macOS and Windows tray, window, credential, and live-metric behavior must still be checked on their respective hosts.

## Package

Package on the operating system being targeted:

```sh
nsh package --target linux
nsh package --target windows
nsh package --target macos
```

The Windows and macOS package commands require their respective native hosts. In particular, this nsh version builds the Windows runner for the host target; running `nsh package --target windows` on Linux can create an ELF binary named `Superbar.exe`, which is not a Windows application.

## Project layout

- `App.tsx`: nsh desktop entry point and host API wiring.
- `src/`: provider fetching, metrics, state management, tray, and dashboard UI.
- `native/`: narrow Rust module for Windows system metrics.
- `nsh.json`: app identity and nsh capabilities. Review capability changes carefully; the native Rust module runs in-process outside the TSX capability sandbox.
- `docs/usage.md`: user-facing behavior and settings.
