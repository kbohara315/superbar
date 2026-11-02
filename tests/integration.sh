#!/usr/bin/env bash
set -euo pipefail

binary=${1:?usage: integration.sh PATH_TO_SUPERBAR}
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
mkdir -m 700 "$tmp/home" "$tmp/runtime"

export HOME="$tmp/home"
export XDG_RUNTIME_DIR="$tmp/runtime"
unset CODEX_HOME OPENAI_API_KEY ANTHROPIC_API_KEY

# status must fail cleanly when there is no snapshot, without touching real data.
if "$binary" status --format json >"$tmp/status.out" 2>"$tmp/status.err"; then
    echo 'status unexpectedly succeeded without a snapshot' >&2
    exit 1
fi

# With both credential files absent, fetch writes only safe failure metadata and
# must not issue requests to either provider.
"$binary" fetch --format json >"$tmp/fetch.out"
python3 - "$tmp/fetch.out" "$tmp/runtime/superbar/snapshot.json" <<'PY'
import json
import pathlib
import sys

output = json.loads(pathlib.Path(sys.argv[1]).read_text())
saved = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert output == saved
assert output["schema_version"] == 1
for name in ("codex", "claude"):
    provider = output["providers"][name]
    assert provider["state"] == "unavailable"
    assert provider["error"]["code"] == "credentials_unavailable"
    assert provider["windows"] == {"primary": None, "secondary": None}
PY

# Read-back succeeds and remains an offline operation.
"$binary" status --format json >"$tmp/status.out"
python3 - "$tmp/status.out" <<'PY'
import json
import pathlib
import sys

status = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert status["providers"]["codex"]["error"]["code"] == "credentials_unavailable"
assert status["providers"]["claude"]["error"]["code"] == "credentials_unavailable"
PY

echo 'isolated CLI integration tests passed'
