import assert from 'node:assert/strict';
import {
    batteryTimeText, compactDuration, parseProcStat, parseVmRssKb, processCpuPercent, topEntries, diskAlertMessage, errorReason, fullInText, isSnapshot, nextRateLimitStreak, paceProjection,
    displayPercent, paceText, peakPercent, percentLabel, pillText, providerBackoffSeconds, refreshFailureText, resetClock, resetCountdown,
    stateText, syncedText, timeToFullSeconds, tokenExpiryText, usageLevel, usedPercent, windowAlerts, windowUsageText,
} from '../model.js';

const snapshot = {
    schema_version: 1,
    providers: {
        codex: { state: 'fresh', windows: { primary: { used_percent: 22.6 }, secondary: null } },
        claude: { state: 'stale', windows: { primary: { used_percent: 51 }, secondary: { used_percent: 70 } } },
    },
};

assert.equal(isSnapshot(snapshot), true);
// Default mode is remaining: 23% used shows 77%, and the pill shows the lowest remaining (highest used) window.
assert.equal(pillText(snapshot.providers.codex), '77%');
assert.equal(pillText(snapshot.providers.claude), '30%');
assert.equal(pillText(snapshot.providers.codex, Date.now(), 'used'), '23%');
assert.equal(pillText(snapshot.providers.claude, Date.now(), 'used'), '70%');
assert.equal(peakPercent(snapshot.providers.claude), 70);
assert.equal(pillText({ windows: { primary: null } }), '—');
assert.equal(pillText(undefined), '—');
assert.equal(usedPercent({ used_percent: 82.5 }), 83);
assert.equal(usedPercent(null), null);
assert.equal(usageLevel(null), 'unknown');
assert.equal(usageLevel(89), 'ok');
assert.equal(usageLevel(90), 'high');
assert.equal(stateText({ state: 'fresh' }), 'Live');
assert.equal(stateText({ state: 'stale' }), 'Stale');
assert.equal(stateText({ state: 'unavailable' }), 'Offline');
assert.equal(syncedText({}), 'Not synced yet');
assert.equal(isSnapshot({ ...snapshot, schema_version: 2 }), false);
assert.equal(isSnapshot({ ...snapshot, providers: { ...snapshot.providers, claude: null } }), false);
assert.equal(isSnapshot({ ...snapshot, providers: { ...snapshot.providers, codex: {
    state: 'fresh', windows: { primary: { used_percent: 101 }, secondary: null },
} } }), false);

const now = Date.parse('2026-10-31T10:00:00Z');
const after = seconds => new Date(now + seconds * 1000).toISOString();
assert.equal(resetCountdown(after(30), now), 'resets in 0m');
assert.equal(resetCountdown(after(2 * 3600 + 14 * 60 + 5), now), 'resets in 2h 14m');
assert.equal(resetCountdown(after(3 * 86400 + 4 * 3600), now), 'resets in 3d 4h');
assert.equal(resetCountdown(after(-5), now), 'resetting now');
assert.equal(resetCountdown(null, now), 'reset time unavailable');
assert.equal(resetCountdown('garbage', now), 'reset scheduled');

// Local-time formatting: build instants from local components so the test is timezone independent.
const local = (day, hour, minute) => new Date(2026, 9, day, hour, minute).getTime();
assert.equal(resetClock(new Date(local(31, 14, 5)).toISOString(), local(31, 9, 0)), '14:05');
assert.equal(resetClock(new Date(local(31 + 1, 14, 5)).toISOString(), local(31, 9, 0)), 'Sun 14:05');
assert.equal(resetClock('garbage', now), '');
assert.equal(syncedText({ last_success_at: new Date(local(31, 7, 9)).toISOString() }), 'Synced 07:09');

// An expired window (reset time passed) is unknown, not its old percentage, and does not drive the pill.
const reset = Date.parse('2026-10-31T12:00:00Z');
const beforeReset = reset - 60_000;
const afterReset = reset + 60_000;
const expiredWindow = { used_percent: 95, reset_at: new Date(reset).toISOString() };
assert.equal(usedPercent(expiredWindow, beforeReset), 95);
assert.equal(usedPercent(expiredWindow, afterReset), null);
assert.equal(windowUsageText(expiredWindow, afterReset), 'reset · usage unknown');
assert.equal(windowUsageText(expiredWindow, beforeReset), '5% left');
assert.equal(windowUsageText(expiredWindow, beforeReset, 'used'), '95% used');
assert.equal(windowUsageText(null, afterReset), 'unavailable');
const staleProvider = { windows: { primary: expiredWindow, secondary: { used_percent: 40, reset_at: new Date(reset + 86400_000).toISOString() } } };
assert.equal(pillText(staleProvider, afterReset), '60%');
assert.equal(pillText(staleProvider, afterReset, 'used'), '40%');
assert.equal(usageLevel(peakPercent(staleProvider, afterReset)), 'ok');
assert.equal(pillText({ windows: { primary: expiredWindow, secondary: null } }, afterReset), '—');
assert.equal(usageLevel(peakPercent({ windows: { primary: expiredWindow, secondary: null } }, beforeReset)), 'high');

// Stale/offline reasons: the safe code plus a fix hint naming the provider's own CLI.
assert.deepEqual(errorReason({ error: { code: 'authentication_required' } }, 'claude'),
    { code: 'authentication_required', hint: 'Run `claude` to sign in again' });
assert.deepEqual(errorReason({ error: { code: 'authentication_required' } }, 'codex'),
    { code: 'authentication_required', hint: 'Run `codex` to sign in again' });
assert.equal(errorReason({ error: { code: 'rate_limited' } }, 'codex').hint, 'Rate limited; retrying with backoff');
assert.equal(errorReason({ error: { code: 'response_invalid' } }, 'claude').hint, 'Provider API may have changed');
assert.equal(errorReason({ error: { code: 'something_new' } }, 'claude').hint, 'Provider error; refresh to try again');
assert.equal(errorReason({ state: 'fresh' }, 'claude'), null);
assert.equal(errorReason(undefined, 'claude'), null);
assert.equal(refreshFailureText('lock_busy'), 'Refresh busy');
assert.equal(refreshFailureText('timeout'), 'Refresh timed out');
assert.equal(refreshFailureText('failed'), 'Refresh failed');

// Token expiry comes from the credential file via the snapshot; a missing value shows nothing.
const expiring = { expires_at: new Date(now + 20 * 60_000).toISOString() };
assert.equal(tokenExpiryText(expiring, now), 'token expires in 20m');
assert.equal(tokenExpiryText({ expires_at: new Date(now - 1000).toISOString() }, now), 'token expired');
assert.equal(tokenExpiryText({ expires_at: null }, now), null);
assert.equal(tokenExpiryText({}, now), null);
assert.equal(compactDuration(3 * 86400 + 4 * 3600), '3d 4h');
assert.equal(compactDuration(2 * 3600 + 14 * 60), '2h 14m');
assert.equal(compactDuration(30), 'under 1m');

// Rate-limit backoff: the base interval doubles per consecutive rate-limited refresh, capped at 15 minutes.
assert.equal(providerBackoffSeconds(60, 0), 60);
assert.equal(providerBackoffSeconds(60, 1), 120);
assert.equal(providerBackoffSeconds(60, 2), 240);
assert.equal(providerBackoffSeconds(60, 3), 480);
assert.equal(providerBackoffSeconds(60, 4), 900);
assert.equal(providerBackoffSeconds(60, 40), 900);
assert.equal(providerBackoffSeconds(3600, 1), 3600); // a longer base interval is never shortened
const limited = { providers: { codex: { error: { code: 'rate_limited' } }, claude: { error: null } } };
assert.equal(nextRateLimitStreak(0, limited), 1);
assert.equal(nextRateLimitStreak(2, limited), 3);
assert.equal(nextRateLimitStreak(3, { providers: { codex: { error: { code: 'network_error' } }, claude: {} } }), 0);

// Threshold alerts fire once per threshold per window period (keyed by reset time).
const alertMemo = {};
const windowAt = (percent, resetAt) => ({ label: 'Session', used_percent: percent, reset_at: resetAt });
const r1 = '2026-11-06T15:00:00Z';
const r2 = '2026-11-06T20:00:00Z';
const t0 = Date.parse('2026-11-06T10:00:00Z');
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(50, r1), t0), []);
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(85, r1), t0), ['Codex Session: 15% left']);
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(86, r1), t0), []); // 80 already sent
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(92, r1), t0), ['Codex Session: 8% left']);
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(95, r1), t0), []); // 90 already sent
// A jump straight past both thresholds sends one message and records both.
assert.deepEqual(windowAlerts({}, 'x', 'X', windowAt(97, r1), t0), ['X: 3% left']);
// Thresholds still trigger on used percent, and the used wording is available for the used mode.
assert.deepEqual(windowAlerts({}, 'z', 'Z', windowAt(80, r1), t0, 'used'), ['Z: 80% used']);
assert.deepEqual(windowAlerts({}, 'w', 'W', windowAt(79, r1), t0, 'remaining'), []);
// After the window resets (reset time passed and a new one is reported), thresholds re-arm and a reset is announced.
const resetTime = Date.parse(r1) + 60_000;
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(10, r2), resetTime), ['Codex Session window reset']);
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', windowAt(83, r2), resetTime), ['Codex Session: 17% left']);
// Unknown or expired usage never alerts, and does not forget the period it belongs to.
assert.deepEqual(windowAlerts(alertMemo, 'codex/primary', 'Codex Session', null, resetTime), []);
assert.deepEqual(windowAlerts({}, 'y', 'Y', windowAt(99, r1), Date.parse(r1) + 1), []);

// Disk alert fires once at the threshold and re-arms when usage drops below it.
const disk = { alerted: false };
assert.equal(diskAlertMessage(disk, 89, 90, 'full in 3h'), null);
assert.equal(diskAlertMessage(disk, 91, 90, 'full in 3h'), 'Disk 91% used · full in 3h');
assert.equal(diskAlertMessage(disk, 92, 90, 'full in 2h'), null);
assert.equal(diskAlertMessage(disk, 85, 90, ''), null);
assert.equal(diskAlertMessage(disk, 90, 90, null), 'Disk 90% used');

// Burn-rate: needs three samples over ten minutes; a steady climb projects when it reaches 100%.
const resetIso = '2026-11-06T15:00:00Z';
const at = minutes => Date.parse('2026-11-06T10:00:00Z') + minutes * 60_000;
const sample = (minutes, percent, resetAt = resetIso) => ({ t: at(minutes), percent, resetAt });
assert.equal(paceProjection([sample(0, 10), sample(5, 20)], resetIso), null); // too few samples
assert.equal(paceProjection([sample(0, 10), sample(4, 20), sample(8, 30)], resetIso), null); // too short
// 10 points per 10 minutes: at 30% after 20 minutes, 100% is reached 70 minutes later (12:50).
const climbing = paceProjection([sample(0, 10), sample(10, 20), sample(20, 30)], resetIso);
assert.equal(climbing.safe, false);
// Clock text is local time, so the expected values are built from local components too.
const hhmm = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
assert.equal(paceText(climbing), `at this pace the limit runs out at ${hhmm(at(90))} (resets ${hhmm(Date.parse(resetIso))})`);
// A flat or falling trend is safe, and a projection past the reset is safe too.
assert.equal(paceText(paceProjection([sample(0, 40), sample(10, 40), sample(20, 40)], resetIso)), 'safe until reset');
assert.equal(paceProjection([sample(0, 10), sample(10, 11), sample(20, 12)], resetIso).safe, true); // 1 point per 10 min, far past reset
// Samples before a reset (different reset time, or usage that fell) are ignored.
const afterDrop = [sample(0, 90), sample(10, 95), sample(20, 5), sample(30, 6), sample(40, 7)];
assert.equal(paceProjection(afterDrop, resetIso).safe, true);
assert.equal(paceProjection([sample(0, 10, 'old'), sample(10, 20, 'old'), sample(20, 30, 'old')], resetIso), null);
assert.equal(paceText(null), '');

// Disk: time to full from free space that keeps shrinking; null when it is not shrinking or history is short.
const freeAt = minutes => ({ t: at(minutes), free: 10_000_000_000 - minutes * 1_000_000 }); // 1 MB per minute
assert.equal(timeToFullSeconds([freeAt(0), freeAt(5)], at(5)), null);
const eta = timeToFullSeconds([freeAt(0), freeAt(10), freeAt(20)], at(20));
assert.equal(eta, Math.floor((10_000_000_000 - 20_000_000) / (1_000_000 / 60)));
assert.equal(timeToFullSeconds([{ t: at(0), free: 5 }, { t: at(10), free: 5 }, { t: at(20), free: 5 }], at(20)), null);
assert.equal(fullInText(eta), `full in ${compactDuration(eta)}`);
assert.equal(fullInText(null), '');

// Battery time: energy readings (µWh, µW) and charge readings (µAh, µA) both give hours from the current rate.
assert.equal(batteryTimeText({ status: 'Discharging', energy_now: 30_000_000, power_now: 10_000_000 }), '3h 0m left');
assert.equal(batteryTimeText({ status: 'Discharging', energy_now: 25_000_000, power_now: 10_000_000 }), '2h 30m left');
assert.equal(batteryTimeText({ status: 'Discharging', charge_now: 4_000_000, current_now: 2_000_000 }), '2h 0m left');
assert.equal(batteryTimeText({ status: 'Charging', energy_now: 20_000_000, energy_full: 50_000_000, power_now: 30_000_000 }), '1h 0m to full');
assert.equal(batteryTimeText({ status: 'Full', energy_now: 50_000_000, power_now: 0 }), null);
assert.equal(batteryTimeText({ status: 'Discharging', energy_now: 30_000_000, power_now: 0 }), null); // no rate, no estimate
assert.equal(batteryTimeText({ status: 'Discharging' }), null);
assert.equal(batteryTimeText({ status: 'Charging', energy_now: 50_000_000, energy_full: 50_000_000, power_now: 1 }), null);

// Top consumers: /proc parsers and the CPU share between two readings.
assert.deepEqual(parseProcStat('4321 (web content (1)) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0'), { name: 'web content (1)', ticks: 300 });
assert.equal(parseProcStat('garbage'), null);
assert.equal(parseVmRssKb('Name:\tchrome\nVmPeak:\t 9000 kB\nVmRSS:\t    8192 kB\nThreads:\t4\n'), 8192);
assert.equal(parseVmRssKb('Name:\tkthreadd\nVmPID:\t\n'), null); // kernel threads have no VmRSS
assert.equal(parseVmRssKb('VmRSS:\t12 MB\n'), null);
assert.equal(processCpuPercent(300, 100, 10_000, 9_000), 20); // 200 of 1000 jiffies across all CPUs
assert.equal(processCpuPercent(300, undefined, 10_000, 9_000), null); // no baseline yet
assert.equal(processCpuPercent(300, 100, 9_000, 9_000), null); // no time passed
assert.equal(processCpuPercent(50, 100, 10_000, 9_000), null); // counter went backwards (pid reuse)
assert.deepEqual(topEntries([{ name: 'a', value: 1 }, { name: 'b', value: 9 }, { name: 'c', value: null }, { name: 'd', value: 0 }, { name: 'e', value: 4 }], 2),
    [{ name: 'b', value: 9 }, { name: 'e', value: 4 }]);

// Display modes: remaining is 100 minus used; the edges, null and rounding are fixed here.
assert.equal(displayPercent(0), 100);
assert.equal(displayPercent(100), 0);
assert.equal(displayPercent(0, 'used'), 0);
assert.equal(displayPercent(100, 'used'), 100);
assert.equal(displayPercent(null), null);
assert.equal(displayPercent(null, 'used'), null);
assert.equal(displayPercent(undefined, 'remaining'), null);
assert.equal(displayPercent(NaN), null);
assert.equal(displayPercent(42), 58);
assert.equal(displayPercent(42, 'used'), 42);
assert.equal(displayPercent(42.4), 58); // used is already an integer percent; rounding happens first
assert.equal(displayPercent(42.6), 57); // used rounds to 43, so remaining is 57
assert.equal(displayPercent(42.6, 'used'), 43);
assert.equal(displayPercent(150), 0); // out of range input is clamped, never negative
assert.equal(displayPercent(-5), 100);
assert.equal(displayPercent(150, 'used'), 100);
assert.equal(displayPercent(42, 'bogus'), 58); // anything but 'used' is remaining
assert.equal(percentLabel(80), '20% left');
assert.equal(percentLabel(80, 'used'), '80% used');
assert.equal(percentLabel(100), '0% left');
assert.equal(percentLabel(0), '100% left');
// Remaining and used always add to 100 for the same displayed value.
for (let used = 0; used <= 100; used++) assert.equal(displayPercent(used) + displayPercent(used, 'used'), 100);

console.log('extension model tests passed');
