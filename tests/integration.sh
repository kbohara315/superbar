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

# Lock contention is reported with its own exit status (75), not a generic failure.
flock -n "$tmp/runtime/superbar/.lock" sleep 5 &
holder=$!
sleep 0.2
set +e
"$binary" fetch --format json >"$tmp/busy.out" 2>"$tmp/busy.err"
busy_status=$?
set -e
wait "$holder" || true
if [[ "$busy_status" -ne 75 ]]; then
    echo "fetch under lock contention exited $busy_status, expected 75" >&2
    exit 1
fi

# doctor is a diagnostic: on a fresh runtime directory it reports superbar as not created yet and creates nothing.
mkdir -m 700 "$tmp/runtime-doctor"
XDG_RUNTIME_DIR="$tmp/runtime-doctor" "$binary" doctor --format json >"$tmp/doctor-fresh.out"
if [[ -e "$tmp/runtime-doctor/superbar" || -n "$(ls -A "$tmp/runtime-doctor")" ]]; then
    echo 'doctor created files in XDG_RUNTIME_DIR' >&2
    exit 1
fi
python3 - "$tmp/doctor-fresh.out" <<'PY'
import json
import pathlib
import sys

checks = {c["name"]: c for c in json.loads(pathlib.Path(sys.argv[1]).read_text())["checks"]}
assert checks["runtime_dir"]["status"] == "ok", checks
assert "does not exist yet" in checks["runtime_dir"]["detail"], checks
PY

# doctor is offline and never prints credential values. A Claude credential with a future expiry and a
# Codex JWT with a past expiry exercise both the ok and warn paths; the secret strings must not appear.
now=$(date +%s)
expires_ms=$(( (now + 1200) * 1000 ))
mkdir -m 700 "$tmp/home/.claude" "$tmp/home/.codex"
printf '{"claudeAiOauth":{"accessToken":"claude-secret-token","expiresAt":%s}}' "$expires_ms" >"$tmp/home/.claude/.credentials.json"
b64() { printf '%s' "$1" | base64 -w0 | tr '+/' '-_' | tr -d '='; }
jwt="$(b64 '{"alg":"none"}').$(b64 "{\"exp\":$((now - 300))}").sig"
printf '{"tokens":{"access_token":"%s"}}' "$jwt" >"$tmp/home/.codex/auth.json"
"$binary" doctor --format json >"$tmp/doctor.out"
if grep -q -e claude-secret-token -e "$jwt" "$tmp/doctor.out"; then
    echo 'doctor printed a credential value' >&2
    exit 1
fi
python3 - "$tmp/doctor.out" <<'PY'
import json
import pathlib
import sys

checks = {c["name"]: c for c in json.loads(pathlib.Path(sys.argv[1]).read_text())["checks"]}
assert checks["runtime_dir"]["status"] == "ok", checks
assert checks["claude_credentials"]["status"] == "ok", checks
assert "expires in 19m" in checks["claude_credentials"]["detail"] or "expires in 20m" in checks["claude_credentials"]["detail"], checks
assert checks["codex_credentials"]["status"] == "warn", checks
assert "expired" in checks["codex_credentials"]["detail"], checks
PY
"$binary" doctor >"$tmp/doctor.txt"
grep -q '^\[ok\] runtime_dir:' "$tmp/doctor.txt"
# A credential file that exists but is not JSON is a failed check, so doctor exits 1 in both formats.
printf 'not json' >"$tmp/home/.claude/.credentials.json"
if "$binary" doctor >/dev/null 2>&1; then
    echo 'doctor exited 0 with a failed check' >&2
    exit 1
fi
if "$binary" doctor --format json >/dev/null 2>&1; then
    echo 'doctor --format json exited 0 with a failed check' >&2
    exit 1
fi
printf '{"claudeAiOauth":{"accessToken":"claude-secret-token","expiresAt":%s}}' "$expires_ms" >"$tmp/home/.claude/.credentials.json"

if "$binary" doctor --format yaml >/dev/null 2>&1; then
    echo 'doctor accepted an unknown format' >&2
    exit 1
fi

# status --line is the one-line form for status bars; both providers are unavailable in this snapshot.
"$binary" status --line >"$tmp/line.out"
[[ "$(cat "$tmp/line.out")" == 'cx — · cl —' ]] || { echo "unexpected status line: $(cat "$tmp/line.out")" >&2; exit 1; }

# With real values the default is remaining; --show used gives the used percentages, labelled by window length.
python3 - "$tmp/runtime/superbar/snapshot.json" <<'PY'
import json
import os
import sys

snapshot = {
    "schema_version": 1,
    "generated_at": "2026-11-06T10:00:00Z",
    "providers": {
        "codex": {"state": "fresh", "last_success_at": "2026-11-06T10:00:00Z", "error": None,
                  "windows": {"primary": {"label": "Session", "used_percent": 42.0, "reset_at": None, "duration_seconds": 18000},
                              "secondary": None}},
        "claude": {"state": "fresh", "last_success_at": "2026-11-06T10:00:00Z", "error": None,
                   "windows": {"primary": {"label": "5-hour", "used_percent": 71.0, "reset_at": None, "duration_seconds": 18000},
                               "secondary": None}},
    },
}
path = sys.argv[1]
fd = os.open(path, os.O_WRONLY | os.O_TRUNC | os.O_CREAT, 0o600)
with os.fdopen(fd, "w") as f:
    json.dump(snapshot, f)
os.chmod(path, 0o600)
PY
[[ "$("$binary" status --line)" == 'cx 58% left 5h · cl 29% left 5h' ]] || { echo "unexpected default line: $("$binary" status --line)" >&2; exit 1; }
[[ "$("$binary" status --line --show remaining)" == 'cx 58% left 5h · cl 29% left 5h' ]] || { echo 'explicit remaining line differs' >&2; exit 1; }
[[ "$("$binary" status --line --show used)" == 'cx 42% 5h · cl 71% 5h' ]] || { echo "unexpected used line: $("$binary" status --line --show used)" >&2; exit 1; }
if "$binary" status --show used >/dev/null 2>&1; then
    echo '--show without --line was accepted' >&2
    exit 1
fi
if "$binary" status --line --show bogus >/dev/null 2>&1; then
    echo '--show bogus was accepted' >&2
    exit 1
fi

echo 'isolated CLI integration tests passed'
