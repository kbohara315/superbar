import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as model from '../model.js';

const source = (await readFile(new URL('../extension.js', import.meta.url), 'utf8'))
    .replace(/^import [^;]*;\s*$/gm, '')
    .replace('export default class SuperbarExtension', 'class SuperbarExtension');

class Actor {
    constructor(props = {}) { this.props = props; this.children = []; this.signals = {}; this.layout_manager = {}; }
    add_child(child) { this.children.push(child); }
    get_last_child() { return this.children.at(-1); }
    get_width() { return 200; }
    connect(signal, callback) { this.signals[signal] = callback; }
    set_text(text) { this.props.text = text; }
    set_style(style) { this.props.style = style; }
    set_width(width) { this.props.width = width; }
    set_height(height) { this.props.height = height; }
    remove_all_children() { this.children = []; }
    set_pivot_point() {}
    ease(params) { this.eased = params; }
    remove_all_transitions() { this.eased = null; }
    get_text() { return this.props.text; }
    destroy() {}
}
class Menu extends Actor {
    constructor() { super(); this.items = []; }
    addMenuItem(item) { this.items.push(item); }
}
class Button extends Actor {
    // PanelMenu.Button takes positional args (alignment, name); St.Button takes a props object.
    constructor(props) { super(props !== null && typeof props === 'object' ? props : {}); this.menu = new Menu(); }
}
class MenuItem extends Actor {
    constructor(text) { super({ text }); }
}
const iconFiles = [];
let pidNames = [];
const spawned = [];
let fakeOutput = '';
let fakeExit = 0;
const timers = new Map();
let nextTimerId = 1;
const settingsValues = {
    'show-codex': true, 'show-claude': true, 'auto-provider-refresh': true, 'auto-system-refresh': true,
    'provider-interval': 60,
    'cpu-interval': 2, 'memory-interval': 5, 'swap-interval': 10, 'disk-interval': 30,
    'network-interval': 1, 'battery-interval': 30, 'temperature-interval': 5,
    'notify-thresholds': true, 'disk-alert-percent': 90, 'show-remaining': true,
    'show-cpu': false, 'show-memory': false, 'show-swap': false, 'show-disk': false,
    'show-network': false, 'show-battery': false, 'show-temperature': false,
};
const changeHandlers = [];
const settings = {
    get_boolean: key => settingsValues[key], get_double: key => settingsValues[key], get_int: key => settingsValues[key],
    set_boolean(key, value) { settingsValues[key] = value; changeHandlers.forEach(handler => handler(settings, key)); },
    set_double(key, value) { settingsValues[key] = value; changeHandlers.forEach(handler => handler(settings, key)); },
    connect: (_signal, handler) => changeHandlers.push(handler),
    disconnect() {},
};
const files = {
    '/proc/meminfo': 'MemTotal: 100000 kB\nMemAvailable: 40000 kB\nSwapTotal: 20000 kB\nSwapFree: 15000 kB\n',
    '/proc/stat': 'cpu 100 0 50 850 0 0 0 0 0 0\ncpu0 1 1 1 1\n',
    '/proc/net/dev': 'Inter-|   Receive\n face |bytes\n  lo: 99999 0 0 0 0 0 0 0 99999 0\n'
        + 'docker0: 5000 0 0 0 0 0 0 0 5000 0\n  eth0: 1024 0 0 0 0 0 0 0 2048 0\n',
    '/sys/class/power_supply/BAT0/capacity': '75\n',
    '/sys/class/power_supply/BAT0/status': 'Discharging\n',
    '/sys/class/thermal/thermal_zone0/temp': '42000\n',
    '/sys/class/thermal/thermal_zone1/temp': '55000\n',
};
const context = {
    TextEncoder, TextDecoder,
    ...model,
    Gio: {
        File: { new_for_path: path => {
            if (path.endsWith('.svg')) iconFiles.push(path);
            return { path, query_filesystem_info: () => ({
                get_attribute_uint64: key => key === 'filesystem::size' ? 100_000_000_000 : 60_000_000_000 }) };
        } },
        Subprocess: { new: argv => {
            spawned.push(argv);
            const pipe = { chunks: [new TextEncoder().encode(fakeOutput), new Uint8Array(0)] };
            const proc = {
                get_stdout_pipe: () => pipe,
                wait_async: (_cancel, callback) => callback(proc, null),
                wait_finish: () => true,
                get_if_exited: () => true,
                get_exit_status: () => fakeExit,
                force_exit() {},
            };
            return proc;
        } },
        SubprocessFlags: { STDOUT_PIPE: 1, STDERR_SILENCE: 2 },
        DataInputStream: class {
            constructor({ base_stream }) { this.base = base_stream; }
            read_bytes_async(_size, _priority, _cancel, callback) { callback(this, null); }
            read_bytes_finish() {
                const chunk = this.base.chunks.shift() ?? new Uint8Array(0);
                return { get_data: () => chunk };
            }
        },
        FileIcon: class { constructor(props) { this.props = props; } },
        BytesIcon: class { constructor(props) { this.props = props; } },
    },
    GLib: {
        PRIORITY_DEFAULT: 0,
        build_filenamev: parts => parts.join('/'),
        get_home_dir: () => '/mock-home',
        file_get_contents: path => {
            if (!(path in files)) throw new Error(`no such file ${path}`);
            return [true, new TextEncoder().encode(files[path])];
        },
        Bytes: { new: data => data },
        timeout_add_seconds: (_priority, _interval, callback) => {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
        timeout_add: (_priority, _interval, callback) => {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
        Dir: { open: () => {
            const names = [...pidNames];
            return { read_name: () => names.shift() ?? null };
        } },
        Source: { remove(id) {
            if (!id) throw new Error("g_source_remove: assertion 'tag > 0' failed");
            timers.delete(id);
        } },
        SOURCE_REMOVE: 0,
        SOURCE_CONTINUE: 1,
    },
    St: {
        BoxLayout: Actor,
        Icon: Actor,
        Label: class extends Actor { constructor(props) { super(props); this.clutter_text = {}; } },
        Widget: Actor,
        Entry: class extends Actor { constructor(props) { super(props); this.clutter_text = new Actor(); } },
        Button,
    },
    Pango: { EllipsizeMode: { NONE: 0, END: 3 } },
    Clutter: { ActorAlign: { CENTER: 0, END: 2 }, AnimationMode: { LINEAR: 1 }, EVENT_STOP: 0 },
    Extension: class { constructor() { this.path = '/mock-extension'; this.uuid = 'superbar@test'; }
    openPreferences() { context.prefsOpened = (context.prefsOpened ?? 0) + 1; } getSettings() { return settings; } },
    Main: { panel: { addToStatusArea(_uuid, indicator) { context.indicator = indicator; } },
        notify(title, body) { context.notifications.push(`${title}: ${body}`); } },
    PanelMenu: { Button },
    notifications: [],
    PopupMenu: {
        PopupBaseMenuItem: Actor,
        PopupMenuItem: MenuItem,
        PopupSeparatorMenuItem: class extends Actor {},
    },
    log(message) { context.logs.push(message); },
    logs: [],
};
const ExtensionClass = vm.runInNewContext(`${source}\nSuperbarExtension`, context);
const extension = new ExtensionClass();
let refreshes = 0;
extension._refresh = () => { refreshes++; };
extension.enable();

// The stock panel-button highlight/shadow must be suppressed on click and focus.
assert.match(extension._indicator.props.style, /box-shadow: none/);

assert.deepEqual(iconFiles, [
    '/mock-extension/icons/ProviderIcon-codex.svg',
    '/mock-extension/icons/ProviderIcon-claude.svg',
    '/mock-extension/icons/ProviderIcon-codex.svg',
    '/mock-extension/icons/ProviderIcon-claude.svg',
    '/mock-extension/icons/ProviderIcon-codex.svg',
    '/mock-extension/icons/ProviderIcon-claude.svg',
]);
const pills = context.indicator.children[0].children;
assert.equal(pills.length, 3); // provider pills plus one shared system capsule
assert.equal(pills[2].visible, false); // hidden until a metric is enabled
assert.equal(pills[2].children.length, 7);
assert.equal(pills[0].children[1].clutter_text.ellipsize, 0); // percentages never collapse to an ellipsis
assert.equal(pills[0].children[0].props.gicon.props.file.path, iconFiles[0]);
assert.equal(pills[0].children[1].props.text, '—');
assert.equal(pills[1].children[0].props.gicon.props.file.path, iconFiles[1]);
assert.equal(pills[1].children[1].props.text, '—');
assert.equal(context.indicator.signals['button-press-event'], undefined);

const [menuRefresh, codexRow, claudeRow] = context.indicator.menu.items;
const headerRow = menuRefresh.children[0];
const [headerLabel, settingsButton, refreshButton] = headerRow.children;
assert.equal(settingsButton.props.child.props.icon_name, 'preferences-system-symbolic');
assert.equal(headerLabel.props.text, 'Usage');
assert.equal(refreshButton.props.accessible_name, 'Refresh all usage and system metrics now');
assert.equal(refreshButton.props.x_align, 2); // right side of the header row
assert.equal(refreshButton.props.child.props.icon_name, 'view-refresh-symbolic');
const header = row => row.children[0].children[0];
assert.equal(header(codexRow).children[0].children[0].props.gicon.props.file.path, iconFiles[2]);
assert.equal(header(codexRow).children[1].children[0].props.text, 'Codex');
assert.equal(header(claudeRow).children[0].children[0].props.gicon.props.file.path, iconFiles[3]);
assert.equal(header(claudeRow).children[1].children[0].props.text, 'Claude Code');

// A fresh snapshot fills the pills, bars and reset captions.
const future = new Date(Date.now() + (2 * 3600 + 30 * 60 + 30) * 1000).toISOString();
extension._snapshot = {
    schema_version: 1,
    providers: {
        codex: { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 0, reset_at: future },
            secondary: { used_percent: 83, reset_at: future } } },
        claude: { state: 'fresh', windows: { primary: { used_percent: 95, reset_at: future }, secondary: null } },
    },
};
extension._renderSnapshot();
assert.equal(pills[0].children[1].props.text, '17%'); // remaining is the default; the pill shows the lowest remaining (weekly)
assert.match(pills[0].props.style, /#10a37f/);
assert.equal(pills[1].children[1].props.text, '5%');
assert.match(pills[1].props.style, /#e5484d/); // high usage overrides the brand colour
const codexCard = extension._cards.codex;
assert.equal(codexCard.primary.percent.props.text, '100% left');
assert.equal(codexCard.primary.fill.props.width, 316); // the bar fills with what is left
assert.equal(codexCard.secondary.percent.props.text, '17% left');
assert.equal(codexCard.secondary.fill.props.width, Math.round(316 * 17 / 100));
assert.match(codexCard.secondary.reset.props.text, /^↻ 2h 30m/);
assert.equal(extension._cards.claude.secondary.percent.props.text, 'unavailable');
assert.equal(codexCard.state.props.text, 'Live');
extension._markRefreshFailure();
assert.equal(pills[0].children[1].props.text, '17% !');
extension._renderSnapshot();
context.indicator.menu.signals['open-state-changed'](context.indicator.menu, true);
assert.equal(pills[0].children[1].props.text, '17%');

refreshButton.signals.clicked();
assert.equal(refreshes, 2); // initial refresh plus the header button

// First screen: both provider cards, no system card until a metric is enabled.
const [, , , systemItem, settingsHeader, settingsBody] = context.indicator.menu.items;
assert.equal(extension._cards.codex.item.visible, true);
assert.equal(extension._cards.claude.item.visible, true);
assert.equal(systemItem.visible, false);
assert.equal(settingsHeader.visible, false);
assert.equal(settingsBody.visible, false);

// The gear opens the settings screen inside the same menu; back returns to usage.
assert.equal(settingsButton.props.child.props.icon_name, 'preferences-system-symbolic');
settingsButton.signals.clicked();
assert.equal(extension._headerItem.visible, false);
assert.equal(extension._cards.codex.item.visible, false);
assert.equal(settingsHeader.visible, true);
assert.equal(settingsBody.visible, true);
const backButton = settingsHeader.children[0].children[0];
backButton.signals.clicked();
assert.equal(extension._headerItem.visible, true);
assert.equal(settingsBody.visible, false);
settingsButton.signals.clicked();
context.indicator.menu.signals['open-state-changed'](context.indicator.menu, false);
assert.equal(settingsBody.visible, false); // closing the menu resets to the usage screen

// A metric switch in settings shows its top-bar pill and menu row at once, and samples immediately.
const switchOf = row => row.row.children.at(-1);
const memoryRow = extension._settingsRows.memory;
settingsButton.signals.clicked();
switchOf(memoryRow).signals.clicked();
assert.equal(settingsValues['show-memory'], true);
assert.equal(extension._systemPills.memory.box.visible, true);
assert.equal(pills[2].visible, true);
assert.equal(extension._tileRows.length, 1);
assert.equal(extension._tileRows[0].children[0], extension._tiles.memory.button);
assert.equal(extension._tiles.memory.value.props.text, '59 MB');
assert.equal(extension._tiles.memory.detail.props.text, 'of 98 MB');
assert.equal(extension._tiles.memory.fill.props.width, Math.round(200 * 60 / 100));
assert.equal(extension._systemPills.memory.label.props.text, '60%');
assert.equal(extension._systemPills.cpu.box.visible, false);
backButton.signals.clicked();
assert.equal(systemItem.visible, true);

// Intervals: stepper, typed value and the s/m unit button all write seconds, clamped to the allowed range.
const cpu = extension._settingsRows.cpu.control;
assert.equal(cpu.entry.props.text, '2');
cpu.plus.signals.clicked();
assert.equal(settingsValues['cpu-interval'], 3);
cpu.minus.signals.clicked(); cpu.minus.signals.clicked(); cpu.minus.signals.clicked();
assert.equal(settingsValues['cpu-interval'], 1); // never below one second
cpu.unit.signals.clicked();
assert.equal(cpu.unit.label, 'm');
cpu.entry.props.text = '2';
cpu.entry.clutter_text.signals.activate();
assert.equal(settingsValues['cpu-interval'], 120);
cpu.plus.signals.clicked();
assert.equal(settingsValues['cpu-interval'], 180);
cpu.entry.props.text = 'abc';
cpu.entry.clutter_text.signals['key-focus-out']();
assert.equal(cpu.entry.props.text, '3'); // invalid input restores the stored value
cpu.entry.props.text = '999';
cpu.entry.clutter_text.signals.activate();
assert.equal(settingsValues['cpu-interval'], 3600);
const usage = extension._settingsRows.usageRefresh.control;
settingsValues['provider-interval'] = 60;
usage.minus.signals.clicked();
assert.equal(settingsValues['provider-interval'], 60); // usage polling stays at one minute or slower
settingsValues['cpu-interval'] = 2;

// CPU and network are rates: the first reading is a baseline and a follow-up reading is scheduled.
switchOf(extension._settingsRows.cpu).signals.clicked();
assert.equal(extension._tiles.cpu.value.props.text, 'sampling…');
assert.equal(extension._tileRows.map(row => row.children.length).join(), "2"); // CPU and memory share a row
const followUp = extension._followTimers.cpu;
assert.ok(timers.has(followUp));
files['/proc/stat'] = 'cpu 200 0 100 900 0 0 0 0 0 0\n';
timers.get(followUp)();
assert.equal(extension._tiles.cpu.value.props.text, '75%');
assert.equal(extension._systemPills.cpu.label.props.text, '75%');
const sparkBars = extension._tiles.cpu.bars;
assert.equal(sparkBars.at(-1).props.height, 12); // newest sample, 75% of the chart height
assert.equal(sparkBars[0].props.height, 1); // no history yet

// Network sums physical interfaces only (not lo or docker) and reports real rates.
const first = extension._readMetric('network', 1000);
assert.equal(first.value, 'sampling…');
files['/proc/net/dev'] = files['/proc/net/dev'].replace('eth0: 1024 0 0 0 0 0 0 0 2048', 'eth0: 52224 0 0 0 0 0 0 0 4096');
const second = extension._readMetric('network', 2000);
assert.equal(second.value, '↓ 50 KB/s');
assert.equal(second.detail, '↑ 2.0 KB/s');
assert.equal(second.short, '↓50K ↑2K');

// Other readers (objects come from the vm realm, so compare plain copies).
const plain = value => JSON.parse(JSON.stringify(value));
assert.deepEqual(plain(extension._readMetric('disk', 0)),
    { value: '40%', detail: '55.9 GB free', short: '40%', percent: 40, alert: false });
assert.deepEqual(plain(extension._readMetric('battery', 0)),
    { value: '75%', detail: 'Discharging', short: '75%', percent: 75, alert: false });
assert.deepEqual(plain(extension._readMetric('temperature', 0)),
    { value: '55.0 °C', short: '55°', percent: 55, alert: false });
assert.equal(extension._readMetric('swap', 0).short, '25%');
// Disk: a shrinking free-space trend adds a time-to-full caption, and crossing the threshold notifies once.
const diskAt = (minutes, free) => ({ t: 60_000 * minutes, free });
extension._diskSamples = [diskAt(0, 60e9), diskAt(10, 59.9e9), diskAt(20, 59.8e9)];
const filling = extension._readMetric('disk', 20 * 60_000);
assert.match(filling.detail, /^55\.\d GB free · full in \d+[dhm]/);
extension._diskSamples = [];
extension._diskAlert = { alerted: false };
const before = context.notifications.length;
extension._checkDiskAlert(89);
assert.equal(context.notifications.length, before);
extension._checkDiskAlert(91);
extension._checkDiskAlert(92);
assert.equal(context.notifications.length, before + 1);
assert.match(context.notifications.at(-1), /^Superbar: Disk 91% used/);
context.notifications.length = 0; // the alert tests below count their own notifications


// High values turn the pill red; a missing sensor reads as unavailable.
files['/sys/class/thermal/thermal_zone1/temp'] = '90000\n';
switchOf(extension._settingsRows.temperature).signals.clicked();
assert.match(extension._systemPills.temperature.label.props.style, /#ff6b6b/);
assert.match(extension._tiles.temperature.fill.props.style, /#e5484d/);
// Battery time comes from the same /sys files: energy over power while discharging.
files['/sys/class/power_supply/BAT0/energy_now'] = '30000000\n';
files['/sys/class/power_supply/BAT0/power_now'] = '10000000\n';
assert.equal(extension._readMetric('battery', 0).detail, 'Discharging · 3h 0m left');
delete files['/sys/class/power_supply/BAT0/energy_now'];
delete files['/sys/class/power_supply/BAT0/power_now'];
delete files['/sys/class/power_supply/BAT0/capacity'];
assert.equal(extension._readMetric('battery', 0).value, 'unavailable');

// Turning a metric off hides it again and drops its baseline.
switchOf(extension._settingsRows.cpu).signals.clicked();
assert.equal(extension._systemPills.cpu.box.visible, false);
assert.equal(extension._metricState.cpu, undefined);
assert.equal(extension._history.cpu, undefined);

// A saved provider error shows its safe code with a fix hint; a healthy provider hides the line.
extension._snapshot.providers.claude = { state: 'stale', last_success_at: null, windows: { primary: { used_percent: 51 }, secondary: null },
    error: { code: 'authentication_required', message: 'Provider rejected authentication' } };
extension._renderSnapshot();
assert.equal(extension._cards.claude.reason.visible, true);
assert.equal(extension._cards.claude.reason.props.text, 'authentication_required: Run `claude` to sign in again');
assert.equal(extension._cards.codex.reason.visible, false);
extension._snapshot.providers.claude = { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 51 }, secondary: null } };
extension._renderSnapshot();
assert.equal(extension._cards.claude.reason.visible, false);

// An expired window reads as a reset with unknown usage and no longer drives the red pill.
const passedReset = new Date(Date.now() - 60_000).toISOString();
extension._snapshot.providers.claude = { state: 'stale', last_success_at: null,
    windows: { primary: { used_percent: 95, reset_at: passedReset }, secondary: null } };
extension._renderSnapshot();
assert.equal(extension._cards.claude.primary.percent.props.text, 'reset · usage unknown');
assert.equal(extension._cards.claude.primary.reset.props.text, '↻ reset passed · awaiting data');
assert.equal(extension._cards.claude.primary.fill.props.width, 0);
assert.equal(pills[1].children[1].props.text, '—');
assert.match(pills[1].props.style, /#6b6f76/);
extension._snapshot.providers.claude = { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 51 }, secondary: null } };
extension._renderSnapshot();

// The provider card states when its access token expires (or has expired).
extension._snapshot.providers.codex = { state: 'fresh', last_success_at: null, expires_at: new Date(Date.now() + 20 * 60_000).toISOString(),
    windows: { primary: { used_percent: 10 }, secondary: null } };
extension._renderSnapshot();
assert.match(extension._cards.codex.synced.props.text, /· token expires in 19m$|· token expires in 20m$/);
extension._snapshot.providers.codex = { state: 'fresh', last_success_at: null, expires_at: new Date(Date.now() - 1000).toISOString(),
    windows: { primary: { used_percent: 10 }, secondary: null } };
extension._renderSnapshot();
assert.equal(extension._cards.codex.synced.props.text, 'Not synced yet · token expired');
extension._snapshot.providers.codex = { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 10 }, secondary: null } };
extension._renderSnapshot();
assert.equal(extension._cards.codex.synced.props.text, 'Not synced yet');

assert.equal(extension._settingsRows.alerts.row.children.length, 3); // icon, title and switch
// Used mode (the setting turned off) shows used percentages everywhere; colour still follows used.
extension._snapshot = { schema_version: 1, providers: {
    codex: { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 0, reset_at: future },
        secondary: { used_percent: 83, reset_at: future } } },
    claude: { state: 'fresh', windows: { primary: { used_percent: 95, reset_at: future }, secondary: null } } } };
extension._renderSnapshot();
settingsValues['show-remaining'] = false;
extension._applySettings('show-remaining');
assert.equal(pills[0].children[1].props.text, '83%');
assert.match(pills[0].props.style, /#10a37f/); // 83% used is below the alert line
assert.equal(codexCard.primary.percent.props.text, '0% used');
assert.equal(codexCard.primary.fill.props.width, 0);
assert.equal(codexCard.secondary.percent.props.text, '83% used');
assert.equal(codexCard.secondary.fill.props.width, Math.round(316 * 83 / 100));
assert.equal(pills[1].children[1].props.text, '95%');
assert.match(pills[1].props.style, /#e5484d/); // red still means used >= 90
settingsValues['show-remaining'] = true;
extension._applySettings('show-remaining');
assert.equal(pills[0].children[1].props.text, '17%');
assert.equal(codexCard.secondary.percent.props.text, '17% left');
assert.equal(pills[1].children[1].props.text, '5%');
extension._snapshot.providers.claude = { state: 'fresh', last_success_at: null, windows: { primary: { used_percent: 51 }, secondary: null } };
extension._renderSnapshot();

// Burn rate: after enough samples the row shows the pace; it is hidden before then.
const paceNow = Date.now();
const paceReset = new Date(paceNow + 3 * 3600_000).toISOString();
const paceFresh = percent => ({ schema_version: 1, providers: {
    codex: { state: 'fresh', windows: { primary: { label: 'Session', used_percent: percent, reset_at: paceReset }, secondary: null } },
    claude: { state: 'unavailable', windows: { primary: null, secondary: null } } } });
extension._applySnapshot(paceFresh(10));
assert.equal(extension._cards.codex.primary.pace.visible, false);
extension._paceSamples['codex/primary'] = [0, 10, 20].map(m => ({ t: paceNow - (20 - m) * 60_000, percent: 10 + m, resetAt: paceReset }));
extension._renderSnapshot();
assert.equal(extension._cards.codex.primary.pace.visible, true);
assert.match(extension._cards.codex.primary.pace.props.text, /^at this pace the limit runs out at \d\d:\d\d \(resets \d\d:\d\d\)$/);
delete extension._paceSamples['codex/primary'];
extension._renderSnapshot();
assert.equal(extension._cards.codex.primary.pace.visible, false);

// Fresh data raises a notification once per threshold; stale data never does; the switch silences all of them.
extension._applySnapshot({ schema_version: 1, providers: {
    codex: { state: 'fresh', windows: { primary: { label: 'Session', used_percent: 85, reset_at: future }, secondary: null } },
    claude: { state: 'unavailable', windows: { primary: null, secondary: null } } } });
assert.deepEqual(context.notifications, ['Superbar: Codex Session: 15% left']);
extension._applySnapshot({ schema_version: 1, providers: {
    codex: { state: 'stale', windows: { primary: { label: 'Session', used_percent: 99, reset_at: future }, secondary: null } },
    claude: { state: 'unavailable', windows: { primary: null, secondary: null } } } });
assert.equal(context.notifications.length, 1);
settingsValues['notify-thresholds'] = false;
extension._applySnapshot({ schema_version: 1, providers: {
    codex: { state: 'fresh', windows: { primary: { label: 'Session', used_percent: 95, reset_at: future }, secondary: null } },
    claude: { state: 'unavailable', windows: { primary: null, secondary: null } } } });
assert.equal(context.notifications.length, 1);
settingsValues['notify-thresholds'] = true;
extension._applySnapshot({ schema_version: 1, providers: {
    codex: { state: 'fresh', windows: { primary: { label: 'Session', used_percent: 95, reset_at: future }, secondary: null } },
    claude: { state: 'unavailable', windows: { primary: null, secondary: null } } } });
assert.equal(context.notifications.length, 1); // 90% was already sent for this window

// Rate-limit backoff through the real refresh path. The fake CLI prints `fakeOutput` and exits with `fakeExit`.
// A full refresh reruns the timer's gate; a single-provider refresh never changes the backoff.
delete extension._refresh; // use the real method, not the counting stub above

const runRefresh = (provider, snapshot) => {
    fakeOutput = JSON.stringify(snapshot);
    const before = spawned.length;
    extension._refresh(provider);
    return spawned.length - before;
};
const healthy = { schema_version: 1, providers: {
    codex: { state: 'fresh', windows: { primary: { used_percent: 5 }, secondary: null } },
    claude: { state: 'fresh', windows: { primary: { used_percent: 5 }, secondary: null } } } };
const limited = { schema_version: 1, providers: {
    codex: { state: 'unavailable', windows: { primary: null, secondary: null }, error: { code: 'rate_limited', message: 'x' } },
    claude: { state: 'fresh', windows: { primary: { used_percent: 5 }, secondary: null } } } };
const deadlineWithin = (seconds, now) => Math.abs(extension._providerNextAt - now - seconds * 1000) < 5000;

assert.equal(runRefresh('all', limited), 1);
assert.equal(extension._rateLimitStreak, 1);
assert.ok(deadlineWithin(120, Date.now())); // first rate limit: 60s base doubles to 120s

// The automatic timer tick waits for the deadline.
const tick = timers.get(extension._timer);
extension._providerNextAt = Date.now() + 60_000;
const beforeTick = spawned.length;
tick();
assert.equal(spawned.length, beforeTick);
extension._providerNextAt = Date.now() - 1;
tick();
assert.equal(spawned.length, beforeTick + 1);
fakeOutput = JSON.stringify(limited); // the tick's refresh was rate limited too

// A manual full refresh still runs during the backoff, and its success resets the backoff.
extension._providerNextAt = Date.now() + 600_000;
assert.equal(runRefresh('all', healthy), 1);
assert.equal(extension._rateLimitStreak, 0);
assert.equal(extension._providerNextAt, 0);

// A single-provider refresh neither extends nor resets the backoff.
assert.equal(runRefresh('all', limited), 1);
assert.equal(runRefresh('codex', healthy), 1);
assert.equal(extension._rateLimitStreak, 1);

// Consecutive rate limits double the interval and cap at 15 minutes.
for (let streak = 2; streak <= 5; streak++) {
    runRefresh('all', limited);
    assert.equal(extension._rateLimitStreak, streak);
    assert.ok(deadlineWithin(Math.min(900, 60 * 2 ** streak), Date.now()), `streak ${streak}`);
}
assert.ok(deadlineWithin(900, Date.now())); // 60 * 2^5 is capped at 900 seconds
assert.equal(runRefresh('all', healthy), 1);
assert.equal(extension._rateLimitStreak, 0); // the interval resets on success
assert.equal(extension._providerNextAt, 0);

// A busy lock is reported as its own header message, not as a generic failure.
extension._markRefreshFailure('lock_busy');
assert.equal(headerLabel.props.text, 'Refresh busy');
extension._markRefreshFailure('timeout');
assert.equal(headerLabel.props.text, 'Refresh timed out');

// Busy state: the label changes and the icon spins until the fetch ends.
const icon = refreshButton.props.child;
extension._setBusy(true);
assert.equal(headerLabel.props.text, 'Refreshing…');
assert.equal(icon.eased.rotation_angle_z, 360);
assert.equal(icon.eased.onComplete, undefined); // completion must not recursively restart the animation
const spinTimer = extension._spinTimer;
assert.equal(timers.get(spinTimer)(), context.GLib.SOURCE_CONTINUE);
assert.equal(icon.eased.rotation_angle_z, 360);
extension._setBusy(false);
assert.equal(timers.has(spinTimer), false);
assert.equal(icon.eased, null);
assert.equal(headerLabel.props.text, 'Usage');
extension._markRefreshFailure();
assert.equal(headerLabel.props.text, 'Refresh failed');
// Top consumers: the CPU list needs two readings, memory lists resident size; a tile click toggles the list.
const procStat = (pid, name, utime, stime) => `${pid} (${name}) S ${'0 '.repeat(10)}${utime} ${stime} 0 0\n`;
pidNames = ['101', '102', 'self'];
files['/proc/101/stat'] = procStat(101, 'chrome', 100, 100);
files['/proc/102/stat'] = procStat(102, 'code', 50, 0);
files['/proc/101/status'] = 'Name:\tchrome\nVmRSS:\t    8192 kB\n';
files['/proc/102/status'] = 'Name:\tcode\nVmRSS:\t    2048 kB\n';
files['/proc/101/comm'] = 'chrome\n';
files['/proc/102/comm'] = 'code\n';
files['/proc/stat'] = 'cpu 200 0 100 900 0 0 0 0 0 0\n';
const rowsOf = () => extension._processBox.children.slice(1).filter(row => row.children.length === 2)
    .map(row => row.children.map(label => label.props.text));
extension._toggleProcesses('cpu');
assert.equal(extension._processBox.visible, true);
extension._renderProcesses('cpu');
assert.deepEqual(rowsOf(), [], 'first CPU reading is only a baseline');
assert.equal(extension._processBox.children[1].props.text, 'sampling…');
files['/proc/101/stat'] = procStat(101, 'chrome', 160, 140);
files['/proc/102/stat'] = procStat(102, 'code', 50, 0);
files['/proc/stat'] = 'cpu 300 0 150 1050 0 0 0 0 0 0\n';
extension._renderProcesses('cpu');
assert.deepEqual(rowsOf(), [['chrome', '33.3%']]); // 100 of 300 jiffies; idle code process is dropped
extension._toggleProcesses('memory');
extension._renderProcesses('memory');
assert.deepEqual(rowsOf(), [['chrome', '8 MB'], ['code', '2 MB']]); // largest resident set first
extension._tiles.memory.button.signals.clicked();
assert.equal(extension._processBox.visible, false); // the same tile closes the list
assert.equal(extension._processMetric, null);

extension.disable();
assert.equal(extension._tileRows.length, 0); // rows belong to the old menu and must not survive a reload
console.log('extension indicator mock integration tests passed');
