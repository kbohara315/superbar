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

export function usedPercent(window) {
    return window && Number.isFinite(window.used_percent)
        ? Math.round(window.used_percent) : null;
}

export function pillText(provider) {
    const value = usedPercent(provider?.windows?.primary);
    return value === null ? '—' : `${value}%`;
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
