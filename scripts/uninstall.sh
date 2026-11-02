#!/usr/bin/env bash
set -euo pipefail

UUID='superbar@kbohara315.github.io'
SHARE_DIR="${HOME}/.local/share"
EXT_DIR="${SHARE_DIR}/gnome-shell/extensions/${UUID}"
BIN="${HOME}/.local/bin/superbar"
MARKER="${SHARE_DIR}/superbar/install-manifest"
SCHEMA='org.gnome.shell.extensions.superbar.gschema.xml'

EXT_FILES=(extension.js metadata.json model.js prefs.js icons/ProviderIcon-codex.svg icons/ProviderIcon-claude.svg "schemas/${SCHEMA}" schemas/gschemas.compiled)
EXT_SUBDIRS=(icons schemas)

die() { printf 'superbar uninstall: %s\n' "$*" >&2; exit 1; }
hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
exists_or_link() { [[ -e "$1" || -L "$1" ]]; }

FILES=("$BIN")
for rel in "${EXT_FILES[@]}"; do FILES+=("$EXT_DIR/$rel"); done

exists_or_link "$MARKER" || die 'installation manifest not found; nothing removed'
[[ -f "$MARKER" && ! -L "$MARKER" ]] || die 'manifest is not a regular file; nothing removed'
mapfile -t rows < "$MARKER"
[[ ${#rows[@]} -eq ${#FILES[@]} ]] || die 'invalid manifest; nothing removed'
for i in "${!FILES[@]}"; do
    expected_hash=${rows[$i]%% *}
    expected_path=${rows[$i]#* }
    f=${FILES[$i]}
    [[ "$expected_path" == "$f" && "$expected_hash" =~ ^[a-f0-9]{64}$ ]] || die 'invalid manifest; nothing removed'
    exists_or_link "$f" || die "managed file is missing: $f; nothing removed"
    [[ -f "$f" && ! -L "$f" ]] || die "managed path is not a regular file: $f; nothing removed"
    [[ "$(hash_file "$f")" == "$expected_hash" ]] || die "managed file was modified: $f; nothing removed"
done
[[ -d "$EXT_DIR" && ! -L "$EXT_DIR" ]] || die 'extension directory is missing or unsafe; nothing removed'
# Nothing but the managed files and their directories may be present.
while IFS= read -r -d '' p; do
    [[ -L "$p" ]] && die "unexpected symlink $p; nothing removed"
    known=false
    if [[ -d "$p" ]]; then
        for d in "${EXT_SUBDIRS[@]}"; do [[ "$p" == "$EXT_DIR/$d" ]] && known=true; done
    else
        for f in "${FILES[@]}"; do [[ "$p" == "$f" ]] && known=true; done
    fi
    $known || die "unknown extension content $p; nothing removed"
done < <(find "$EXT_DIR" -mindepth 1 -print0)

# All validation happens before the first deletion, so modified/unknown content is
# never partly removed. The paths removed below are exactly those in the manifest.
rm -- "${FILES[@]}"
for d in "${EXT_SUBDIRS[@]}"; do rmdir -- "$EXT_DIR/$d"; done
rmdir -- "$EXT_DIR"
rm -- "$MARKER"
rmdir -- "$(dirname -- "$MARKER")" 2>/dev/null || true
printf 'Removed the verified per-user superbar installation.\n'
