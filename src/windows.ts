// Where the dashboard lives and how it is raised or hidden, behind a port so the paths that only some hosts take (a
// failed tray, a host that cannot open a second window, Windows' taskbar entry) are tested with a fake. App.tsx wires
// the real nsh window API into `DesktopPort`; nothing here imports nsh/desktop.
//
// Facts used (nsh's docs, website/modules/nsh-desktop.md, and its source; nothing here was run on Windows or macOS):
//   - Window.open runs on Linux and Windows and throws elsewhere (macOS).
//   - Window.orderFront raises and focuses the main window (macOS deminiaturizes, Windows restores a minimized one).
//   - Window.setSkipTaskbar(true) removes the main window's taskbar entry on Windows only; the other platforms ignore
//     it. nsh keeps the choice and re-applies it every time the window is shown.
//   - A second window has its own taskbar button on Windows (docs/windows.md); this app does not hide it from there.
//   - windowState() is documented for macOS only ("macOS reports the window's state"); nsh's Windows and Linux
//     platforms do not implement it, so it can be null there. The tracked flag below is the fallback.
//   - An AppWindow has focus(), hide() and close(), and reports neither focus nor visibility.
//   - Closing the main window ends the app, wherever the main window is what the user closes: nsh's macOS doc says it stops
//     the engine and returns from run_app, its Windows doc that it closes the other windows and ends the app, and its
//     Linux doc that closing the window ends `nsh run` (what it does to a packaged Linux app, and to one kept alive by a
//     tray, is NOT verified here). Nothing in nsh's TSX API intercepts it (macOS's keep_alive_on_close is a Rust
//     AppOptions field). So this holds for the main window as dashboard on every platform, i.e. on macOS always, and on
//     Linux and Windows once the tray failed or Window.open threw, and for the hidden placeholder on Linux and Windows
//     if something closes it. The app can only keep the placeholder out of the way (minimize, plus the taskbar flag
//     on Windows).
//   - The placeholder's minimize: nsh's Minimize is ShowWindow(SW_MINIMIZE) and its skip-taskbar is
//     ITaskbarList::DeleteTab (crates/nsh-platform-windows/src/chrome.rs). nsh documents no "hide the main window"
//     command. Windows may leave a minimized window without a taskbar button as a small caption strip near the screen
//     edge; that was not seen or ruled out, as there is no Windows host here. RISK, accepted and unverified: a Windows
//     user may see that strip. The alternatives (moving the window off screen with setFrame, a zero size) are not
//     documented behaviour and are not used.

import { signal } from "nsh";
import type { Accessor } from "nsh";
import type { Screen } from "./controller";
import type { TrayPort } from "./tray";

/** A second window as nsh returns it. */
export interface WindowHandle {
    focus(): void;
    hide(): void;
}

/** The part of nsh/desktop this module uses. Every call may throw, as on a host that lacks it. */
export interface DesktopPort {
    isAvailable: boolean;
    /** nsh's platform names: "linux", "windows", "macos". */
    platform: string;
    /** Opens the dashboard window; `onClosed` runs when the user closes it. Throws where there is no second window. */
    openWindow(onClosed: () => void): WindowHandle;
    setTitle(title: string): void;
    setFrame(size: { width: number; height: number }): void;
    setSkipTaskbar(skip: boolean): void;
    minimize(): void;
    orderFront(): void;
    /** The main window's state where the host reports it (documented for macOS), else null. */
    windowState(): { minimized: boolean; hidden: boolean } | null;
}

export interface DashboardWindowsOptions {
    port: DesktopPort;
    /** Selects the screen; a plain open passes none and keeps the one showing. */
    setScreen(screen: Screen): void;
    appName: string;
    size: { width: number; height: number };
}

export interface DashboardWindows {
    /** Raises the dashboard, on `screen` if given. */
    open(screen?: Screen): void;
    hide(): void;
    /** Whether the dashboard is showing (the menu enables Hide on it). */
    shown(): boolean;
    /** Whether the main window carries the dashboard. */
    inMain: Accessor<boolean>;
    /**
     * Called when the tray could not be set. The first call that succeeds in raising the main window is the only one that
     * does: later calls do nothing. A call whose raising failed is retried by the next failure (the tray is re-sent on
     * every changed payload), so a transient orderFront failure does not leave the app without a visible window.
     */
    onTrayFailed(): void;
    trayFailed(): boolean;
    /** Startup: put the main window away (minimized) unless the tray failed or it carries the dashboard. */
    hideMainWindow(): void;
}

export function createDashboardWindows(options: DashboardWindowsOptions): DashboardWindows {
    const { port, setScreen, appName, size } = options;
    const hasSecondWindow = port.platform === "linux" || port.platform === "windows";
    const inMain = signal(!hasSecondWindow);

    let dashboard: WindowHandle | null = null;
    // The second window exists (open, possibly hidden). Its visibility is tracked here, as its handle reports none; the
    // main window's visibility is tracked on its own, because both can be showing at once (a failed tray or Window.open
    // moves the dashboard to the main window while a second window may still be up). The dashboard is shown if either is.
    let exists = false;
    const secondShown = signal(false);
    const mainShown = signal(false);
    // The tray failed (sticky: startup then leaves the main window up), and whether the main window was raised for it.
    let trayFailed = false;
    let rescued = false;
    let mainSized = false;

    const mainVisible = (): boolean => {
        if (!inMain()) return false;
        const state = port.windowState();
        if (state) return !state.minimized && !state.hidden;
        return mainShown();
    };
    const shown = (): boolean => mainVisible() || secondShown();

    function sizeMain(): void {
        if (mainSized) return;
        try {
            port.setFrame(size);
            mainSized = true;
        } catch {
            // The window keeps the size the host gave it.
        }
    }

    // Windows taskbar rule: the main window is out of the taskbar only while it is a hidden placeholder (a second window
    // carries the dashboard and the tray is up). Once it carries the dashboard it keeps its entry, also while minimized,
    // so the taskbar can bring it back. showMain therefore clears the flag, and hide() leaves it cleared.
    /** Raises the main window; whether it is known to be showing (orderFront did not throw). */
    function showMain(screen?: Screen): boolean {
        if (screen !== undefined) setScreen(screen);
        if (port.platform === "windows") {
            try {
                port.setSkipTaskbar(false);
            } catch {
                // The taskbar entry stays as it was; raising the window below is still worth trying.
            }
        }
        sizeMain();
        try {
            port.orderFront();
        } catch {
            // The window is as the host left it: it is not known to be showing.
            return false;
        }
        mainShown.set(true);
        return true;
    }

    // The dashboard moved to the main window while a second window may be showing: once the main window is known to be up,
    // put the second away, so one Hide (and one `shown`) covers what is on screen. Callers raise the main window first and
    // call this only if that worked, so a failed orderFront never leaves the user without a window. A hide that throws
    // leaves it tracked as showing, so Hide tries it again.
    function retireSecond(): void {
        if (!exists || !dashboard || !secondShown()) return;
        try {
            dashboard.hide();
        } catch {
            return;
        }
        secondShown.set(false);
    }

    // A plain open keeps the screen the window is showing (Settings stays Settings); a fresh window starts on Usage.
    function open(screen?: Screen): void {
        if (!port.isAvailable) return;
        if (inMain()) {
            // A second window left showing by an earlier failed raise is put away once the main one is up.
            if (showMain(screen)) retireSecond();
            return;
        }
        if (screen !== undefined) setScreen(screen);
        else if (!exists) setScreen("usage");
        try {
            dashboard = port.openWindow(() => {
                exists = false;
                secondShown.set(false);
            });
        } catch {
            // This host cannot open a second window: the main window carries the dashboard instead. A second window opened
            // earlier is put away only after the main one is raised; if that fails it stays up and tracked.
            inMain.set(true);
            if (showMain()) retireSecond();
            return;
        }
        exists = true;
        secondShown.set(true);
        try {
            dashboard.focus();
        } catch {
            // The window is open; it just was not focused.
        }
    }

    // Hides everything that is showing: the main window when it carries the dashboard, and the second window if it is up.
    // Each is its own attempt, and a failed one stays tracked as showing.
    function hide(): void {
        if (inMain()) {
            try {
                port.minimize();
                mainShown.set(false);
            } catch {
                // Still showing as far as is known.
            }
        }
        if (exists && dashboard && secondShown()) {
            try {
                dashboard.hide();
                secondShown.set(false);
            } catch {
                // Still showing as far as is known.
            }
        }
    }

    function onTrayFailed(): void {
        // The tray is re-sent with each changed payload and each attempt may fail again: once the main window was raised
        // for it, later failures do nothing, so the user's window is not raised again and again. Until then (orderFront
        // threw) every failure tries again.
        trayFailed = true;
        if (rescued || !port.isAvailable) return;
        inMain.set(true);
        // Raise the main window first; a second window is retired only once it is known to be up. If orderFront throws, the
        // second window stays visible and tracked, and the next failure retries both steps.
        rescued = showMain();
        if (rescued) retireSecond();
    }

    function hideMainWindow(): void {
        if (!port.isAvailable || trayFailed) return;
        // Each step is its own attempt: a failed title or taskbar call must not leave the window up.
        try {
            // The dev host titles the main window after its own runner ("nsh") until the app sets its title.
            port.setTitle(appName);
        } catch {
            // The title stays the host's.
        }
        if (inMain()) sizeMain();
        // Only a placeholder leaves the taskbar; a main window that carries the dashboard keeps its entry.
        if (port.platform === "windows" && !inMain()) {
            try {
                port.setSkipTaskbar(true);
            } catch {
                // The taskbar entry stays: the window is only minimized.
            }
        }
        try {
            port.minimize();
        } catch {
            // Keep the window: a visible main window is better than none.
        }
    }

    return { open, hide, shown, inMain, onTrayFailed, trayFailed: () => trayFailed, hideMainWindow };
}

/** What the tray starter needs of the windows. */
export type TrayWindows = Pick<DashboardWindows, "onTrayFailed" | "hideMainWindow">;

/** A tray port that reports a failed `set` to the windows, then rethrows it (installTray swallows it). */
export function reportingTrayFailure(port: TrayPort, windows: Pick<DashboardWindows, "onTrayFailed">): TrayPort {
    return {
        available: () => port.available(),
        set: options => {
            try {
                port.set(options);
            } catch (error) {
                windows.onTrayFailed();
                throw error;
            }
        },
    };
}

/**
 * Startup order: install the tray first, then put the main window away. A tray that fails during install has then already
 * told the windows, and the main window is left up; one that fails later raises it again.
 */
export function startTray(options: { windows: TrayWindows; port: TrayPort; install(port: TrayPort): void }): void {
    options.install(reportingTrayFailure(options.port, options.windows));
    options.windows.hideMainWindow();
}
