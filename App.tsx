// Superbar on nsh: a tray-resident app. The tray icon shows the provider pills; its menu and a click raise the dashboard
// (in the main window on Linux/macOS, a separate window on Windows). Production wiring lives here: providers, samplers, notifications
// and the settings file in ${dataDir}. Everything else is in src/ and is tested with fakes.

import process from "process";
import { effect, mount, Notifications, signal, Text, View } from "nsh";
import { isAvailable, Window, windowState } from "nsh/desktop";
import * as fsPromises from "fs/promises";
import os from "os";
import { randomUUID } from "crypto";
import { AppRuntime } from "superbar/native";
import * as providers from "./src/providers";
import { MetricsSampler } from "./src/metrics";
import { Controller } from "./src/controller";
import type { ControllerDeps } from "./src/controller";
import { installTray, nshTrayPort } from "./src/tray";
import { settingsStore } from "./src/store";
import { createLoginAutostart } from "./src/login-autostart";
import { Dashboard } from "./src/ui/Dashboard";
import { createDashboardWindows, startTray } from "./src/windows";

const APP_NAME = "Superbar";
const DASHBOARD_ID = "dashboard";
const DASHBOARD_SIZE = { width: 380, height: 660 };
const launchAtLoginError = signal<string | null>(null);
let loginAutostartRequest = 0;

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

const loginAutostart = createLoginAutostart({
    platform: process.platform,
    homeDir: () => os.homedir(),
    executablePath: () => AppRuntime.executablePath(),
    fs: {
        mkdir: path => fsPromises.mkdir(path, { recursive: true }).then(() => undefined),
        writeFile: (path, text) => fsPromises.writeFile(path, text),
        rename: (from, to) => fsPromises.rename(from, to),
        unlink: path => fsPromises.unlink(path),
    },
    newName: () => randomUUID(),
});

// Where the dashboard lives (src/windows.ts holds the logic, tested over a fake port). Linux and macOS use the main
// window; Windows uses a second window. A tray click raises the main window or focuses the second window; "Hide dashboard"
// minimizes or hides it. If the tray cannot be installed, the main window is left showing the dashboard. If a second
// window is still up at that moment, it is hidden.
// Closing the main window ends the app (documented by nsh for macOS and Windows, and for `nsh run` on Linux; a packaged
// Linux app, or one a tray keeps alive, is unverified). nsh's TSX API cannot intercept it. So wherever the main window is
// the dashboard (macOS and Linux always; Windows after the fallbacks above) its close button quits the app. Closing the
// Windows placeholder would too: a limit of nsh, not worked around here.
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
    singleWindow: process.platform === "linux",
});

function App() {
    effect(() => {
        if (process.platform !== "linux" || !controller.ready()) return;
        const request = ++loginAutostartRequest;
        void loginAutostart.setEnabled(controller.settings().launchAtLogin).then(
            () => { if (request === loginAutostartRequest) launchAtLoginError.set(null); },
            () => {
                if (request === loginAutostartRequest) {
                    launchAtLoginError.set("Could not update login startup. Check permissions for ~/.config/autostart.");
                }
            },
        );
    });
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
            {!isAvailable ? <Text class="text-foreground">Superbar</Text> : null}
            {isAvailable && windows.inMain() ? (
                <Dashboard
                    controller={controller}
                    launchAtLoginSupported={process.platform === "linux"}
                    launchAtLoginError={() => launchAtLoginError()}
                />
            ) : null}
        </View>
    );
}

mount(App);
