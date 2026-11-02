# Superbar

Superbar is a GNOME top-bar dashboard for Codex and Claude Code usage, with optional Linux system metrics. It includes a GNOME Shell extension and a Zig CLI that fetches provider usage and reads the cached snapshot.

The target is GNOME Shell 50 on Wayland. Provider data comes from upstream usage endpoints that may change and are not guaranteed stable public APIs.

## Install

Requires Zig 0.17.0 and GNOME Shell 50.

```sh
zig build
scripts/install.sh
```

Enable **Superbar** in the GNOME Extensions app. If it does not appear after installation, sign out and back in; save your work first. To uninstall:

```sh
scripts/uninstall.sh
```

The installer and uninstaller manage per-user files under `~/.local` and refuse to overwrite or remove files they cannot verify as managed by Superbar.

## Development

```sh
zig build
zig build test
```

See [Development](docs/development.md) for test coverage and build options. For user-facing behavior, see [Usage](docs/usage.md); for CLI commands and data handling, see [CLI reference](docs/cli.md).
