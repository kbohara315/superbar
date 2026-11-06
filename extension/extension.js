import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {
    batteryTimeText, diskAlertMessage, errorReason, fullInText, parseProcStat, parseVmRssKb, processCpuPercent, topEntries, isSnapshot, nextRateLimitStreak, paceProjection, paceText, peakPercent,
    displayPercent, pillText, providerBackoffSeconds, refreshFailureText, resetClock, resetCountdown, stateText, syncedText,
    timeToFullSeconds, tokenExpiryText, usageLevel, usedPercent, windowAlerts, windowExpired, windowUsageText,
} from './model.js';

const POLL_SECONDS = 60;
// Two sequential provider requests can each take up to 15 seconds.
const FETCH_TIMEOUT_MS = 40_000;
const MAX_OUTPUT = 256 * 1024;
// Exit status the CLI uses when another refresh holds the runtime lock.
const LOCK_BUSY_EXIT = 75;
const READ_CHUNK = 16 * 1024;
const BRAND = { codex: '#10a37f', claude: '#d97757' };
const NEUTRAL = '#6b6f76';
const ALERT = '#e5484d';
const CARD_WIDTH = 316;
const HEADER_TEXT = 'Usage';
const SYSTEM_METRICS = ['cpu', 'memory', 'swap', 'disk', 'network', 'battery', 'temperature'];
const METRIC_TITLES = { cpu: 'CPU', memory: 'Memory', swap: 'Swap', disk: 'Disk', network: 'Network',
    battery: 'Battery', temperature: 'Temperature' };
// Rate metrics need two readings, so the first one only sets a baseline.
const RATE_METRICS = ['cpu', 'network'];
const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|tun|tap)/;
const THERMAL_ZONES = 16;
const MAX_INTERVAL = 3600;
// About two hours of provider refreshes at the default one-minute interval.
const MAX_PACE_SAMPLES = 120;
// Top-consumer panel: at most this many /proc entries are scanned, and this many rows are shown.
const MAX_PROCESS_SCAN = 512;
const TOP_PROCESS_COUNT = 5;
const PROCESS_METRICS = ['cpu', 'memory'];
const ACCENT = '#10a37f';
const METRIC_COLORS = { cpu: '#5b9cf6', memory: '#a78bfa', swap: '#2dd4bf', disk: '#f5b942', network: '#38bdf8',
    battery: '#4ade80', temperature: '#fb923c' };
// CPU and network draw a history sparkline; the others draw a usage bar. Network needs a full-width tile.
const SPARK_METRICS = ['cpu', 'network'];
const WIDE_METRICS = ['network'];
const TILE_GAP = 8;
const TILE_PAD = 10;
const SPARK_BARS = { narrow: 30, wide: 64 };
const CHART_HEIGHT = 16;
const METRIC_ICONS = {
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    memory: '<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 17v3M10 17v3M14 17v3M18 17v3M6 11v2M10 11v2M14 11v2M18 11v2"/>',
    swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    disk: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M5 14l2.5-9h9L19 14"/><path d="M16.5 17h.01"/>',
    network: '<path d="M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/>',
    temperature: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
};
const iconSvg = (body, color = '#ffffff') => '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
    + `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ROUND = 'border-radius: 999px; transition-duration: 120ms;';
const REFRESH_BASE = `width: 28px; height: 28px; ${ROUND}`;
const REFRESH_STYLE = `${REFRESH_BASE} background-color: rgba(255, 255, 255, 0.08); color: rgba(255, 255, 255, 0.8);`;
const REFRESH_HOVER_STYLE = `${REFRESH_BASE} background-color: rgba(255, 255, 255, 0.2); color: white;`;
const REFRESH_BUSY_STYLE = `${REFRESH_BASE} background-color: rgba(16, 163, 127, 0.3); color: white;`;
const STEP_BASE = `width: 24px; height: 24px; ${ROUND} font-weight: bold; color: white;`;
const STEP_STYLE = `${STEP_BASE} background-color: rgba(255, 255, 255, 0.08);`;
const STEP_HOVER_STYLE = `${STEP_BASE} background-color: rgba(255, 255, 255, 0.2);`;
const ENTRY_STYLE = 'width: 38px; height: 24px; min-height: 0; padding: 0 4px; border: none; border-radius: 8px; '
    + 'background-color: rgba(255, 255, 255, 0.1); color: white; text-align: center; font-size: 0.9em;';
const SWITCH_BASE = 'width: 34px; height: 20px; padding: 2px; border-radius: 999px; transition-duration: 120ms;';
const KNOB_STYLE = 'width: 16px; height: 16px; border-radius: 999px; background-color: white;';
const MUTED = 'color: rgba(255, 255, 255, 0.55); font-size: 0.85em;';
const SECTION = 'color: rgba(255, 255, 255, 0.5); font-size: 0.75em; font-weight: bold; letter-spacing: 1px;';
const ROW = 'spacing: 8px; min-height: 32px;';
const GROUP_STYLE = 'background-color: rgba(255, 255, 255, 0.12); border-radius: 999px; padding: 2px 10px; spacing: 10px;';
const SEGMENT_STYLE = 'color: white; font-weight: bold;';
const SEGMENT_ALERT_STYLE = 'color: #ff6b6b; font-weight: bold;';
const tileStyle = hover => `padding: 8px ${TILE_PAD}px; border-radius: 12px; min-width: 0; `
    + `background-color: rgba(255, 255, 255, ${hover ? 0.1 : 0.05}); transition-duration: 120ms;`;

const formatNumber = value => String(Math.round(value * 10) / 10);
const formatSize = kb => kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
const formatRate = kb => kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB/s` : `${kb.toFixed(kb < 10 ? 1 : 0)} KB/s`;
const shortRate = kb => kb >= 1000 ? `${(kb / 1024).toFixed(1)}M` : `${Math.round(kb)}K`;

export default class SuperbarExtension extends Extension {
    enable() {
        this._generation = (this._generation ?? 0) + 1;
        this._disposed = false;
        this._fetchBusy = false;
        this._fetchProcess = null;
        this._fetchTimeout = 0;
        this._spinTimer = 0;
        // Automatic provider refresh backs off after rate limiting; manual refresh ignores these.
        this._rateLimitStreak = 0;
        this._providerNextAt = 0;
        // Per-window alert bookkeeping; see windowAlerts() in model.js.
        this._alertMemo = {};
        // In-memory usage samples per window for the burn-rate projection; not persisted.
        this._paceSamples = {};
        // Free-space samples for the disk time-to-full estimate, and the low-space alert state.
        this._diskSamples = [];
        this._diskEtaSeconds = null;
        this._diskAlert = { alerted: false };
        // Top-consumer panel: which metric it lists (null when closed) and the last CPU baseline.
        this._processMetric = null;
        this._procBaseline = null;
        this._snapshot = null;
        this._settingsOpen = false;
        this._metricTimers = {};
        this._followTimers = {};
        this._metricState = {};
        this._history = {};
        this._switchRenderers = [];
        this._settings = this.getSettings();
        this._indicator = new PanelMenu.Button(0.0, 'Superbar');
        // The stock .panel-button theme paints a highlight and focus box-shadow around the whole
        // indicator on click/focus; the pills already carry their own look, so drop it.
        this._indicator.set_style('background-color: transparent; box-shadow: none; border: none;');
        const layout = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 6px;' });
        const codex = this._panelProvider('codex', 'Codex');
        const claude = this._panelProvider('claude', 'Claude Code');
        layout.add_child(codex.box);
        layout.add_child(claude.box);
        this._indicator.add_child(layout);
        this._pills = { codex, claude };
        // Enabled system metrics share one quiet capsule after the provider pills, so the top bar stays narrow.
        this._systemGroup = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: GROUP_STYLE });
        this._systemPills = {};
        for (const name of SYSTEM_METRICS) {
            const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px;' });
            const label = new St.Label({ text: '—', y_align: Clutter.ActorAlign.CENTER, style: SEGMENT_STYLE });
            box.add_child(this._metricIcon(name, 14));
            box.add_child(label);
            box.visible = this._settings.get_boolean(`show-${name}`);
            this._systemGroup.add_child(box);
            this._systemPills[name] = { box, label };
        }
        layout.add_child(this._systemGroup);
        this._addMenuHeader();
        this._cards = {
            codex: this._addProviderCard('Codex', 'codex'),
            claude: this._addProviderCard('Claude Code', 'claude'),
        };
        this._addSystemCard();
        this._addSettingsScreen();
        // Reset countdowns are computed from the clock, so refresh them whenever the menu opens.
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._snapshot) this._renderSnapshot();
            if (!open && this._settingsOpen) this._showSettings(false);
        });
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => this._applySettings(key));
        this._applySettings();
        if (this._settings.get_boolean('auto-provider-refresh')) this._refresh();
        this._refreshSystem();
    }

    disable() {
        this._disposed = true;
        this._generation++;
        if (this._settingsChangedId) this._settings?.disconnect(this._settingsChangedId);
        this._settingsChangedId = 0;
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        for (const timers of [this._metricTimers, this._followTimers]) {
            for (const id of Object.values(timers ?? {})) if (id) GLib.Source.remove(id);
        }
        this._metricTimers = {};
        this._followTimers = {};
        // Rows hold actors that are destroyed with the menu; a later enable rebuilds them.
        this._tileRows = [];
        this._processBox = null;
        if (this._fetchTimeout) GLib.Source.remove(this._fetchTimeout);
        this._fetchTimeout = 0;
        if (this._spinTimer) GLib.Source.remove(this._spinTimer);
        this._spinTimer = 0;
        for (const proc of [this._fetchProcess]) {
            if (proc) {
                try { proc.force_exit(); } catch (_) { /* process already exited */ }
            }
        }
        this._fetchProcess = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._refreshButton = null;
        this._refreshIcon = null;
        this._headerLabel = null;
    }

    _binary() {
        return GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'superbar']);
    }

    _providerIcon(provider, name, size = 16) {
        const path = GLib.build_filenamev([this.path, 'icons', `ProviderIcon-${provider}.svg`]);
        const file = Gio.File.new_for_path(path);
        return new St.Icon({ gicon: new Gio.FileIcon({ file }), icon_size: size, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: name });
    }

    _metricIcon(name, size = 16, color = undefined) {
        const bytes = GLib.Bytes.new(new TextEncoder().encode(iconSvg(METRIC_ICONS[name], color)));
        return new St.Icon({ gicon: new Gio.BytesIcon({ bytes }), icon_size: size, y_align: Clutter.ActorAlign.CENTER,
            accessible_name: METRIC_TITLES[name] });
    }

    // Round icon button that lights up on hover.
    _roundButton(iconName, accessibleName, onClick, style = REFRESH_STYLE, hoverStyle = REFRESH_HOVER_STYLE) {
        const button = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: accessibleName,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style,
            child: new St.Icon({ icon_name: iconName, icon_size: 14, x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER }),
        });
        button.connect('notify::hover', () => button.set_style(button.hover ? hoverStyle : style));
        button.connect('clicked', onClick);
        return button;
    }

    // Title on the left; settings and refresh buttons on the right. The refresh icon spins while fetching.
    _addMenuHeader() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: `width: ${CARD_WIDTH}px; spacing: 6px;` });
        this._headerLabel = new St.Label({ text: HEADER_TEXT, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; letter-spacing: 0.5px;' });
        const settingsButton = this._roundButton('preferences-system-symbolic', 'Open Superbar settings',
            () => this._showSettings(true));
        this._refreshIcon = new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 14,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER });
        this._refreshIcon.set_pivot_point(0.5, 0.5);
        this._refreshButton = new St.Button({
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: 'Refresh all usage and system metrics now',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            style: REFRESH_STYLE,
            child: this._refreshIcon,
        });
        this._refreshButton.connect('notify::hover', () => this._styleRefreshButton());
        this._refreshButton.connect('clicked', () => this._refreshAll());
        row.add_child(this._headerLabel);
        row.add_child(settingsButton);
        row.add_child(this._refreshButton);
        item.add_child(row);
        this._indicator.menu.addMenuItem(item);
        this._headerItem = item;
    }

    _styleRefreshButton() {
        const hover = this._refreshButton.hover && !this._fetchBusy;
        this._refreshButton.set_style(this._fetchBusy ? REFRESH_BUSY_STYLE : hover ? REFRESH_HOVER_STYLE : REFRESH_STYLE);
    }

    _setBusy(busy) {
        this._fetchBusy = busy;
        if (!this._refreshButton) return;
        this._headerLabel.set_text(busy ? 'Refreshing…' : HEADER_TEXT);
        this._styleRefreshButton();
        if (busy) {
            const spin = () => {
                if (!this._fetchBusy || this._disposed) {
                    this._spinTimer = 0;
                    return GLib.SOURCE_REMOVE;
                }
                this._refreshIcon.rotation_angle_z = 0;
                this._refreshIcon.ease({ rotation_angle_z: 360, duration: 850,
                    mode: Clutter.AnimationMode.LINEAR });
                return GLib.SOURCE_CONTINUE;
            };
            spin();
            this._spinTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, spin);
        } else {
            if (this._spinTimer) GLib.Source.remove(this._spinTimer);
            this._spinTimer = 0;
            this._refreshIcon.remove_all_transitions();
            this._refreshIcon.rotation_angle_z = 0;
        }
    }

    _pillStyle(color) {
        return `background-color: ${color}; border-radius: 999px; padding: 2px 9px 2px 7px; spacing: 5px;`;
    }

    // Provider pills use a provider icon; system pills pass their own icon actor.
    _panelProvider(provider, name, icon = null) {
        const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: this._pillStyle(NEUTRAL) });
        const label = new St.Label({ text: '—', y_align: Clutter.ActorAlign.CENTER,
            style: 'color: white; font-weight: bold;' });
        // A crowded top bar shrinks its children; the provider percentage must never collapse to an ellipsis.
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(icon ?? this._providerIcon(provider, name, 14));
        box.add_child(label);
        return { box, label };
    }

    _addProviderCard(name, provider) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const body = new St.BoxLayout({ vertical: true, style: `width: ${CARD_WIDTH}px; spacing: 10px; padding: 4px 0;` });
        const header = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 8px;' });
        const badge = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${BRAND[provider]}; border-radius: 999px; padding: 6px;` });
        badge.add_child(this._providerIcon(provider, name, 14));
        const titles = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
        titles.add_child(new St.Label({ text: name, style: 'font-weight: bold;' }));
        const synced = new St.Label({ text: 'Not synced yet', style: MUTED });
        titles.add_child(synced);
        const reason = new St.Label({ text: '', style: MUTED, visible: false });
        reason.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titles.add_child(reason);
        const state = new St.Label({ text: 'Offline', y_align: Clutter.ActorAlign.CENTER,
            style: `${MUTED} border-radius: 999px; padding: 1px 8px; background-color: rgba(255, 255, 255, 0.1);` });
        header.add_child(badge);
        header.add_child(titles);
        header.add_child(state);
        const refresh = new St.Button({ child: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 14 }),
            accessible_name: `Refresh ${name} usage`, style: REFRESH_STYLE });
        refresh.connect('clicked', () => this._refresh(provider));
        header.add_child(refresh);
        body.add_child(header);
        const primary = this._addUsageRow(body, '5-hour');
        const secondary = this._addUsageRow(body, 'Weekly');
        item.add_child(body);
        this._indicator.menu.addMenuItem(item);
        return { color: BRAND[provider], synced, reason, state, primary, secondary, item };
    }

    // Title, reset countdown and percentage share one line above the bar.
    _addUsageRow(parent, title) {
        const row = new St.BoxLayout({ vertical: true, style: 'spacing: 6px;' });
        const top = new St.BoxLayout({ style: 'spacing: 8px;' });
        top.add_child(new St.Label({ text: title, y_align: Clutter.ActorAlign.CENTER }));
        const reset = new St.Label({ text: '', x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: MUTED });
        top.add_child(reset);
        const percent = new St.Label({ text: '—', y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: bold;' });
        top.add_child(percent);
        const track = new St.BoxLayout({
            style: `width: ${CARD_WIDTH}px; height: 6px; border-radius: 3px; background-color: rgba(255, 255, 255, 0.14);`,
        });
        const fill = new St.Widget({ y_expand: true });
        track.add_child(fill);
        // The burn-rate line appears only after enough history; it stays hidden until then.
        const pace = new St.Label({ text: '', style: MUTED, visible: false });
        row.add_child(top);
        row.add_child(track);
        row.add_child(pace);
        parent.add_child(row);
        return { percent, fill, reset, pace };
    }

    // The timer ticks at the base interval; after rate limiting, ticks before the backoff deadline are skipped.
    _scheduleProviderTimer() {
        if (this._timer) GLib.Source.remove(this._timer);
        this._timer = 0;
        if (!this._settings.get_boolean('auto-provider-refresh')) return;
        const seconds = this._providerBaseSeconds();
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            // A one-second allowance keeps a tick that lands just before the deadline from being skipped.
            if (!this._disposed && Date.now() + 1000 >= this._providerNextAt) this._refresh('all');
            return this._disposed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
        });
    }

    _providerBaseSeconds() {
        return Math.round(this._settings.get_double('provider-interval')) || POLL_SECONDS;
    }

    // Called after each full refresh (both providers, from the timer or the header button) that produced a
    // snapshot. A full refresh without rate limiting resets the backoff; per-provider refreshes do not count.
    _recordFullRefresh(snapshot, startedAt) {
        this._rateLimitStreak = nextRateLimitStreak(this._rateLimitStreak, snapshot);
        this._providerNextAt = this._rateLimitStreak > 0
            ? startedAt + providerBackoffSeconds(this._providerBaseSeconds(), this._rateLimitStreak) * 1000 : 0;
    }

    // Each system metric polls on its own interval. Reads are tiny /proc and /sys files, so no subprocess is needed.
    _scheduleMetric(name) {
        if (this._metricTimers[name]) GLib.Source.remove(this._metricTimers[name]);
        this._metricTimers[name] = 0;
        if (!this._settings.get_boolean(`show-${name}`) || !this._settings.get_boolean('auto-system-refresh')) return;
        const seconds = Math.max(1, Math.round(this._settings.get_double(`${name}-interval`)));
        this._metricTimers[name] = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            if (!this._disposed) this._sampleMetric(name);
            return this._disposed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
        });
    }

    _refreshAll() {
        this._refresh('all');
        this._refreshSystem();
    }

    _refreshSystem(requestedMetric = null) {
        for (const name of SYSTEM_METRICS) {
            if (requestedMetric === null || requestedMetric === name) this._sampleMetric(name);
        }
    }

    _readFile(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes) : '';
        } catch (_) {
            return '';
        }
    }

    _sampleMetric(name) {
        if (this._disposed || !this._settings.get_boolean(`show-${name}`)) return;
        const hadBaseline = this._metricState[name] !== undefined;
        let result = null;
        try {
            result = this._readMetric(name, Date.now());
        } catch (_) { /* metrics are optional */ }
        if (!result) result = { value: 'unavailable', short: '—', alert: false };
        if (name === 'disk' && Number.isFinite(result.percent)) this._checkDiskAlert(result.percent);
        if (this._processMetric === name) this._renderProcesses(name);
        const tile = this._tiles[name];
        tile.value.set_text(result.value);
        tile.detail.set_text(result.detail ?? METRIC_TITLES[name]);
        this._renderChart(name, result);
        const pill = this._systemPills[name];
        pill.label.set_text(result.short);
        pill.label.set_style(result.alert ? SEGMENT_ALERT_STYLE : SEGMENT_STYLE);
        // A rate needs two readings; take the second one soon instead of waiting a whole interval.
        if (RATE_METRICS.includes(name) && !hadBaseline && this._metricState[name] !== undefined && !this._followTimers[name]) {
            this._followTimers[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                this._followTimers[name] = 0;
                this._sampleMetric(name);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Returns the tile value and caption, the short top-bar text, the bar or sparkline level (`percent`, or
    // `level` for unbounded rates) and whether the value deserves the alert colour.
    _checkDiskAlert(usedPct) {
        const threshold = this._settings.get_int('disk-alert-percent');
        const message = diskAlertMessage(this._diskAlert, usedPct, threshold, fullInText(this._diskEtaSeconds));
        if (message) this._notify(message);
    }

    _readMetric(name, now) {
        const percent = value => ({ value: `${value}%`, short: `${value}%`, percent: value, alert: value >= 90 });
        switch (name) {
        case 'cpu': {
            const stat = this._readFile('/proc/stat').split('\n')[0].split(/\s+/).slice(1).map(Number);
            if (stat.length < 4) return null;
            const idle = stat[3] + (stat[4] ?? 0), sum = stat.reduce((a, b) => a + b, 0), prev = this._metricState.cpu;
            this._metricState.cpu = { idle, sum };
            if (!prev || sum <= prev.sum) return { value: 'sampling…', short: '…', alert: false };
            return percent(Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (sum - prev.sum))))));
        }
        case 'memory':
        case 'swap': {
            const mem = Object.fromEntries(this._readFile('/proc/meminfo').split('\n').map(line => line.split(/\s+/)));
            const kb = key => Number(mem[key] ?? 0);
            const [total, free] = name === 'memory' ? [kb('MemTotal:'), kb('MemAvailable:')] : [kb('SwapTotal:'), kb('SwapFree:')];
            if (total <= 0) return { value: 'none', short: '—', alert: false };
            const used = Math.round(100 * (total - free) / total);
            return { value: formatSize(total - free), detail: `of ${formatSize(total)}`, short: `${used}%`, percent: used,
                alert: used >= 90 };
        }
        case 'disk': {
            const info = Gio.File.new_for_path('/').query_filesystem_info('filesystem::size,filesystem::free', null);
            const size = Number(info.get_attribute_uint64('filesystem::size'));
            const free = Number(info.get_attribute_uint64('filesystem::free'));
            if (!(size > 0)) return null;
            const used = Math.round(100 * (size - free) / size);
            // Recent free-space samples give a fill-rate estimate; the caption shows it when there is enough history.
            const samples = this._diskSamples;
            samples.push({ t: now, free });
            if (samples.length > MAX_PACE_SAMPLES) samples.shift();
            this._diskEtaSeconds = timeToFullSeconds(samples, now);
            const eta = fullInText(this._diskEtaSeconds);
            return { value: `${used}%`, detail: [`${formatSize(free / 1024)} free`, eta].filter(Boolean).join(' · '),
                short: `${used}%`, percent: used, alert: used >= this._settings.get_int('disk-alert-percent') };
        }
        case 'battery': {
            for (const battery of ['BAT0', 'BAT1']) {
                const base = `/sys/class/power_supply/${battery}`;
                const text = this._readFile(`${base}/capacity`).trim();
                const level = Number(text);
                if (!text || !Number.isFinite(level)) continue;
                const status = this._readFile(`${base}/status`).trim();
                // Time remaining comes from the same sysfs files; no subprocess is needed.
                const readings = { status };
                for (const file of ['energy_now', 'energy_full', 'power_now', 'charge_now', 'charge_full', 'current_now']) {
                    const raw = this._readFile(`${base}/${file}`).trim();
                    readings[file] = raw === '' ? undefined : Number(raw);
                }
                const time = batteryTimeText(readings);
                return { value: `${level}%`, detail: [status, time].filter(Boolean).join(' · ') || undefined, short: `${level}%`,
                    percent: level, alert: level <= 15 && status !== 'Charging' };
            }
            return { value: 'unavailable', short: '—', alert: false };
        }
        case 'temperature': {
            let hottest = null;
            for (let zone = 0; zone < THERMAL_ZONES; zone++) {
                const text = this._readFile(`/sys/class/thermal/thermal_zone${zone}/temp`).trim();
                const milli = Number(text);
                if (text && Number.isFinite(milli) && (hottest === null || milli > hottest)) hottest = milli;
            }
            if (hottest === null) return { value: 'unavailable', short: '—', alert: false };
            return { value: `${(hottest / 1000).toFixed(1)} °C`, short: `${Math.round(hottest / 1000)}°`,
                percent: Math.max(0, Math.min(100, hottest / 1000)), alert: hottest >= 85000 };
        }
        case 'network': {
            // Sum every physical interface so an idle virtual one cannot hide the real traffic.
            let rx = 0, tx = 0;
            for (const line of this._readFile('/proc/net/dev').split('\n').filter(l => l.includes(':'))) {
                const [iface, rest] = line.split(':');
                if (VIRTUAL_IFACE.test(iface.trim())) continue;
                const values = rest.trim().split(/\s+/).map(Number);
                if (values.length >= 9) { rx += values[0]; tx += values[8]; }
            }
            const prev = this._metricState.network;
            this._metricState.network = { rx, tx, time: now };
            if (!prev || now <= prev.time) return { value: 'sampling…', short: '…', alert: false };
            const down = Math.max(0, (rx - prev.rx) * 1000 / (now - prev.time) / 1024);
            const up = Math.max(0, (tx - prev.tx) * 1000 / (now - prev.time) / 1024);
            return { value: `↓ ${formatRate(down)}`, detail: `↑ ${formatRate(up)}`, short: `↓${shortRate(down)} ↑${shortRate(up)}`,
                level: down + up, alert: false };
        }
        default:
            return null;
        }
    }

    // System metrics are tiles in a two-column grid: icon, value and caption, then a bar or sparkline.
    // Clicking a tile refreshes that metric.
    _addSystemCard() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._systemBody = new St.BoxLayout({ vertical: true,
            x_expand: true, style: `min-width: ${CARD_WIDTH}px; spacing: ${TILE_GAP}px; padding: 6px 0;` });
        this._tiles = {};
        for (const name of SYSTEM_METRICS) this._tiles[name] = this._metricTile(name);
        this._processBox = new St.BoxLayout({ vertical: true, x_expand: true, visible: false, style: 'spacing: 4px; padding: 4px 0;' });
        item.add_child(this._systemBody);
        this._indicator.menu.addMenuItem(item);
        this._systemItem = item;
    }

    _metricTile(name) {
        const wide = WIDE_METRICS.includes(name);
        const color = METRIC_COLORS[name];
        const box = new St.BoxLayout({ vertical: true, x_expand: true, style: 'spacing: 8px;' });
        const top = new St.BoxLayout({ style: 'spacing: 6px;' });
        top.add_child(this._metricIcon(name, 14, color));
        const value = new St.Label({ text: '—', y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: bold;' });
        const detail = new St.Label({ text: METRIC_TITLES[name], x_expand: true, x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER, style: MUTED });
        top.add_child(value);
        top.add_child(detail);
        box.add_child(top);
        const tile = { wide, value, detail, bars: null, fill: null, percent: 0 };
        for (const label of [value, detail]) label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        if (SPARK_METRICS.includes(name)) {
            const chart = new St.BoxLayout({ x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END,
                style: `height: ${CHART_HEIGHT}px; spacing: 1px;` });
            chart.layout_manager.homogeneous = true; // bars share whatever width the tile gets
            const count = wide ? SPARK_BARS.wide : SPARK_BARS.narrow;
            tile.bars = Array.from({ length: count }, (_, index) => {
                const bar = new St.Widget({ x_expand: true, y_align: Clutter.ActorAlign.END });
                bar.opacity = Math.round(110 + 145 * index / Math.max(1, count - 1)); // older samples fade out
                bar.set_height(1);
                chart.add_child(bar);
                return bar;
            });
            box.add_child(chart);
        } else {
            const track = new St.BoxLayout({ x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.END,
                style: 'height: 5px; border-radius: 3px; background-color: rgba(255, 255, 255, 0.12);' });
            tile.fill = new St.Widget({ y_expand: true });
            tile.fill.set_width(0);
            track.add_child(tile.fill);
            track.connect('notify::allocation', () => this._sizeFill(tile.fill, track, tile.percent));
            box.add_child(track);
        }
        tile.button = new St.Button({ child: box, reactive: true, can_focus: true, track_hover: true,
            accessible_name: `Refresh ${METRIC_TITLES[name]}`, x_expand: true, style: tileStyle(false) });
        tile.button.connect('notify::hover', () => tile.button.set_style(tileStyle(tile.button.hover)));
        tile.track = box.get_last_child();
        tile.button.connect('clicked', () => {
            if (PROCESS_METRICS.includes(name)) this._toggleProcesses(name);
            this._refreshSystem(name);
        });
        return tile;
    }

    // Clicking the CPU or memory tile opens a list of its top processes; clicking the same tile closes it.
    _toggleProcesses(name) {
        this._processMetric = this._processMetric === name ? null : name;
        this._procBaseline = null; // a CPU list starts a fresh baseline when it opens
        this._processBox.visible = this._processMetric !== null;
        this._processBox.remove_all_children();
    }

    _renderProcesses(metric) {
        const box = this._processBox;
        box.remove_all_children();
        box.add_child(new St.Label({ text: `TOP PROCESSES · ${METRIC_TITLES[metric].toUpperCase()}`, style: SECTION }));
        const rows = this._topProcesses(metric);
        if (rows === null) {
            box.add_child(new St.Label({ text: 'sampling…', style: MUTED }));
            return;
        }
        for (const row of rows) {
            const line = new St.BoxLayout({ style: 'spacing: 8px;' });
            const name = new St.Label({ text: row.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
            name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            line.add_child(name);
            line.add_child(new St.Label({ text: row.text, y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: bold;' }));
            box.add_child(line);
        }
        if (rows.length === 0) box.add_child(new St.Label({ text: 'no processes', style: MUTED }));
    }

    // Reads at most MAX_PROCESS_SCAN processes from /proc (no subprocess). Returns null while CPU needs a baseline.
    _topProcesses(metric) {
        const pids = this._listPids();
        const total = this._readFile('/proc/stat').split('\n')[0].split(/\s+/).slice(1).map(Number)
            .reduce((a, b) => a + b, 0);
        const baseline = metric === 'cpu' ? this._procBaseline : null;
        const ticks = new Map();
        const entries = [];
        for (const pid of pids) {
            if (metric === 'cpu') {
                const info = parseProcStat(this._readFile(`/proc/${pid}/stat`));
                if (!info) continue;
                ticks.set(pid, info.ticks);
                const value = baseline ? processCpuPercent(info.ticks, baseline.ticks.get(pid), total, baseline.total) : null;
                entries.push({ name: info.name, value, text: value === null ? '—' : `${value}%` });
            } else {
                const kb = parseVmRssKb(this._readFile(`/proc/${pid}/status`));
                if (kb === null) continue;
                const name = this._readFile(`/proc/${pid}/comm`).trim() || pid;
                entries.push({ name, value: kb, text: formatSize(kb) });
            }
        }
        if (metric === 'cpu') {
            this._procBaseline = { total, ticks };
            if (!baseline) return null;
        }
        return topEntries(entries, TOP_PROCESS_COUNT);
    }

    _listPids() {
        const pids = [];
        let dir;
        try {
            dir = GLib.Dir.open('/proc', 0);
        } catch (_) {
            return pids;
        }
        for (let seen = 0; seen < MAX_PROCESS_SCAN * 4 && pids.length < MAX_PROCESS_SCAN; seen++) {
            const name = dir.read_name();
            if (name === null) break;
            if (/^\d+$/.test(name)) pids.push(name);
        }
        return pids;
    }

    // Packs the enabled tiles two per row; a wide tile takes a row of its own.
    _layoutTiles() {
        if (this._disposed) return;
        for (const row of this._tileRows ?? []) row.remove_all_children();
        this._systemBody.remove_all_children();
        this._tileRows = [];
        let row = null, slots = 0;
        for (const name of SYSTEM_METRICS) {
            if (!this._settings.get_boolean(`show-${name}`)) continue;
            const tile = this._tiles[name];
            const need = tile.wide ? 2 : 1;
            if (!row || slots + need > 2) {
                row = new St.BoxLayout({ x_expand: true, style: `spacing: ${TILE_GAP}px;` });
                row.layout_manager.homogeneous = true; // columns stay equal at any font size
                this._systemBody.add_child(row);
                this._tileRows.push(row);
                slots = 0;
            }
            row.add_child(tile.button);
            slots += need;
        }
        // A lone tile keeps half width instead of stretching across the row.
        if (row && slots === 1) row.add_child(new St.Widget({ x_expand: true }));
        // The top-consumer panel sits below the tiles; it was removed with them above.
        if (this._processBox) this._systemBody.add_child(this._processBox);
    }

    // Bars fill a share of whatever width their track was allocated.
    _sizeFill(fill, track, percent) {
        const total = track.get_width();
        const width = percent <= 0 ? 0 : Math.max(4, Math.round(total * percent / 100));
        if (fill.width !== width) fill.set_width(width);
    }

    _renderChart(name, result) {
        const tile = this._tiles[name];
        const color = result.alert ? ALERT : METRIC_COLORS[name];
        if (!tile.bars) {
            const value = Number.isFinite(result.percent) ? result.percent : 0;
            tile.percent = value;
            this._sizeFill(tile.fill, tile.track, value);
            tile.fill.set_style(`background-color: ${color}; border-radius: 3px;`);
            return;
        }
        const history = this._history[name] ??= [];
        const level = result.level ?? result.percent;
        if (Number.isFinite(level)) {
            history.push(level);
            if (history.length > tile.bars.length) history.shift();
        }
        // Rates have no fixed ceiling, so they scale to the busiest sample on screen.
        const scale = Number.isFinite(result.level) ? Math.max(1, ...history) : 100;
        const offset = tile.bars.length - history.length;
        tile.bars.forEach((bar, index) => {
            const sample = history[index - offset];
            bar.set_height(sample === undefined ? 1 : Math.max(1, Math.round(CHART_HEIGHT * sample / scale)));
            bar.set_style(`border-radius: 1px; background-color: ${color};`);
        });
    }

    // Small on/off switch bound to one boolean setting.
    _settingSwitch(key, accessibleName) {
        const knob = new St.Widget({ x_expand: true, y_align: Clutter.ActorAlign.CENTER, style: KNOB_STYLE });
        const track = new St.BoxLayout({ style: SWITCH_BASE });
        track.add_child(knob);
        const button = new St.Button({ child: track, can_focus: true, reactive: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: accessibleName });
        const render = () => {
            const on = this._settings.get_boolean(key);
            track.set_style(`${SWITCH_BASE} background-color: ${on ? ACCENT : 'rgba(255, 255, 255, 0.2)'};`);
            knob.x_align = on ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
        };
        button.connect('clicked', () => {
            this._settings.set_boolean(key, !this._settings.get_boolean(key));
            render();
        });
        this._switchRenderers.push(render);
        render();
        return button;
    }

    // Interval editor: minus, typed value, plus, and a unit button that flips between seconds and minutes.
    _intervalControl(key, min) {
        const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: 'spacing: 4px;' });
        const stepButton = (label, accessibleName) => {
            const button = new St.Button({ label, can_focus: true, reactive: true, track_hover: true,
                accessible_name: accessibleName, y_align: Clutter.ActorAlign.CENTER, style: STEP_STYLE });
            button.connect('notify::hover', () => button.set_style(button.hover ? STEP_HOVER_STYLE : STEP_STYLE));
            return button;
        };
        const minus = stepButton('−', 'Decrease interval');
        const plus = stepButton('+', 'Increase interval');
        const unit = stepButton('s', 'Switch between seconds and minutes');
        const entry = new St.Entry({ can_focus: true, reactive: true, style: ENTRY_STYLE, accessible_name: 'Interval' });
        const seconds = () => this._settings.get_double(key);
        const perUnit = () => unit.label === 'm' ? 60 : 1;
        const render = () => entry.set_text(formatNumber(seconds() / perUnit()));
        const commit = value => {
            if (!Number.isFinite(value)) { render(); return; }
            this._settings.set_double(key, Math.max(min, Math.min(MAX_INTERVAL, Math.round(value))));
            render();
        };
        const initial = seconds();
        unit.label = initial >= 60 && initial % 60 === 0 ? 'm' : 's';
        minus.connect('clicked', () => commit(seconds() - perUnit()));
        plus.connect('clicked', () => commit(seconds() + perUnit()));
        unit.connect('clicked', () => { unit.label = unit.label === 'm' ? 's' : 'm'; render(); });
        const typed = () => commit(parseFloat(entry.get_text()) * perUnit());
        entry.clutter_text.connect('activate', typed);
        entry.clutter_text.connect('key-focus-out', typed);
        render();
        for (const child of [minus, entry, plus, unit]) box.add_child(child);
        return { box, minus, plus, unit, entry };
    }

    _settingsRow(parent, { icon, title, showKey, intervalKey, min = 1, caption = false }) {
        const row = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: ROW });
        if (icon) { icon.opacity = 200; row.add_child(icon); }
        row.add_child(new St.Label({ text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: caption ? SECTION : '' }));
        const control = intervalKey ? this._intervalControl(intervalKey, min) : null;
        if (control) row.add_child(control.box);
        if (showKey) row.add_child(this._settingSwitch(showKey, title));
        parent.add_child(row);
        return { row, control };
    }

    // The settings screen lives in the same popup; the back button returns to the usage view.
    _addSettingsScreen() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const header = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER, style: `width: ${CARD_WIDTH}px; spacing: 10px;` });
        header.add_child(this._roundButton('go-previous-symbolic', 'Back to usage', () => this._showSettings(false)));
        header.add_child(new St.Label({ text: 'Settings', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style: 'font-weight: bold; letter-spacing: 0.5px;' }));
        headerItem.add_child(header);
        this._indicator.menu.addMenuItem(headerItem);

        const bodyItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const body = new St.BoxLayout({ vertical: true, style: `width: ${CARD_WIDTH}px; spacing: 6px; padding: 6px 0;` });
        this._settingsRows = {};
        this._settingsRow(body, { title: 'USAGE', caption: true });
        this._settingsRows.codex = this._settingsRow(body, { icon: this._providerIcon('codex', 'Codex', 16), title: 'Codex', showKey: 'show-codex' });
        this._settingsRows.claude = this._settingsRow(body, { icon: this._providerIcon('claude', 'Claude Code', 16), title: 'Claude Code', showKey: 'show-claude' });
        this._settingsRows.displayRemaining = this._settingsRow(body, {
            icon: new St.Icon({ icon_name: 'view-list-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER }),
            title: 'Show remaining usage (off = show used)', showKey: 'show-remaining' });
        this._settingsRows.usageRefresh = this._settingsRow(body, {
            icon: new St.Icon({ icon_name: 'view-refresh-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER }),
            title: 'Auto-refresh', showKey: 'auto-provider-refresh', intervalKey: 'provider-interval', min: 60 });
        this._settingsRows.alerts = this._settingsRow(body, {
            icon: new St.Icon({ icon_name: 'dialog-information-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER }),
            title: 'Usage and disk alerts', showKey: 'notify-thresholds' });
        body.add_child(new St.Widget({ style: 'height: 1px; background-color: rgba(255, 255, 255, 0.1); margin: 6px 0;' }));
        this._settingsRows.system = this._settingsRow(body, { title: 'SYSTEM · AUTO-REFRESH', caption: true,
            showKey: 'auto-system-refresh' });
        for (const name of SYSTEM_METRICS) {
            this._settingsRows[name] = this._settingsRow(body, { icon: this._metricIcon(name, 16),
                title: METRIC_TITLES[name], showKey: `show-${name}`, intervalKey: `${name}-interval` });
        }
        bodyItem.add_child(body);
        this._indicator.menu.addMenuItem(bodyItem);
        this._settingsItems = [headerItem, bodyItem];
    }

    _showSettings(open) {
        this._settingsOpen = open;
        if (open) for (const render of this._switchRenderers) render();
        this._syncVisibility();
    }

    // Exactly one screen is visible: usage (header, provider cards, metrics) or settings.
    _syncVisibility() {
        const main = !this._settingsOpen;
        this._headerItem.visible = main;
        for (const provider of ['codex', 'claude'])
            this._cards[provider].item.visible = main && this._settings.get_boolean(`show-${provider}`);
        this._systemItem.visible = main && SYSTEM_METRICS.some(name => this._settings.get_boolean(`show-${name}`));
        for (const item of this._settingsItems) item.visible = !main;
    }

    // `key` is the changed setting, or null to apply everything (startup).
    _applySettings(key = null) {
        if (!this._settings || !this._pills || !this._cards) return;
        for (const provider of ['codex', 'claude'])
            this._pills[provider].box.visible = this._settings.get_boolean(`show-${provider}`);
        for (const name of SYSTEM_METRICS) {
            const visible = this._settings.get_boolean(`show-${name}`);
            this._systemPills[name].box.visible = visible;
            if (!visible) { // re-enabling starts a fresh baseline and an empty sparkline
                delete this._metricState[name];
                delete this._history[name];
                if (name === 'disk') this._diskSamples = [];
                if (this._processMetric === name) this._toggleProcesses(name);
            }
        }
        this._systemGroup.visible = SYSTEM_METRICS.some(name => this._settings.get_boolean(`show-${name}`));
        this._layoutTiles();
        this._syncVisibility();
        const changed = SYSTEM_METRICS.filter(name => key === null || key === 'auto-system-refresh'
            || key === `show-${name}` || key === `${name}-interval`);
        for (const name of changed) {
            this._scheduleMetric(name);
            if (key === `show-${name}`) this._sampleMetric(name);
        }
        // The usage display mode changes every provider percentage, so the view is redrawn from the last snapshot.
        if ((key === null || key === 'show-remaining') && this._snapshot) this._renderSnapshot();
        if (key === null || key === 'auto-provider-refresh' || key === 'provider-interval')
            this._scheduleProviderTimer();
    }

    // The bar fills with the amount shown (remaining or used); the colour always follows used percent.
    _updateUsageRow(row, window, color, nowMs, pace = '', mode = 'remaining') {
        row.pace.set_text(pace);
        row.pace.visible = pace !== '';
        const value = usedPercent(window, nowMs);
        const shown = displayPercent(value, mode);
        row.percent.set_text(windowUsageText(window, nowMs, mode));
        const width = shown === null || shown === 0 ? 0 : Math.max(4, Math.round(CARD_WIDTH * shown / 100));
        row.fill.set_width(width);
        row.fill.set_style(`background-color: ${usageLevel(value) === 'high' ? ALERT : color}; border-radius: 3px;`);
        if (window && windowExpired(window, nowMs)) {
            row.reset.set_text('↻ reset passed · awaiting data');
            return;
        }
        const clock = window ? resetClock(window.reset_at, nowMs) : '';
        const countdown = window ? resetCountdown(window.reset_at, nowMs).replace(/^resets in /, '') : '';
        row.reset.set_text(window ? `↻ ${countdown}${clock ? ` · ${clock}` : ''}` : '');
    }

    _refresh(provider = 'all') {
        if (this._fetchBusy || this._disposed) return;
        this._setBusy(true);
        const generation = this._generation;
        const startedAt = Date.now();
        let proc;
        try {
            proc = Gio.Subprocess.new([this._binary(), 'fetch', '--provider', provider, '--format', 'json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_) {
            this._setBusy(false);
            this._markRefreshFailure('failed');
            return;
        }
        this._fetchProcess = proc;
        const stream = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
        const chunks = [];
        let size = 0;
        let finished = false;
        // `failure` is null on success, otherwise the kind passed to _markRefreshFailure.
        const finish = (text, failure) => {
            if (finished) return;
            finished = true;
            if (generation !== this._generation) return;
            if (this._fetchTimeout) GLib.Source.remove(this._fetchTimeout);
            this._fetchTimeout = 0;
            this._fetchProcess = null;
            this._setBusy(false);
            if (failure) {
                this._markRefreshFailure(failure);
                return;
            }
            try {
                const data = JSON.parse(text);
                if (!isSnapshot(data))
                    throw new Error('Unsupported snapshot schema');
                this._applySnapshot(data, provider === 'all' ? startedAt : null);
            } catch (_) {
                this._markRefreshFailure('failed');
            }
        };
        const waitForExit = () => proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (_) {
                finish(null, 'failed');
                return;
            }
            if (!p.get_if_exited() || p.get_exit_status() !== 0) {
                finish(null, p.get_exit_status() === LOCK_BUSY_EXIT ? 'lock_busy' : 'failed');
                return;
            }
            const output = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                output.set(chunk, offset);
                offset += chunk.length;
            }
            finish(new TextDecoder().decode(output), null);
        });
        const readNext = () => stream.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, null, (s, result) => {
            try {
                const bytes = s.read_bytes_finish(result).get_data();
                if (!bytes || bytes.length === 0) {
                    waitForExit();
                    return;
                }
                size += bytes.length;
                if (size > MAX_OUTPUT) {
                    try { proc.force_exit(); } catch (_) { /* exited */ }
                    finish(null, 'failed');
                    return;
                }
                chunks.push(bytes);
                readNext();
            } catch (_) {
                try { proc.force_exit(); } catch (_) { /* exited */ }
                finish(null, 'failed');
            }
        });
        this._fetchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FETCH_TIMEOUT_MS, () => {
            this._fetchTimeout = 0;
            try { proc.force_exit(); } catch (_) { /* exited */ }
            finish(null, 'timeout');
            return GLib.SOURCE_REMOVE;
        });
        readNext();
    }

    // Stores a fetched snapshot and updates what derives from it: backoff, alerts and the rendered view.
    // `fullRefreshStartedAt` is the start time of a full refresh, or null for a single-provider refresh.
    _applySnapshot(data, fullRefreshStartedAt = null) {
        this._snapshot = data;
        if (fullRefreshStartedAt !== null) this._recordFullRefresh(data, fullRefreshStartedAt);
        this._recordPaceSamples(data, Date.now());
        this._evaluateAlerts(data);
        this._renderSnapshot();
    }

    _recordPaceSamples(snapshot, now) {
        for (const provider of ['codex', 'claude']) {
            const data = snapshot.providers[provider];
            if (data.state !== 'fresh') continue;
            for (const kind of ['primary', 'secondary']) {
                const window = data.windows[kind];
                if (!window || typeof window.reset_at !== 'string') continue;
                const samples = this._paceSamples[`${provider}/${kind}`] ??= [];
                samples.push({ t: now, percent: window.used_percent, resetAt: window.reset_at });
                if (samples.length > MAX_PACE_SAMPLES) samples.shift();
            }
        }
    }

    // 'remaining' (the default) or 'used', from the show-remaining setting.
    _displayMode() {
        return this._settings.get_boolean('show-remaining') ? 'remaining' : 'used';
    }

    _pace(provider, kind, window) {
        return window ? paceText(paceProjection(this._paceSamples[`${provider}/${kind}`], window.reset_at)) : '';
    }

    // Only fresh data alerts, so old carried-forward values never raise a notification.
    _evaluateAlerts(snapshot) {
        const now = Date.now();
        for (const provider of ['codex', 'claude']) {
            const data = snapshot.providers[provider];
            if (data.state !== 'fresh') continue;
            for (const kind of ['primary', 'secondary']) {
                const window = data.windows[kind];
                if (!window) continue;
                const label = `${provider === 'codex' ? 'Codex' : 'Claude Code'} ${window.label}`;
                for (const message of windowAlerts(this._alertMemo, `${provider}/${kind}`, label, window, now, this._displayMode()))
                    this._notify(message);
            }
        }
    }

    _notify(message) {
        if (!this._settings.get_boolean('notify-thresholds')) return;
        Main.notify('Superbar', message);
    }

    _markRefreshFailure(kind = 'failed') {
        this._headerLabel?.set_text(refreshFailureText(kind));
        if (!this._snapshot) {
            for (const pill of Object.values(this._pills)) {
                pill.label.set_text('—');
                pill.box.set_style(this._pillStyle(NEUTRAL));
            }
            return;
        }
        // Keep the last successful values visible; the failure marker is distinct from provider stale state.
        this._renderSnapshot();
        for (const pill of Object.values(this._pills))
            pill.label.set_text(`${pill.label.get_text()} !`);
    }

    _renderSnapshot() {
        const nowMs = Date.now();
        const mode = this._displayMode();
        for (const provider of ['codex', 'claude']) {
            const data = this._snapshot.providers[provider];
            const pill = this._pills[provider];
            const card = this._cards[provider];
            // The pill text and colour both use the peak of the windows, so they always agree.
            const level = usageLevel(peakPercent(data, nowMs));
            const color = level === 'unknown' || data.state === 'unavailable' ? NEUTRAL
                : level === 'high' ? ALERT : BRAND[provider];
            pill.label.set_text(pillText(data, nowMs, mode));
            pill.box.set_style(this._pillStyle(color));
            pill.box.opacity = data.state === 'stale' ? 170 : 255;
            const expiry = tokenExpiryText(data, nowMs);
            card.synced.set_text(expiry ? `${syncedText(data)} · ${expiry}` : syncedText(data));
            card.state.set_text(stateText(data));
            const reason = errorReason(data, provider);
            card.reason.set_text(reason ? `${reason.code}: ${reason.hint}` : '');
            card.reason.visible = reason !== null;
            this._updateUsageRow(card.primary, data.windows.primary, card.color, nowMs,
                this._pace(provider, 'primary', data.windows.primary), mode);
            this._updateUsageRow(card.secondary, data.windows.secondary, card.color, nowMs,
                this._pace(provider, 'secondary', data.windows.secondary), mode);
        }
    }

}
