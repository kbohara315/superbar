// Superbar on nsh: a tray-resident app. The tray icon shows the provider pills; its menu and a click open the dashboard,
// a popup window of the app's own. Production wiring lives here: the real providers, metric samplers, notifications
// and the settings file in ${dataDir}. Everything else is in src/ and is tested with fakes.

import process from "process";
import { mount, Notifications, Text, View } from "nsh";
import { isAvailable, Window, windowState } from "nsh/desktop";
import * as providers from "./src/providers";
import { MetricsSampler } from "./src/metrics";
import { Controller } from "./src/controller";
import type { ControllerDeps } from "./src/controller";
import { installTray, nshTrayPort } from "./src/tray";
import { settingsStore } from "./src/store";
import { Dashboard } from "./src/ui/Dashboard";
import { createDashboardWindows, startTray } from "./src/windows";

const APP_NAME = "Superbar";
const DASHBOARD_ID = "dashboard";
const DASHBOARD_SIZE = { width: 380, height: 660 };

const timers: ControllerDeps["timers"] = {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as number),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as number),
};

const controller = new Controller({
    clock: () => Date.now(),
    // performance.now() never moves backwards, unlike the wall clock: the provider schedule runs on it.
    monotonic: () => performance.now(),
    timers,
    providers: {
        loadSnapshot: () => providers.loadSnapshot(),
        refresh: selection => providers.refresh(selection),
        doctor: () => providers.doctor(),
    },
    sampler: name => new MetricsSampler(name),
    notifier: {
        requestPermission: () => Notifications.requestPermission(),
        show: notification => Notifications.show(notification),
    },
    store: settingsStore(process.dataDir),
});

// Where the dashboard lives (src/windows.ts holds the logic, tested over a fake port). nsh's Window.open runs on Linux and
// Windows and throws on other platforms (macOS), so there the dashboard is the app's main window itself: a tray click
// raises it (orderFront restores a minimized window) and "Hide dashboard" minimizes it. The same fallback applies when
// Window.open throws on a host that was expected to have it, and when the tray cannot be installed (the main window is
// then the only way in, so it is left showing the dashboard). A second window still up at that moment is hidden.
// Closing the main window ends the app (documented by nsh for macOS and Windows, and for `nsh run` on Linux; a packaged
// Linux app, or one a tray keeps alive, is unverified). nsh's TSX API cannot intercept it. So wherever the main window is
// the dashboard (macOS always; Linux and Windows after the fallbacks above) its close button quits the app, and on Linux
// and Windows closing the placeholder would too: a limit of nsh, not worked around here.
// Platform limit: nsh's AppWindow reports neither whether it is focused nor whether it is on screen, so a tray click
// always raises the dashboard; hiding it is the menu's "Hide dashboard" item.
const windows = createDashboardWindows({
    port: {
        isAvailable,
        platform: process.platform,
        openWindow: onClosed =>
            Window.open(() => <Dashboard controller={controller} onClosed={onClosed} />, {
                id: DASHBOARD_ID,
                title: APP_NAME,
                size: DASHBOARD_SIZE,
            }),
        setTitle: title => Window.setTitle(title),
        setFrame: size => Window.setFrame({ size }),
        setSkipTaskbar: skip => Window.setSkipTaskbar(skip),
        minimize: () => Window.minimize(),
        orderFront: () => Window.orderFront(),
        windowState: () => windowState(),
    },
    setScreen: screen => controller.screen.set(screen),
    appName: APP_NAME,
    size: DASHBOARD_SIZE,
});

function App() {
    // Install the tray, then put the main window away; a failed `Tray.set` is reported to the windows (src/windows.ts).
    startTray({
        windows,
        port: nshTrayPort,
        install: port => installTray(controller, {
            openDashboard: () => windows.open(),
            hideDashboard: () => windows.hide(),
            dashboardShown: () => windows.shown(),
            refreshAll: () => void controller.refreshAll(),
            refreshProvider: name => void controller.refreshProvider(name),
            // The result shows in the settings screen; a window already open on it updates in place.
            runDoctor: () => {
                windows.open("settings");
                void controller.runDoctor();
            },
        }, port),
    });
    void controller.start();
    return (
        <View class="flex-1 bg-background">
            {isAvailable && windows.inMain() ? (
                <Dashboard controller={controller} />
            ) : (
                <View class="flex-1 items-center justify-center">
                    <Text class="text-foreground">Superbar</Text>
                </View>
            )}
        </View>
    );
}

mount(App);
