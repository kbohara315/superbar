import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class SuperbarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({ title: 'Superbar', icon_name: 'preferences-system-symbolic' });
        const display = new Adw.PreferencesGroup({ title: 'Show in menu' });
        for (const [key, title] of [
            ['show-codex', 'Codex usage'], ['show-claude', 'Claude Code usage'],
            ['show-cpu', 'CPU usage'], ['show-memory', 'Memory usage'], ['show-swap', 'Swap usage'],
            ['show-disk', 'Disk usage'], ['show-network', 'Network rate'],
            ['show-battery', 'Battery status'], ['show-temperature', 'Temperature'],
        ]) {
            const row = new Adw.SwitchRow({ title });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            display.add(row);
        }
        const usage = new Adw.PreferencesGroup({ title: 'Usage' });
        const remaining = new Adw.SwitchRow({ title: 'Show remaining usage (off = show used)', subtitle: 'Applies to Codex and Claude Code percentages, bars and alerts' });
        settings.bind('show-remaining', remaining, 'active', Gio.SettingsBindFlags.DEFAULT);
        usage.add(remaining);
        const refresh = new Adw.PreferencesGroup({ title: 'Refresh' });
        for (const [key, title] of [['auto-provider-refresh', 'Refresh provider usage automatically'], ['auto-system-refresh', 'Refresh system metrics automatically']]) {
            const row = new Adw.SwitchRow({ title });
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            refresh.add(row);
        }
        const intervals = [['provider-interval', 'Usage interval (seconds)', 60]];
        for (const name of ['cpu', 'memory', 'swap', 'disk', 'network', 'battery', 'temperature'])
            intervals.push([`${name}-interval`, `${name[0].toUpperCase()}${name.slice(1)} interval (seconds)`, 1]);
        for (const [key, title, lower] of intervals) {
            const row = new Adw.SpinRow({ title, adjustment: new Gtk.Adjustment({ lower, upper: 3600, step_increment: 1, page_increment: 10 }) });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT); refresh.add(row);
        }
        const alerts = new Adw.PreferencesGroup({ title: 'Alerts' });
        const notify = new Adw.SwitchRow({ title: 'Usage and disk notifications', subtitle: 'Usage at 80% or 90%, window resets, and disk space low' });
        settings.bind('notify-thresholds', notify, 'active', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(notify);
        const disk = new Adw.SpinRow({ title: 'Disk alert threshold (percent used)', adjustment: new Gtk.Adjustment({ lower: 50, upper: 99, step_increment: 1, page_increment: 5 }) });
        settings.bind('disk-alert-percent', disk, 'value', Gio.SettingsBindFlags.DEFAULT);
        alerts.add(disk);
        page.add(display); page.add(usage); page.add(refresh); page.add(alerts); window.add(page);
    }
}
