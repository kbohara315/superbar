// Test entry for the dashboard: builds a controller over fake ports and mounts the real Dashboard. The scenario comes
// from the test's storage (`open(..., { storage: { scenario: JSON } })`), so each test sets its own data. Headless
// runs have no fs, process or notifications, so every port here is a fake; the clock is the test's manual clock.

import { mount, Storage, signal, Text, View } from "nsh";
import { Dashboard } from "../src/ui/Dashboard";
import { Controller } from "../src/controller";
import type { ControllerDeps, TimerPort } from "../src/controller";
import type { DoctorCheck, MetricName, MetricReading, Settings, Snapshot } from "../src/types";

interface Scenario {
    snapshot: Snapshot | null;
    settings: Settings | null;
    readings: Partial<Record<MetricName, MetricReading>>;
    doctor: DoctorCheck[];
    storageInsecure?: boolean;
    launchAtLoginSupported?: boolean;
}

const timers: TimerPort = {
    setInterval: (callback, ms) => setInterval(callback, ms),
    clearInterval: handle => clearInterval(handle as number),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: handle => clearTimeout(handle as number),
};

function controllerFor(scenario: Scenario): Controller {
    const deps: ControllerDeps = {
        clock: () => Date.now(),
        monotonic: () => Date.now(),
        timers,
        providers: {
            loadSnapshot: async () => scenario.snapshot,
            refresh: async () => {
                if (!scenario.snapshot) throw new Error("no snapshot in this scenario");
                const storage = scenario.storageInsecure
                    ? { persisted: false as const, error: { code: "storage_insecure", message: "not private" } }
                    : undefined;
                return { status: "ok", snapshot: scenario.snapshot, storage };
            },
            doctor: async () => scenario.doctor,
        },
        sampler: (name: MetricName) => ({
            sample: async () => scenario.readings[name] ?? { name, available: false, text: "unavailable" },
            topProcesses: async () => [],
        }),
        notifier: { requestPermission: async () => "unavailable", show: async () => false },
        store: {
            read: async () => (scenario.settings ? { kind: "loaded", text: JSON.stringify(scenario.settings) } : { kind: "missing" }),
            write: async () => undefined,
        },
    };
    return new Controller(deps);
}

function Harness() {
    const ready = signal<Controller | null>(null);
    const launchAtLoginSupported = signal(false);
    void (async () => {
        const text = await Storage.getItem("scenario");
        const scenario: Scenario = text ? JSON.parse(text) : { snapshot: null, settings: null, readings: {}, doctor: [] };
        launchAtLoginSupported.set(scenario.launchAtLoginSupported ?? false);
        const controller = controllerFor(scenario);
        await controller.start();
        ready.set(controller);
    })();
    return (
        <View class="flex-1 bg-background">
            {ready() ? (
                <Dashboard controller={ready() as Controller} launchAtLoginSupported={launchAtLoginSupported()} />
            ) : <Text>Loading…</Text>}
        </View>
    );
}

mount(Harness);
