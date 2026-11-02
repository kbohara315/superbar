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
const timers = new Map();
let nextTimerId = 1;
const settingsValues = {
    'show-codex': true, 'show-claude': true, 'auto-provider-refresh': true, 'auto-system-refresh': true,
    'provider-interval': 60,
    'cpu-interval': 2, 'memory-interval': 5, 'swap-interval': 10, 'disk-interval': 30,
    'network-interval': 1, 'battery-interval': 30, 'temperature-interval': 5,
    'show-cpu': false, 'show-memory': false, 'show-swap': false, 'show-disk': false,
    'show-network': false, 'show-battery': false, 'show-temperature': false,
};
const changeHandlers = [];
const settings = {
    get_boolean: key => settingsValues[key], get_double: key => settingsValues[key],
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
        timeout_add_seconds: () => 1,
        timeout_add: (_priority, _interval, callback) => {
            const id = nextTimerId++;
            timers.set(id, callback);
            return id;
        },
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
    Main: { panel: { addToStatusArea(_uuid, indicator) { context.indicator = indicator; } } },
    PanelMenu: { Button },
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
assert.equal(pills[0].children[1].props.text, '0%');
assert.match(pills[0].props.style, /#10a37f/);
assert.equal(pills[1].children[1].props.text, '95%');
assert.match(pills[1].props.style, /#e5484d/); // high usage overrides the brand colour
const codexCard = extension._cards.codex;
assert.equal(codexCard.primary.percent.props.text, '0% used');
assert.equal(codexCard.primary.fill.props.width, 0);
assert.equal(codexCard.secondary.percent.props.text, '83% used');
assert.equal(codexCard.secondary.fill.props.width, Math.round(316 * 83 / 100));
assert.match(codexCard.secondary.reset.props.text, /^↻ 2h 30m/);
assert.equal(extension._cards.claude.secondary.percent.props.text, 'unavailable');
assert.equal(codexCard.state.props.text, 'Live');
extension._markRefreshFailure();
assert.equal(pills[0].children[1].props.text, '0% !');
extension._renderSnapshot();
context.indicator.menu.signals['open-state-changed'](context.indicator.menu, true);
assert.equal(pills[0].children[1].props.text, '0%');

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

// High values turn the pill red; a missing sensor reads as unavailable.
files['/sys/class/thermal/thermal_zone1/temp'] = '90000\n';
switchOf(extension._settingsRows.temperature).signals.clicked();
assert.match(extension._systemPills.temperature.label.props.style, /#ff6b6b/);
assert.match(extension._tiles.temperature.fill.props.style, /#e5484d/);
delete files['/sys/class/power_supply/BAT0/capacity'];
assert.equal(extension._readMetric('battery', 0).value, 'unavailable');

// Turning a metric off hides it again and drops its baseline.
switchOf(extension._settingsRows.cpu).signals.clicked();
assert.equal(extension._systemPills.cpu.box.visible, false);
assert.equal(extension._metricState.cpu, undefined);
assert.equal(extension._history.cpu, undefined);

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
extension.disable();
assert.equal(extension._tileRows.length, 0); // rows belong to the old menu and must not survive a reload
console.log('extension indicator mock integration tests passed');
