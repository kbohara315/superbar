export function isSnapshot(data) {
    if (!data || typeof data !== 'object' || data.schema_version !== 1 ||
        !data.providers || typeof data.providers !== 'object')
        return false;

    for (const name of ['codex', 'claude']) {
        const provider = data.providers[name];
        if (!provider || typeof provider !== 'object' ||
            !['fresh', 'stale', 'unavailable'].includes(provider.state))
            return false;
        if (!provider.windows || typeof provider.windows !== 'object')
            return false;
        for (const key of ['primary', 'secondary']) {
            const window = provider.windows[key];
            if (window !== null && window !== undefined &&
                (!Number.isFinite(window.used_percent) || window.used_percent < 0 || window.used_percent > 100))
                return false;
        }
    }
    return true;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const HIGH_USAGE_PERCENT = 90;

// A window whose reset time has passed describes a period that already ended, so its percentage is unknown.
export function windowExpired(window, nowMs) {
    const epoch = typeof window?.reset_at === 'string' ? Date.parse(window.reset_at) : NaN;
    return Number.isFinite(epoch) && epoch <= nowMs;
}

export function usedPercent(window, nowMs = Date.now()) {
    if (!window || !Number.isFinite(window.used_percent) || windowExpired(window, nowMs)) return null;
    return Math.round(window.used_percent);
}

// The highest usable percentage of the primary and secondary windows. The pill shows this value and
// takes its colour from it, so the text and colour can never disagree.
export function peakPercent(provider, nowMs = Date.now()) {
    const values = [provider?.windows?.primary, provider?.windows?.secondary]
        .map(window => usedPercent(window, nowMs)).filter(value => value !== null);
    return values.length ? Math.max(...values) : null;
}

// Display modes for provider usage. Stored usage is always "used"; `remaining` is its complement.
// Colour and alert decisions always use used percent, so red means the same thing in both modes.
export const USAGE_DISPLAY_MODES = ['remaining', 'used'];

// The percentage to show for a used value (an integer, as from usedPercent). Remaining is 100 minus used,
// clamped to 0..100. Null in means null out, which the callers render as an em dash.
export function displayPercent(used, mode = 'remaining') {
    if (!Number.isFinite(used)) return null;
    const clamped = Math.min(100, Math.max(0, Math.round(used)));
    return mode === 'used' ? clamped : 100 - clamped;
}

// Text for a used percentage in the given mode, e.g. `20% left` or `80% used`.
export function percentLabel(used, mode = 'remaining') {
    return mode === 'used' ? `${displayPercent(used, 'used')}% used` : `${displayPercent(used, 'remaining')}% left`;
}

// The pill shows the primary (5-hour) window only, in the display mode. It never falls back to the weekly window.
// When the weekly window is at or above the high line while the 5-hour one is not, the pill appends `wk!` so a red
// pill with a healthy 5-hour number is explained.
export function pillText(provider, nowMs = Date.now(), mode = 'remaining') {
    const primary = usedPercent(provider?.windows?.primary, nowMs);
    const shown = displayPercent(primary, mode);
    const text = shown === null ? '—' : `${shown}%`;
    const weeklyHigh = usageLevel(usedPercent(provider?.windows?.secondary, nowMs)) === 'high';
    const primaryHigh = usageLevel(primary) === 'high';
    return weeklyHigh && !primaryHigh ? `${text} wk!` : text;
}

// The pill is red when either usable window is at or above the high line (90% used).
export function pillHigh(provider, nowMs = Date.now()) {
    return [provider?.windows?.primary, provider?.windows?.secondary]
        .some(window => usageLevel(usedPercent(window, nowMs)) === 'high');
}

// Text for one usage row. An expired window reads as a reset with unknown usage, never as its old percentage.
export function windowUsageText(window, nowMs = Date.now(), mode = 'remaining') {
    if (windowExpired(window, nowMs)) return 'reset · usage unknown';
    const value = usedPercent(window, nowMs);
    return value === null ? 'unavailable' : percentLabel(value, mode);
}

export function usageLevel(percent) {
    if (percent === null) return 'unknown';
    return percent >= HIGH_USAGE_PERCENT ? 'high' : 'ok';
}

export function resetCountdown(resetAt, nowMs) {
    const epoch = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
    if (!resetAt) return 'reset time unavailable';
    if (!Number.isFinite(epoch)) return 'reset scheduled';
    const delta = Math.floor((epoch - nowMs) / 1000);
    if (delta <= 0) return 'resetting now';
    const days = Math.floor(delta / 86400);
    const hours = Math.floor((delta % 86400) / 3600);
    const minutes = Math.floor((delta % 3600) / 60);
    if (days > 0) return `resets in ${days}d ${hours}h`;
    if (hours > 0) return `resets in ${hours}h ${minutes}m`;
    return `resets in ${minutes}m`;
}

function clock(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Local wall-clock time of a reset; the weekday is added when it is not today.
export function resetClock(resetAt, nowMs) {
    const epoch = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
    if (!Number.isFinite(epoch)) return '';
    const date = new Date(epoch);
    const now = new Date(nowMs);
    const today = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();
    return today ? clock(date) : `${WEEKDAYS[date.getDay()]} ${clock(date)}`;
}

export function syncedText(provider) {
    const epoch = typeof provider?.last_success_at === 'string' ? Date.parse(provider.last_success_at) : NaN;
    return Number.isFinite(epoch) ? `Synced ${clock(new Date(epoch))}` : 'Not synced yet';
}

export function stateText(provider) {
    return provider?.state === 'fresh' ? 'Live' : provider?.state === 'stale' ? 'Stale' : 'Offline';
}

// Fix hints for the CLI's safe error codes. The code is shown with the hint so a report can name it.
const ERROR_HINTS = {
    authentication_required: cli => `Run \`${cli}\` to sign in again`,
    credentials_missing: cli => `Sign in with \`${cli}\` to share usage`,
    credentials_unavailable: cli => `Check that ${cli} credentials are readable`,
    credentials_invalid: cli => `Credential file is damaged; sign in with \`${cli}\` again`,
    access_denied: () => 'Provider denied access; check the account plan',
    rate_limited: () => 'Rate limited; retrying with backoff',
    response_invalid: () => 'Provider API may have changed',
    response_too_large: () => 'Provider API may have changed',
    timeout: () => 'Provider timed out; will retry',
    network_error: () => 'Check the network connection',
    provider_server_error: () => 'Provider is temporarily unavailable',
    http_error: () => 'Provider returned an unexpected response',
    snapshot_missing: () => 'No data yet; refresh to fetch usage',
    not_fetched: () => 'No data yet; refresh to fetch usage',
};

// Returns `{ code, hint }` for the provider's saved error, or null when it has none.
export function errorReason(provider, name) {
    const code = provider?.error?.code;
    if (typeof code !== 'string') return null;
    const cli = name === 'codex' ? 'codex' : 'claude';
    const hint = ERROR_HINTS[code]?.(cli) ?? 'Provider error; refresh to try again';
    return { code, hint };
}

// Header text after a refresh that did not produce a snapshot.
// `lock_busy` is the CLI's exit status 75 (another refresh holds the runtime lock).
export function refreshFailureText(kind) {
    switch (kind) {
    case 'lock_busy': return 'Refresh busy';
    case 'timeout': return 'Refresh timed out';
    default: return 'Refresh failed';
    }
}

// Short countdown used for token expiry: `20m`, `2h 14m`, `3d 4h`, or `under 1m`.
export function compactDuration(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m`;
    return 'under 1m';
}

// Card text for the access token. `liveExpiresAt` is the expiry read from the credential file right now; when it is
// null, the snapshot's saved expiry is used. An expired token is normal (the CLI renews it on next use), so only a
// failed authentication in the last refresh gets a strong message.
export function tokenExpiryText(provider, nowMs = Date.now(), liveExpiresAt = null) {
    const iso = liveExpiresAt ?? provider?.expires_at;
    const epoch = typeof iso === 'string' ? Date.parse(iso) : NaN;
    if (!Number.isFinite(epoch)) return null;
    const delta = Math.floor((epoch - nowMs) / 1000);
    if (delta > 0) return `token expires in ${compactDuration(delta)}`;
    return provider?.error?.code === 'authentication_required' ? 'token expired · sign in again' : 'token renews on next use';
}

// Base64url (RFC 4648 section 5, unpadded or padded) to a byte string. Null when the input is not base64.
function base64UrlDecode(text) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let bits = 0;
    let value = 0;
    let out = '';
    for (const ch of text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) {
        const index = alphabet.indexOf(ch);
        if (index < 0) return null;
        value = ((value << 6) | index) & 0xffffff;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += String.fromCharCode((value >> bits) & 0xff);
        }
    }
    return out;
}

// Expiry of the access token in the credential file's text, as an ISO timestamp, or null. Claude stores
// claudeAiOauth.expiresAt in milliseconds; a Codex access token is a JWT whose payload `exp` claim is read.
// Only the expiry leaves this function; the token is decoded for its claims and not returned or stored.
export function credentialExpiryIso(text, codex) {
    let root;
    try {
        root = JSON.parse(text);
    } catch (_) {
        return null;
    }
    let ms;
    if (codex) {
        const token = root?.tokens?.access_token;
        const payload = typeof token === 'string' ? token.split('.')[1] : undefined;
        const decoded = payload === undefined ? null : base64UrlDecode(payload);
        let claims = null;
        try {
            claims = decoded === null ? null : JSON.parse(decoded);
        } catch (_) {
            claims = null;
        }
        if (!Number.isFinite(claims?.exp)) return null;
        ms = claims.exp * 1000;
    } else {
        ms = root?.claudeAiOauth?.expiresAt;
        if (!Number.isFinite(ms)) return null;
    }
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Automatic provider refresh backs off after consecutive rate-limited refreshes: each one doubles the base
// interval, capped at 15 minutes (a longer base interval is kept as is).
export const RATE_LIMIT_BACKOFF_CAP_SECONDS = 15 * 60;
export function providerBackoffSeconds(baseSeconds, streak) {
    if (!(streak > 0)) return baseSeconds;
    return Math.max(baseSeconds, Math.min(RATE_LIMIT_BACKOFF_CAP_SECONDS, baseSeconds * 2 ** streak));
}

// Counts consecutive refreshes in which any provider reported rate limiting; a refresh without it resets the count.
export function nextRateLimitStreak(streak, snapshot) {
    const limited = ['codex', 'claude'].some(name => snapshot?.providers?.[name]?.error?.code === 'rate_limited');
    return limited ? streak + 1 : 0;
}

export const ALERT_THRESHOLDS = [80, 90];

// Threshold and reset notifications for one window. `memo[key]` remembers the reset time the window was last
// seen under, so each threshold fires once per window period; a new reset time starts a new period.
// Returns the messages to show; expired or unknown usage never alerts.
export function windowAlerts(memo, key, label, window, nowMs = Date.now(), mode = 'remaining') {
    const messages = [];
    const resetAt = typeof window?.reset_at === 'string' ? window.reset_at : null;
    const previous = memo[key];
    if (previous?.resetAt && previous.resetAt !== resetAt && previous.percent >= 1 &&
        windowExpired({ reset_at: previous.resetAt }, nowMs)) messages.push(`${label} window reset`);
    const percent = usedPercent(window, nowMs);
    const sameWindow = previous !== undefined && previous.resetAt === resetAt;
    const levels = sameWindow ? previous.levels : [];
    const crossed = percent === null ? [] : ALERT_THRESHOLDS.filter(level => percent >= level && !levels.includes(level));
    // Thresholds are judged on used percent; only the wording follows the display mode.
    if (crossed.length) messages.push(`${label}: ${percentLabel(percent, mode)}`);
    memo[key] = { resetAt, percent: percent ?? (sameWindow ? previous.percent : null), levels: [...levels, ...crossed] };
    return messages;
}

// Disk alert state is `{ alerted }`. It fires once when usage reaches the threshold and re-arms below it.
export function diskAlertMessage(state, usedPct, threshold, etaText) {
    if (usedPct < threshold) {
        state.alerted = false;
        return null;
    }
    if (state.alerted) return null;
    state.alerted = true;
    return `Disk ${usedPct}% used${etaText ? ` · ${etaText}` : ''}`;
}

// Burn-rate projection from in-memory samples `[{ t, percent, resetAt }]` for one window. It needs at least three
// samples spanning ten minutes. Samples from before a reset (a different resetAt, or a fall in usage) are ignored.
export const PACE_MIN_SAMPLES = 3;
export const PACE_MIN_SPAN_MS = 10 * 60_000;
const PACE_DROP_TOLERANCE = 1;

// Least-squares slope of `[t_ms, value]` points, in value per second.
function slopePerSecond(points) {
    const meanT = points.reduce((sum, [t]) => sum + t, 0) / points.length;
    const meanV = points.reduce((sum, [, v]) => sum + v, 0) / points.length;
    let numerator = 0;
    let denominator = 0;
    for (const [t, v] of points) {
        numerator += (t - meanT) * (v - meanV);
        denominator += (t - meanT) ** 2;
    }
    return denominator === 0 ? 0 : numerator / denominator * 1000;
}

// Returns `{ safe, reachesAt, resetMs }`, or null when there is not enough history for this reset period.
export function paceProjection(samples, resetAt) {
    const resetMs = typeof resetAt === 'string' ? Date.parse(resetAt) : NaN;
    if (!Number.isFinite(resetMs)) return null;
    let period = [];
    for (const sample of samples ?? []) {
        if (sample.resetAt !== resetAt) continue;
        const previous = period.at(-1);
        if (previous && sample.percent < previous.percent - PACE_DROP_TOLERANCE) period = [];
        period.push(sample);
    }
    if (period.length < PACE_MIN_SAMPLES) return null;
    const last = period.at(-1);
    if (last.t - period[0].t < PACE_MIN_SPAN_MS) return null;
    const slope = slopePerSecond(period.map(sample => [sample.t, sample.percent]));
    if (slope <= 0) return { safe: true, reachesAt: null, resetMs };
    const reachesAt = last.t + (100 - last.percent) / slope * 1000;
    return reachesAt >= resetMs ? { safe: true, reachesAt: null, resetMs } : { safe: false, reachesAt, resetMs };
}

export function paceText(projection) {
    if (!projection) return '';
    if (projection.safe) return 'safe until reset';
    return `at this pace the limit runs out at ${clock(new Date(projection.reachesAt))} (resets ${clock(new Date(projection.resetMs))})`;
}

// Free-space samples `[{ t, free }]` (bytes). Returns seconds until the disk is full at the recent fill rate,
// or null without enough history or when space is not shrinking. Same sample rules as paceProjection.
export function timeToFullSeconds(samples, nowMs) {
    if (!Array.isArray(samples) || samples.length < PACE_MIN_SAMPLES) return null;
    const last = samples.at(-1);
    if (last.t - samples[0].t < PACE_MIN_SPAN_MS) return null;
    const rate = -slopePerSecond(samples.map(sample => [sample.t, sample.free]));
    if (!(rate > 0)) return null;
    return Math.max(0, Math.floor(last.free / rate - (nowMs - last.t) / 1000));
}

// Short duration for ETA text: `in 3h 12m`, `in 2d 4h`, `in 40m`, or `now`.
export function fullInText(seconds) {
    if (seconds === null) return '';
    return seconds <= 0 ? 'full now' : `full in ${compactDuration(seconds)}`;
}

// Battery time from /sys/class/power_supply readings. Energy readings (energy_now, energy_full) are in µWh with
// power_now in µW; charge readings (charge_now, charge_full) are in µAh with current_now in µA. Energy is preferred.
// Returns e.g. `2h 14m left` or `40m to full`, or null when the status or readings do not support an estimate.
export function batteryTimeText(readings) {
    const finite = value => Number.isFinite(value) && value >= 0;
    let now;
    let full;
    let rate;
    if (finite(readings.energy_now) && readings.power_now > 0) {
        [now, full, rate] = [readings.energy_now, readings.energy_full, readings.power_now];
    } else if (finite(readings.charge_now) && readings.current_now > 0) {
        [now, full, rate] = [readings.charge_now, readings.charge_full, readings.current_now];
    } else {
        return null;
    }
    let seconds = null;
    if (readings.status === 'Discharging') seconds = now / rate * 3600;
    else if (readings.status === 'Charging' && finite(full) && full > now) seconds = (full - now) / rate * 3600;
    if (seconds === null || !Number.isFinite(seconds) || seconds > 99 * 3600) return null;
    return readings.status === 'Charging' ? `${compactDuration(Math.round(seconds))} to full`
        : `${compactDuration(Math.round(seconds))} left`;
}

// Parses /proc/<pid>/stat into `{ name, ticks }`, where ticks is utime + stime in clock ticks. The command name
// may contain spaces and parentheses, so fields are read after the last `)`.
export function parseProcStat(text) {
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open) return null;
    const fields = text.slice(close + 2).split(' ');
    const ticks = Number(fields[11]) + Number(fields[12]);
    return Number.isFinite(ticks) ? { name: text.slice(open + 1, close), ticks } : null;
}

// Resident memory in kB from /proc/<pid>/status (VmRSS). Kernel threads have no VmRSS and return null.
// Reading the kB value directly avoids assuming a page size, which differs across architectures.
export function parseVmRssKb(text) {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
    return match ? Number(match[1]) : null;
}

// A process's share of all CPU time (across every CPU) between two readings, in percent to one decimal place.
// `total` is the all-CPU jiffy total from /proc/stat at the same two moments.
export function processCpuPercent(ticks, prevTicks, total, prevTotal) {
    if (prevTicks === undefined || !(total > prevTotal) || ticks < prevTicks) return null;
    return Math.round(1000 * (ticks - prevTicks) / (total - prevTotal)) / 10;
}

// Highest `count` entries by value; entries without a usable value are dropped.
export function topEntries(entries, count) {
    return entries.filter(entry => Number.isFinite(entry.value) && entry.value > 0)
        .sort((a, b) => b.value - a.value).slice(0, count);
}
