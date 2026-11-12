// Minimal XDG login startup integration. The app owns one fixed entry in ~/.config/autostart; disabling it removes only
// that entry. Filesystem access and runtime metadata are injected so the policy can be tested without a desktop host.

export const LOGIN_AUTOSTART_FILE = "com.superbar.app.desktop";

export interface LoginAutostartFs {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, text: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    unlink(path: string): Promise<void>;
}

export interface LoginAutostartOptions {
    platform: string;
    homeDir(): string;
    executablePath(): string | null;
    fs: LoginAutostartFs;
    newName(): string;
}

export interface LoginAutostart {
    /** Reconciles the user's XDG entry with the requested setting. Updates are serialized. */
    setEnabled(enabled: boolean): Promise<void>;
}

function entryPaths(homeDir: string): { directory: string; file: string } {
    if (!homeDir.startsWith("/") || homeDir.includes("\n") || homeDir.includes("\r")) {
        throw new Error("The Linux home directory is not an absolute path");
    }
    const home = homeDir.replace(/\/+$/, "") || "/";
    const directory = `${home === "/" ? "" : home}/.config/autostart`;
    return { directory, file: `${directory}/${LOGIN_AUTOSTART_FILE}` };
}

/** Quotes one absolute executable path as a single freedesktop Exec argument, without invoking a shell. */
export function desktopExecArgument(executable: string): string {
    if (!executable.startsWith("/") || executable.includes("\n") || executable.includes("\r")) {
        throw new Error("The executable path must be absolute and contain no line breaks");
    }
    // Inside a quoted Exec argument, these four characters need escaping. Percent is a desktop-entry field marker.
    const escaped = executable
        .replace(/%/g, "%%")
        .replace(/[\\"`$]/g, "\\$&");
    return `"${escaped}"`;
}

export function loginAutostartDesktopEntry(executable: string): string {
    return [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Superbar",
        "Comment=Keep Superbar available in the system tray",
        `Exec=${desktopExecArgument(executable)}`,
        "Terminal=false",
        "StartupNotify=false",
        "X-GNOME-Autostart-enabled=true",
        "",
    ].join("\n");
}

function isNotFound(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error
        && (error as { code?: unknown }).code === "ENOENT";
}

async function apply(enabled: boolean, options: LoginAutostartOptions): Promise<void> {
    const { directory, file } = entryPaths(options.homeDir());
    if (!enabled) {
        try {
            await options.fs.unlink(file);
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
        return;
    }

    const executable = options.executablePath();
    if (!executable) throw new Error("The current executable path is unavailable");
    const text = loginAutostartDesktopEntry(executable);
    const temporary = `${file}.${options.newName()}.tmp`;
    await options.fs.mkdir(directory);
    try {
        await options.fs.writeFile(temporary, text);
        await options.fs.rename(temporary, file);
    } catch (error) {
        try {
            await options.fs.unlink(temporary);
        } catch {
            // The temporary file did not get created, or cleanup is unavailable; preserve the original error.
        }
        throw error;
    }
}

export function createLoginAutostart(options: LoginAutostartOptions): LoginAutostart {
    let requested: boolean | null = null;
    let queue = Promise.resolve();
    return {
        setEnabled(enabled) {
            if (options.platform !== "linux") return Promise.resolve();
            if (requested === enabled) return queue;
            requested = enabled;
            const operation = queue.then(() => apply(enabled, options));
            queue = operation.catch(() => {
                if (requested === enabled) requested = null;
            });
            return operation;
        },
    };
}
