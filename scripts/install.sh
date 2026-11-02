#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
UUID='superbar@kbohara315.github.io'
BIN_DIR="${HOME}/.local/bin"
SHARE_DIR="${HOME}/.local/share"
EXT_DIR="${SHARE_DIR}/gnome-shell/extensions/${UUID}"
BIN="${BIN_DIR}/superbar"
MARKER="${SHARE_DIR}/superbar/install-manifest"
# The project was previously installed as "usage-bar"; a renamed extension
# cannot upgrade that installation in place.
LEGACY_MARKER="${SHARE_DIR}/usage-bar/install-manifest"
LEGACY_EXT_PATTERN="${SHARE_DIR}/gnome-shell/extensions/usage-bar@*"
BIN_SOURCE="${ROOT}/zig-out/bin/superbar"
EXT_SOURCE="${ROOT}/extension"
SCHEMA='org.gnome.shell.extensions.superbar.gschema.xml'

# Managed files as "<path relative to the extension dir>"; the binary is separate.
EXT_FILES=(extension.js metadata.json model.js prefs.js icons/ProviderIcon-codex.svg icons/ProviderIcon-claude.svg "schemas/${SCHEMA}" schemas/gschemas.compiled)
EXT_SUBDIRS=(icons schemas)

die() { printf 'superbar install: %s\n' "$*" >&2; exit 1; }
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
exists_or_link() { [[ -e "$1" || -L "$1" ]]; }

# Refuse to install beside the older name, which would leave two extensions and
# two binaries behind.
if exists_or_link "$LEGACY_MARKER" || compgen -G "$LEGACY_EXT_PATTERN" >/dev/null; then
    die 'an older usage-bar installation is present; remove it with the previous version of scripts/uninstall.sh, then re-run this installer'
fi

[[ -x "$BIN_SOURCE" ]] || die "missing executable $BIN_SOURCE; build superbar first"
for rel in "${EXT_FILES[@]}"; do
    [[ -f "$EXT_SOURCE/$rel" && ! -L "$EXT_SOURCE/$rel" ]] || die "source is not a regular file: $EXT_SOURCE/$rel"
done

FILES=("$BIN")
for rel in "${EXT_FILES[@]}"; do FILES+=("$EXT_DIR/$rel"); done

upgrading=false
if exists_or_link "$MARKER"; then
    upgrading=true
    [[ -f "$MARKER" && ! -L "$MARKER" ]] || die 'install manifest is not a regular file'
    mapfile -t rows < "$MARKER"
    [[ ${#rows[@]} -eq ${#FILES[@]} ]] || die 'invalid manifest; inspect the installation manually'
    # Validate every tracked path and hash before touching anything.
    for i in "${!FILES[@]}"; do
        expected_path=${rows[$i]#* }
        expected_hash=${rows[$i]%% *}
        f=${FILES[$i]}
        [[ "$expected_path" == "$f" && "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || die 'invalid manifest; inspect the installation manually'
        exists_or_link "$f" || die "managed file is missing: $f"
        [[ -f "$f" && ! -L "$f" ]] || die "managed path is not a regular file: $f"
        [[ "$(hash_file "$f")" == "$expected_hash" ]] || die "managed file was modified; refusing upgrade: $f"
    done
    [[ -d "$EXT_DIR" && ! -L "$EXT_DIR" ]] || die 'extension directory is missing or unsafe'
    # Nothing but the managed files and their directories may be present.
    while IFS= read -r -d '' p; do
        [[ -L "$p" ]] && die "unexpected symlink: $p"
        if [[ -d "$p" ]]; then
            known=false
            for d in "${EXT_SUBDIRS[@]}"; do [[ "$p" == "$EXT_DIR/$d" ]] && known=true; done
            $known || die "unknown extension content: $p"
        else
            known=false
            for f in "${FILES[@]}"; do [[ "$p" == "$f" ]] && known=true; done
            $known || die "unknown extension content: $p"
        fi
    done < <(find "$EXT_DIR" -mindepth 1 -print0)
else
    for f in "${FILES[@]}" "$EXT_DIR" "$MARKER"; do
        exists_or_link "$f" && die "destination already exists; refusing to overwrite: $f"
    done
fi

mkdir -p -- "$BIN_DIR" "$SHARE_DIR/gnome-shell/extensions" "$SHARE_DIR/superbar"
tmp="$(mktemp -d "$SHARE_DIR/.superbar-install.XXXXXX")"
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT

install -m 0755 -- "$BIN_SOURCE" "$tmp/superbar"
for d in "${EXT_SUBDIRS[@]}"; do mkdir -- "$tmp/$d"; done
for rel in "${EXT_FILES[@]}"; do install -m 0644 -- "$EXT_SOURCE/$rel" "$tmp/$rel"; done
{
    printf '%s %s\n' "$(hash_file "$tmp/superbar")" "$BIN"
    for rel in "${EXT_FILES[@]}"; do printf '%s %s\n' "$(hash_file "$tmp/$rel")" "$EXT_DIR/$rel"; done
} > "$tmp/install-manifest"

if $upgrading; then
    mv -fT -- "$tmp/superbar" "$BIN"
    for rel in "${EXT_FILES[@]}"; do mv -fT -- "$tmp/$rel" "$EXT_DIR/$rel"; done
    mv -fT -- "$tmp/install-manifest" "$MARKER"
else
    mkdir -- "$EXT_DIR"
    for d in "${EXT_SUBDIRS[@]}"; do mkdir -- "$EXT_DIR/$d"; done
    mv -- "$tmp/superbar" "$BIN"
    for rel in "${EXT_FILES[@]}"; do mv -- "$tmp/$rel" "$EXT_DIR/$rel"; done
    mv -- "$tmp/install-manifest" "$MARKER"
fi
trap - EXIT
cleanup
printf 'Installed superbar for this user. Enable %s manually from GNOME Extensions when ready.\n' "$UUID"
