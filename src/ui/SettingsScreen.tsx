// The settings view inside the dashboard window: display and alert switches, provider and metric switches with their
// intervals, the disk threshold, and the doctor checks. Opening it runs the doctor once.

import { Image, Scroll, Text, View, untracked } from "nsh";
import { Button } from "nsh/base";
import type { Controller } from "../controller";
import { DISK_THRESHOLD_MAX, DISK_THRESHOLD_MIN, PROVIDER_MIN_SECONDS, INTERVAL_MAX_SECONDS, METRIC_MIN_SECONDS } from "../settings";
import type { MetricName, ProviderName } from "../types";
import { COLORS, doctorColor, doctorTag, METRIC_TITLE, PROVIDER_TITLE } from "./format";
import { metricIconUri, PROVIDER_LOGO } from "./icons";
import { Caption, Divider, IntervalEditor, SwitchRow } from "./Controls";
import { METRIC_ORDER } from "./MetricTiles";

function ProviderRow(props: { controller: Controller; name: ProviderName }) {
    const c = props.controller;
    const name = props.name;
    return (
        <SwitchRow
            testID={`show-${name}`}
            title={PROVIDER_TITLE[name]}
            value={() => c.settings().providers[name]}
            onChange={on => c.updateSettings(s => ({ ...s, providers: { ...s.providers, [name]: on } }))}
        />
    );
}

function MetricRow(props: { controller: Controller; name: MetricName }) {
    const c = props.controller;
    const name = props.name;
    const config = () => c.settings().metrics[name];
    return (
        <View class="gap-1">
            <View class="flex-row items-center gap-2">
                <Image src={metricIconUri(name, COLORS.metric[name])} style={{ width: 14, height: 14 }} />
                <View class="flex-1">
                    <SwitchRow
                        testID={`metric-${name}`}
                        title={METRIC_TITLE[name]}
                        value={() => config().enabled}
                        onChange={on => c.updateSettings(s => ({ ...s, metrics: { ...s.metrics, [name]: { ...s.metrics[name], enabled: on } } }))}
                    />
                </View>
            </View>
            <View class="flex-row justify-end">
                <IntervalEditor
                    testID={`interval-${name}`}
                    label={`${METRIC_TITLE[name]} interval`}
                    seconds={() => config().seconds}
                    min={METRIC_MIN_SECONDS}
                    max={INTERVAL_MAX_SECONDS}
                    onChange={seconds => c.updateSettings(s => ({ ...s, metrics: { ...s.metrics, [name]: { ...s.metrics[name], seconds } } }))}
                />
            </View>
        </View>
    );
}

export function SettingsScreen(props: {
    controller: Controller;
    launchAtLoginSupported?: boolean;
    launchAtLoginError?: () => string | null;
}) {
    const c = props.controller;
    // Each opening of the settings view checks the local setup once; the Run doctor button checks again.
    untracked(() => void c.runDoctor());
    const threshold = () => c.settings().diskAlertThreshold;
    const setThreshold = (value: number) =>
        c.updateSettings(s => ({ ...s, diskAlertThreshold: Math.min(DISK_THRESHOLD_MAX, Math.max(DISK_THRESHOLD_MIN, value)) }));
    // The storage note sits above the scrolling part, so it is at the top of the screen and stays in view when it changes.
    // Its colour is a darker orange on the light background (the brand orange is 3.1:1 there) and a lighter one on dark.
    return (
        <View style={{ flex: 1 }}>
        {c.storageWarning() ? (
            <View class="px-4 pt-3">
                <Text class="text-xs text-orange-700 dark:text-orange-400" testID="storage-warning">{c.storageWarning()}</Text>
            </View>
        ) : null}
        <Scroll style={{ flex: 1 }}>
        <View class="gap-2 px-4 pb-4">
            <Caption text="USAGE" />
            <SwitchRow testID="show-remaining" title="Show remaining usage (off = show used)" value={() => c.settings().showRemaining}
                onChange={on => c.updateSettings(s => ({ ...s, showRemaining: on }))} />
            {props.launchAtLoginSupported ? (
                <>
                    <Divider />
                    <Caption text="STARTUP" />
                    <SwitchRow testID="launch-at-login" title="Start Superbar when I sign in" value={() => c.settings().launchAtLogin}
                        onChange={on => c.updateSettings(s => ({ ...s, launchAtLogin: on }))} />
                    {props.launchAtLoginError?.() ? (
                        <Text class="text-xs text-orange-700 dark:text-orange-400" testID="launch-at-login-error">
                            {props.launchAtLoginError()}
                        </Text>
                    ) : null}
                </>
            ) : null}
            <SwitchRow testID="alerts" title="Usage and disk alerts" value={() => c.settings().alerts}
                onChange={on => c.updateSettings(s => ({ ...s, alerts: on }))} />
            <View class="flex-row items-center gap-2">
                <Text class="flex-1 text-sm text-foreground">Disk alert threshold</Text>
                <Button accessibilityLabel="Lower disk alert threshold" testID="disk-threshold-down"
                    class="size-6 rounded-full bg-muted items-center justify-center" onPress={() => setThreshold(threshold() - 1)}>
                    <Text class="text-sm text-foreground">−</Text>
                </Button>
                <Text class="w-20 text-center text-sm font-semibold text-foreground" testID="disk-threshold">{`${threshold()}% used`}</Text>
                <Button accessibilityLabel="Raise disk alert threshold" testID="disk-threshold-up"
                    class="size-6 rounded-full bg-muted items-center justify-center" onPress={() => setThreshold(threshold() + 1)}>
                    <Text class="text-sm text-foreground">+</Text>
                </Button>
            </View>
            <Divider />
            <Caption text="PROVIDERS" />
            <View class="flex-row items-center gap-2">
                <Image src={PROVIDER_LOGO.codex} style={{ width: 16, height: 16 }} />
                <View class="flex-1"><ProviderRow controller={c} name="codex" /></View>
            </View>
            <View class="flex-row items-center gap-2">
                <Image src={PROVIDER_LOGO.claude} style={{ width: 16, height: 16 }} />
                <View class="flex-1"><ProviderRow controller={c} name="claude" /></View>
            </View>
            <SwitchRow testID="auto-provider-refresh" title="Auto-refresh usage" value={() => c.settings().providerRefresh.enabled}
                onChange={on => c.updateSettings(s => ({ ...s, providerRefresh: { ...s.providerRefresh, enabled: on } }))} />
            <View class="flex-row justify-end">
                <IntervalEditor
                    testID="interval-provider"
                    label="Usage refresh interval"
                    seconds={() => c.settings().providerRefresh.seconds}
                    min={PROVIDER_MIN_SECONDS}
                    max={INTERVAL_MAX_SECONDS}
                    onChange={seconds => c.updateSettings(s => ({ ...s, providerRefresh: { ...s.providerRefresh, seconds } }))}
                />
            </View>
            <Divider />
            <Caption text="SYSTEM · AUTO-REFRESH" />
            <SwitchRow testID="auto-system-refresh" title="Refresh system metrics automatically" value={() => c.settings().systemRefresh.enabled}
                onChange={on => c.updateSettings(s => ({ ...s, systemRefresh: { enabled: on } }))} />
            {METRIC_ORDER.map(name => <MetricRow controller={c} name={name} />)}
            <Divider />
            <View class="flex-row items-center gap-2">
                <Caption text="DOCTOR" />
                <View class="flex-1" />
                <Button testID="run-doctor" accessibilityLabel="Run doctor again" class="px-3 h-7 rounded-full bg-muted items-center justify-center"
                    disabled={c.doctorRunning()} onPress={() => void c.runDoctor()}>
                    <Text class="text-xs text-foreground">{c.doctorRunning() ? "Checking…" : "Run again"}</Text>
                </Button>
            </View>
            {c.doctor() === null ? <Text class="text-xs text-muted-foreground">Checking…</Text> : null}
            {(c.doctor() ?? []).map(check => (
                <View class="flex-row items-start gap-2" testID={`doctor-${check.name}`}>
                    <Text class="w-12 text-xs font-semibold" style={{ color: doctorColor(check.status) }}>{doctorTag(check.status)}</Text>
                    <View class="flex-1 gap-0.5">
                        <Text class="text-xs font-semibold text-foreground">{check.name}</Text>
                        <Text class="text-xs text-muted-foreground">{check.detail}</Text>
                    </View>
                </View>
            ))}
        </View>
        </Scroll>
        </View>
    );
}
