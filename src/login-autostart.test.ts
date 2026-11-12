import { expect, test } from "nsh/test";
import {
    createLoginAutostart,
    desktopExecArgument,
    LOGIN_AUTOSTART_FILE,
    loginAutostartDesktopEntry,
} from "./login-autostart";
import type { LoginAutostartOptions, LoginAutostartFs } from "./login-autostart";

function fakeAutostart(platform = "linux") {
    const files = new Map<string, string>();
    const directories = new Set<string>();
    const calls: string[] = [];
    const fs: LoginAutostartFs = {
        mkdir: async path => { calls.push(`mkdir:${path}`); directories.add(path); },
        writeFile: async (path, text) => { calls.push(`write:${path}`); files.set(path, text); },
        rename: async (from, to) => {
            calls.push(`rename:${from}->${to}`);
            const text = files.get(from);
            if (text === undefined) throw new Error("missing temp file");
            files.delete(from);
            files.set(to, text);
        },
        unlink: async path => {
            calls.push(`unlink:${path}`);
            if (!files.delete(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
    };
    const deps: LoginAutostartOptions = {
        platform,
        homeDir: () => "/home/test user",
        executablePath: () => "/home/test user/Superbar Build",
        fs,
        newName: () => "test-id",
    };
    return { manager: createLoginAutostart(deps), files, directories, calls, deps };
}

test("desktop Exec arguments quote paths and escape Desktop Entry syntax", () => {
    expect(desktopExecArgument("/opt/Superbar build")).toBe('"/opt/Superbar build"');
    expect(desktopExecArgument('/opt/a"b%`$\\c')).toBe('"/opt/a\\"b%%\\`\\$\\\\c"');
    expect(() => desktopExecArgument("relative/Superbar")).toThrow();
    expect(() => desktopExecArgument("/opt/Superbar\nExec=other")).toThrow();
});

test("enabling writes one atomic XDG entry for the current executable", async () => {
    const fake = fakeAutostart();
    await fake.manager.setEnabled(true);
    const path = `/home/test user/.config/autostart/${LOGIN_AUTOSTART_FILE}`;
    expect(fake.directories).toEqual(new Set(["/home/test user/.config/autostart"]));
    expect(fake.files.get(path)).toBe(loginAutostartDesktopEntry("/home/test user/Superbar Build"));
    expect(fake.files.get(path)).toContain('Exec="/home/test user/Superbar Build"');
    expect([...fake.files.keys()]).toEqual([path]);
});

test("disabling removes only Superbar's entry and tolerates it already being absent", async () => {
    const fake = fakeAutostart();
    const path = `/home/test user/.config/autostart/${LOGIN_AUTOSTART_FILE}`;
    fake.files.set(path, "Superbar");
    fake.files.set("/home/test user/.config/autostart/other.desktop", "Other app");
    await fake.manager.setEnabled(false);
    await fake.manager.setEnabled(false);
    expect(fake.files.get(path)).toBe(undefined);
    expect(fake.files.get("/home/test user/.config/autostart/other.desktop")).toBe("Other app");
});

test("non-Linux platforms do not touch the filesystem", async () => {
    const fake = fakeAutostart("windows");
    await fake.manager.setEnabled(true);
    expect(fake.calls).toEqual([]);
});

test("a missing executable path fails without writing an entry", async () => {
    const fake = fakeAutostart();
    fake.deps.executablePath = () => null;
    const manager = createLoginAutostart(fake.deps);
    await expect(manager.setEnabled(true)).rejects.toThrow("executable path is unavailable");
    expect(fake.files.size).toBe(0);
    expect(fake.calls).toEqual([]);
});
