import assert from 'node:assert/strict';
import {
    isSnapshot, pillText, resetClock, resetCountdown, stateText, syncedText, usageLevel, usedPercent,
} from '../model.js';

const snapshot = {
    schema_version: 1,
    providers: {
        codex: { state: 'fresh', windows: { primary: { used_percent: 22.6 }, secondary: null } },
        claude: { state: 'stale', windows: { primary: { used_percent: 51 }, secondary: { used_percent: 70 } } },
    },
};

assert.equal(isSnapshot(snapshot), true);
assert.equal(pillText(snapshot.providers.codex), '23%');
assert.equal(pillText(snapshot.providers.claude), '51%');
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

console.log('extension model tests passed');
