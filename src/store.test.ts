import { expect, test } from "nsh/test";
import { MAX_SETTINGS_BYTES, SETTINGS_INSECURE, settingsStore, SWEEP_AGE_MS, TEMP_NAME } from "./store";
import { SerialQueue } from "./store";
import { depsFor, fakeChmod, MemoryFs } from "../tests/fakes";

// Every test gets its own folder, and its own queue unless it says otherwise, so a write held in one test can never
// hold another test's saves.
let folders = 0;
function folder(): string {
    return `/data-${++folders}`;
}

// A folder with optional files, as a previous run would have left them (private unless a mode is given).
function privateFolder(fs: MemoryFs, dir: string, files: Record<string, { mode?: number; text: string; mtimeMs?: number }> = {}): void {
    fs.entries.set(dir, { kind: "dir", mode: 0o700, mtimeMs: 0 });
    for (const [name, file] of Object.entries(files)) {
        fs.entries.set(`${dir}/${name}`, { kind: "file", mode: file.mode ?? 0o600, text: file.text, mtimeMs: file.mtimeMs ?? 0 });
    }
}

function storeOver(fs: MemoryFs, dir: string, options: { chmodHonest?: boolean; queue?: SerialQueue } = {}) {
    const chmod = fakeChmod(fs, { honest: options.chmodHonest });
    return settingsStore(dir, depsFor(fs, chmod.run, { queue: options.queue ?? new SerialQueue() }))!;
}

async function errorCodeOf(task: () => Promise<unknown>): Promise<string> {
    try {
        await task();
        return "";
    } catch (err) {
        return (err as { code?: string }).code ?? "";
    }
}

async function rejects(task: () => Promise<unknown>): Promise<boolean> {
    return task().then(() => false, () => true);
}

// Lets queued continuations run.
async function settle(): Promise<void> {
    for (let i = 0; i < 200; i++) await Promise.resolve();
}

// Holds the first temporary write until the returned function is called (later writes are not held).
function holdFirstTemp(fs: MemoryFs): () => void {
    let temporaries = 0;
    return fs.holdWritesTo(path => path.endsWith(".tmp") && temporaries++ === 0);
}

function diskThresholdOf(fs: MemoryFs, dir: string): number | null {
    const text = fs.entries.get(`${dir}/settings.json`)?.text;
    return text === undefined ? null : JSON.parse(text).diskAlertThreshold;
}

const SETTINGS_JSON = "settings.json";

test("a save writes a unique temporary file, makes it private, checks it, and renames it over settings.json", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    await storeOver(fs, dir).write("{\"alerts\":true}");
    expect(fs.writes.length).toBe(1);
    expect(fs.writes[0].startsWith(`${dir}/${SETTINGS_JSON}.`) && fs.writes[0].endsWith(".tmp")).toBe(true);
    expect(fs.renames).toEqual([`${fs.writes[0]} -> ${dir}/${SETTINGS_JSON}`]);
    expect(fs.entries.get(`${dir}/${SETTINGS_JSON}`)?.text).toBe("{\"alerts\":true}");
    expect(fs.modeOf(dir)).toBe(0o700);
    expect(fs.modeOf(`${dir}/${SETTINGS_JSON}`)).toBe(0o600);
    expect(fs.temporaries().length).toBe(0);
});

test("the folder is made private before a save, and a chmod that reports success without changing it is refused with nothing written", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    expect(await errorCodeOf(() => storeOver(fs, dir, { chmodHonest: false }).write("{}"))).toBe(SETTINGS_INSECURE);
    expect(fs.writes.length).toBe(0);
    expect(fs.entries.has(`${dir}/${SETTINGS_JSON}`)).toBe(false);
});

test("Sol's repro in the store: 70 stuck, 75 requested, 70 released late: the disk holds 75, and 70 is never written after it", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const release = holdFirstTemp(fs);
    const store = storeOver(fs, dir);
    const seventy = store.write("{\"diskAlertThreshold\":70}");
    const seventyFive = store.write("{\"diskAlertThreshold\":75}");
    await settle();
    expect(fs.entries.has(`${dir}/${SETTINGS_JSON}`)).toBe(false);          // 75 waits behind the stuck 70
    release();                                                              // 70 lands late
    await Promise.all([seventy, seventyFive]);
    expect(diskThresholdOf(fs, dir)).toBe(75);
    expect(fs.renames.length).toBe(2);
    expect(fs.renames[1].endsWith(`-> ${dir}/${SETTINGS_JSON}`)).toBe(true);
    expect(fs.maxInFlight).toBe(1);
});

test("a save requested while another waits replaces it: only the newest waiting text is written after the stuck one", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const release = holdFirstTemp(fs);
    const store = storeOver(fs, dir);
    const first = store.write("{\"diskAlertThreshold\":60}");     // stuck
    const second = store.write("{\"diskAlertThreshold\":70}");    // waiting, then replaced
    const third = store.write("{\"diskAlertThreshold\":80}");     // replaces the waiting one
    release();
    await Promise.all([first, second, third]);
    expect(fs.writes.length).toBe(2);                              // the stuck write and one more, not three
    expect(diskThresholdOf(fs, dir)).toBe(80);
});

test("writes are issued one at a time: the next one starts only after the previous one has settled", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const releasers: (() => void)[] = [];
    fs.gate = path => (path.endsWith(".tmp") ? new Promise<void>(resolve => releasers.push(resolve)) : null);
    const store = storeOver(fs, dir);
    const saves = [store.write("{\"n\":1}"), store.write("{\"n\":2}"), store.write("{\"n\":3}")];
    await settle();
    expect(fs.writes.length).toBe(1);                              // only the first has started
    releasers.shift()?.();
    await settle();
    expect(fs.writes.length).toBe(2);                              // the second starts once the first has landed
    expect(fs.inFlight).toBe(1);
    releasers.shift()?.();                                         // the third lands: it replaced the second while it waited
    await Promise.all(saves);
    expect(fs.writes.length).toBe(2);                              // three requests, two writes
    expect(fs.maxInFlight).toBe(1);
    expect(JSON.parse(fs.entries.get(`${dir}/${SETTINGS_JSON}`)?.text ?? "{}").n).toBe(3);
});

test("a write that stores part of the text and then fails rejects, removes its temporary file, and the next save still lands", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const store = storeOver(fs, dir);
    fs.failWriteWith = { partial: "{\"ver", error: Object.assign(new Error("disk full"), { code: "ENOSPC" }) };
    expect(await errorCodeOf(() => store.write("{\"alerts\":false}"))).toBe("ENOSPC");
    expect(fs.temporaries().length).toBe(0);
    expect(fs.entries.has(`${dir}/${SETTINGS_JSON}`)).toBe(false);
    await store.write("{\"alerts\":true}");
    expect(fs.entries.get(`${dir}/${SETTINGS_JSON}`)?.text).toBe("{\"alerts\":true}");
});

test("a rename that fails rejects, removes its temporary file, and leaves the previous settings.json as it was", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{\"alerts\":true}" } });
    const store = storeOver(fs, dir);
    fs.failRenameTo = to => to.endsWith(SETTINGS_JSON);
    expect(await errorCodeOf(() => store.write("{\"alerts\":false}"))).toBe("EIO");
    expect(fs.temporaries().length).toBe(0);
    expect(fs.entries.get(`${dir}/${SETTINGS_JSON}`)?.text).toBe("{\"alerts\":true}");
});

test("a read waits behind the saves requested before it, and sees exactly those", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const release = holdFirstTemp(fs);
    const store = storeOver(fs, dir);
    const before = store.write("{\"alerts\":false}");
    const read = store.read();
    const after = store.write("{\"alerts\":true}");
    release();
    await Promise.all([before, after]);
    expect(await read).toEqual({ kind: "loaded", text: "{\"alerts\":false}" });
});

test("a folder that is not private (0777) is not trusted on read", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{}" } });
    fs.entries.set(dir, { kind: "dir", mode: 0o777, mtimeMs: 0 });
    expect((await storeOver(fs, dir).read()).kind).toBe("untrusted");
});

test("a settings.json that is a symlink is never followed: it is untrusted", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir);
    fs.entries.set(`${dir}/${SETTINGS_JSON}`, { kind: "symlink", mode: 0o777, mtimeMs: 0 });
    expect((await storeOver(fs, dir).read()).kind).toBe("untrusted");
});

test("a directory named settings.json is untrusted, not an error", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir);
    fs.entries.set(`${dir}/${SETTINGS_JSON}`, { kind: "dir", mode: 0o700, mtimeMs: 0 });
    expect((await storeOver(fs, dir).read()).kind).toBe("untrusted");
});

test("a settings.json readable by group or others (0644) is untrusted; a private read-only one (0400) is loaded", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { mode: 0o644, text: "{}" } });
    expect((await storeOver(fs, dir).read()).kind).toBe("untrusted");

    const other = folder();
    privateFolder(fs, other, { [SETTINGS_JSON]: { mode: 0o400, text: "{\"alerts\":false}" } });
    expect(await storeOver(fs, other).read()).toEqual({ kind: "loaded", text: "{\"alerts\":false}" });
});

test("an oversized settings.json is untrusted and is not loaded", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "x".repeat(MAX_SETTINGS_BYTES + 1) } });
    const read = await storeOver(fs, dir).read();
    expect(read.kind).toBe("untrusted");
    expect(read.kind === "untrusted" && read.reason.includes("too large")).toBe(true);
});

test("a missing settings.json or folder reads as missing, not as an error", async () => {
    const fs = new MemoryFs();
    expect(await storeOver(fs, folder()).read()).toEqual({ kind: "missing" });
    const dir = folder();
    privateFolder(fs, dir);
    expect(await storeOver(fs, dir).read()).toEqual({ kind: "missing" });
});

test("a failure of any kind while reading is an untrusted result, never a throw", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{}" } });
    const broken = Object.create(fs) as MemoryFs;
    broken.lstat = async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    expect((await storeOver(broken, dir).read()).kind).toBe("untrusted");
});

test("a legacy settings.json is the file: it loads as it is", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{\"showRemaining\":false}" } });
    expect(await storeOver(fs, dir).read()).toEqual({ kind: "loaded", text: "{\"showRemaining\":false}" });
});

test("interim settings.<digits>.json files from earlier builds are neither read nor removed", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    fs.clock = 100 * SWEEP_AGE_MS;
    privateFolder(fs, dir, {
        "settings.5.json": { text: "{\"version\":1,\"seq\":5,\"alerts\":false}", mtimeMs: 0 },
        "settings.1e+21.json": { text: "keep", mtimeMs: 0 },
    });
    expect(await storeOver(fs, dir).read()).toEqual({ kind: "missing" });
    expect(fs.entries.get(`${dir}/settings.5.json`)?.text).toBe("{\"version\":1,\"seq\":5,\"alerts\":false}");
    expect(fs.entries.get(`${dir}/settings.1e+21.json`)?.text).toBe("keep");
});

test("an orphaned temporary file older than the safe age is removed on read; a recent one is kept", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    fs.clock = 100 * SWEEP_AGE_MS;
    const old = "settings.json.0000-1.tmp";
    const recent = "settings.json.0000-2.tmp";
    privateFolder(fs, dir, {
        [SETTINGS_JSON]: { text: "{}" },
        [old]: { text: "partial", mtimeMs: 0 },
        [recent]: { text: "partial", mtimeMs: fs.clock },
    });
    await storeOver(fs, dir).read();
    expect(fs.entries.has(`${dir}/${old}`)).toBe(false);
    expect(fs.entries.has(`${dir}/${recent}`)).toBe(true);
});

test("the sweep removes only regular files: a symlink with a temporary name is never followed or removed", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    fs.clock = 100 * SWEEP_AGE_MS;
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{}" } });
    fs.entries.set(`${dir}/settings.json.0000-3.tmp`, { kind: "symlink", mode: 0o777, mtimeMs: 0 });
    await storeOver(fs, dir).read();
    expect(fs.entries.has(`${dir}/settings.json.0000-3.tmp`)).toBe(true);
});

test("the sweep never removes Sol's sentinel or any name that only looks like a temporary file (exact pattern, listed names)", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    fs.clock = 100 * SWEEP_AGE_MS;
    const sentinels = [
        "settings.1e+21.json",                       // Sol's sentinel: a number that prints in exponent form
        `settings.${"9".repeat(310)}.json`,          // digits that overflow to Infinity
        "settings.json.1e+21.tmp",                   // a temporary-looking name with a plus sign
        "settings.json.ABCDEF.tmp",                  // upper case is not what randomUUID makes
        "settings.json.0000-1.tmp.bak",              // extra suffix
        "settings.json.0000-1.tmp.",                 // trailing dot
        "xsettings.json.0000-1.tmp",                 // different prefix
    ];
    privateFolder(fs, dir, { [SETTINGS_JSON]: { text: "{}" } });
    for (const name of sentinels) fs.entries.set(`${dir}/${name}`, { kind: "file", mode: 0o600, text: "keep", mtimeMs: 0 });
    await storeOver(fs, dir).read();
    for (const name of sentinels) expect(fs.entries.get(`${dir}/${name}`)?.text).toBe("keep");
    expect(TEMP_NAME.test("settings.1e+21.json")).toBe(false);
});

test("the sweep never reaches outside the folder it reads", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    fs.clock = 100 * SWEEP_AGE_MS;
    privateFolder(fs, dir);
    fs.entries.set("/elsewhere/settings.json.0000-4.tmp", { kind: "file", mode: 0o600, text: "", mtimeMs: 0 });
    await storeOver(fs, dir).read();
    expect(fs.entries.has("/elsewhere/settings.json.0000-4.tmp")).toBe(true);
});

test("a temporary name that is not lowercase hex and dashes is refused before anything is written", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const chmod = fakeChmod(fs);
    const store = settingsStore(dir, { ...depsFor(fs, chmod.run, { queue: new SerialQueue() }), newName: () => "NOT/HEX" })!;
    expect(await rejects(() => store.write("{}"))).toBe(true);
    expect(fs.writes.length).toBe(0);
});

test("two instances: the last writer wins, and the file is always one whole valid version", async () => {
    // Two instances have separate queues (one per process in production), so their writes are not ordered together.
    const fs = new MemoryFs();
    const dir = folder();
    const releaseA = holdFirstTemp(fs);                              // instance A's write is the first one
    const a = storeOver(fs, dir, { queue: new SerialQueue() });
    const b = storeOver(fs, dir, { queue: new SerialQueue() });
    const writeA = a.write("{\"diskAlertThreshold\":60}");
    await settle();
    await b.write("{\"diskAlertThreshold\":75}");
    expect(diskThresholdOf(fs, dir)).toBe(75);
    releaseA();                                                       // instance A's write lands last
    await writeA;
    expect(diskThresholdOf(fs, dir)).toBe(60);
    expect((await storeOver(fs, dir).read()).kind).toBe("loaded");
});

test("the queue is per folder: a stuck save in one folder does not hold a save in another", async () => {
    const fs = new MemoryFs();
    const stuck = folder();
    const free = folder();
    const releaseStuck = fs.holdWritesTo(path => path.startsWith(`${stuck}/`) && path.endsWith(".tmp"));
    const stuckSave = settingsStore(stuck, depsFor(fs, fakeChmod(fs).run))!.write("{\"a\":1}");
    await settle();
    await settingsStore(free, depsFor(fs, fakeChmod(fs).run))!.write("{\"b\":2}");
    expect(fs.entries.get(`${free}/${SETTINGS_JSON}`)?.text).toBe("{\"b\":2}");
    releaseStuck();
    await stuckSave;
});

test("200 saves behind a hung write share one waiting write and one completion; the newest value is written when it lands, and every save settles", async () => {
    const fs = new MemoryFs();
    const dir = folder();
    const queue = new SerialQueue();
    const release = holdFirstTemp(fs);
    const store = storeOver(fs, dir, { queue });
    const first = store.write("{\"diskAlertThreshold\":60}");   // the hung one
    const later: Promise<void>[] = [];
    for (let i = 0; i < 200; i++) later.push(store.write(`{"diskAlertThreshold":${i % 2 === 0 ? 70 : 75}}`));
    await settle();
    expect(new Set(later).size).toBe(1);                        // every edit behind the hung write shares one completion
    expect(queue.queued()).toBe(1);                             // one waiting write, however many edits
    expect(fs.writes.length).toBe(1);
    release();
    const outcomes = await Promise.allSettled([first, ...later]);
    expect(outcomes.every(outcome => outcome.status === "fulfilled")).toBe(true);
    expect(fs.writes.length).toBe(2);
    expect(diskThresholdOf(fs, dir)).toBe(75);
    expect(queue.queued()).toBe(0);
});

test("without a data directory there is no settings store", () => {
    expect(settingsStore(null)).toBe(null);
});
