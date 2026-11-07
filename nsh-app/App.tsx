// Superbar on nsh: a tray-resident app. The tray icon shows the provider pills; its menu and a click open the dashboard,
// a popup window of the app's own. Production wiring lives here: the real providers, metric samplers, notifications
// and the settings file in ${dataDir}. Everything else is in src/ and is tested with fakes.

import process from "process";
import { mount, Notifications, signal, Text, View } from "nsh";
import { isAvailable, Window } from "nsh/desktop";
import type { AppWindow } from "nsh/desktop";
import * as providers from "./src/providers";
import { MetricsSampler } from "./src/metrics";
import { Controller } from "./src/controller";
import type { ControllerDeps, Screen, StorePort } from "./src/controller";
import { installTray } from "./src/tray";
import { settingsStore } from "./src/store";
import { Dashboard } from "./src/ui/Dashboard";

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

// The dashboard window. Its content unmounts when the user closes it; the next opening creates it again.
let dashboard: AppWindow | null = null;
// The window exists (open, possibly hidden) and is shown. The menu reads `dashboardShown`: Hide is enabled only while
// the window is showing.
let dashboardExists = false;
const dashboardShown = signal(false);

// Platform limit: nsh's AppWindow reports neither whether it is focused nor whether it is on screen (only
// focus(), hide() and close()), and lifecycle() describes the whole app. A tray click therefore always raises the
// dashboard; hiding it is the menu's "Hide dashboard" item. A click on a dashboard that is already frontmost is a
// no-op rather than a hide.
// A plain open keeps the screen the window is showing (Settings stays Settings); a fresh window starts on Usage.
function openDashboard(screen?: Screen): void {
    if (!isAvailable) return;
    if (screen !== undefined) controller.screen.set(screen);
    else if (!dashboardExists) controller.screen.set("usage");
    dashboard = Window.open(
        () => (
            <Dashboard
                controller={controller}
                onClosed={() => {
                    dashboardExists = false;
                    dashboardShown.set(false);
                }}
            />
        ),
        { id: DASHBOARD_ID, title: APP_NAME, size: DASHBOARD_SIZE },
    );
    dashboardExists = true;
    dashboardShown.set(true);
    dashboard.focus();
}

function hideDashboard(): void {
    if (!dashboardExists || !dashboard) return;
    dashboard.hide();
    dashboardShown.set(false);
}

// The main window starts minimized so no app window shows beside the tray. nsh offers no way to hide it on Linux, and
// closing it leaves the tray-resident app running (checked on GNOME with AppIndicator), so this is the hiding used.
function hideMainWindow(): void {
    if (!isAvailable) return;
    try {
        // The dev host titles the main window after its own runner ("nsh") until the app sets its title.
        Window.setTitle(APP_NAME);
        Window.minimize();
    } catch {
        // Keep the window: a visible main window is better than none.
    }
}

function App() {
    hideMainWindow();
    installTray(controller, {
        openDashboard: () => openDashboard(),
        hideDashboard,
        dashboardShown: () => dashboardShown(),
        refreshAll: () => void controller.refreshAll(),
        refreshProvider: name => void controller.refreshProvider(name),
        // The result shows in the settings screen; a window already open on it updates in place.
        runDoctor: () => {
            openDashboard("settings");
            void controller.runDoctor();
        },
    });
    void controller.start();
    return (
        <View class="flex-1 items-center justify-center bg-background">
            <Text class="text-foreground">Superbar</Text>
        </View>
    );
}

mount(App);
