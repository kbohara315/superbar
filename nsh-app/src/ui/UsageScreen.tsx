// The usage view: one card per enabled provider, then the system metric tiles.

import { Image, Scroll, Text, View } from "nsh";
import type { Controller } from "../controller";
import type { ProviderName, UsageWindow } from "../types";
import { brandColor, cardView, COLORS, displayMode, PROVIDER_TITLE, windowRow, WINDOW_TITLE, WindowRowView } from "./format";
import { PROVIDER_LOGO } from "./icons";
import { IconButton } from "./Controls";
import { MetricTiles } from "./MetricTiles";

function WindowRowItem(props: { controller: Controller; name: ProviderName; kind: "primary" | "secondary" }) {
    const c = props.controller;
    const brand = brandColor(props.name);
    const window = (): UsageWindow | null => c.snapshot()?.providers[props.name].windows[props.kind] ?? null;
    // Without any snapshot the row shows placeholders, as the extension does until its first render.
    const row = (): WindowRowView | null => (c.snapshot() ? windowRow(window(), c.now(), displayMode(c.settings().showRemaining), brand) : null);
    const pace = () => c.paceLine(props.name, props.kind, window());
    return (
        <View class="gap-1.5">
            <View class="flex-row items-center gap-2">
                <Text class="text-sm text-foreground">{WINDOW_TITLE[props.kind]}</Text>
                <Text class="truncate flex-1 text-xs text-muted-foreground">{row()?.resetText ?? ""}</Text>
                <Text class="text-sm font-semibold text-foreground" testID={`${props.name}-${props.kind}-percent`}>
                    {row()?.percentText ?? "—"}
                </Text>
            </View>
            <View class="h-1.5 rounded-full bg-muted overflow-hidden">
                <View style={{ width: `${row()?.fill ?? 0}%`, minWidth: (row()?.fill ?? 0) > 0 ? 4 : 0, height: "100%", borderRadius: 3, backgroundColor: row()?.fillColor ?? brand }} />
            </View>
            {pace() !== "" ? <Text class="text-xs text-muted-foreground">{pace()}</Text> : null}
        </View>
    );
}

export function ProviderCard(props: { controller: Controller; name: ProviderName }) {
    const c = props.controller;
    const name = props.name;
    const data = () => c.snapshot()?.providers[name] ?? null;
    const view = () => {
        const d = data();
        return d ? cardView(name, d, c.now(), c.liveExpiry()[name]) : { state: "Offline", synced: "Not synced yet", token: null, reason: null };
    };
    const dimmed = () => data()?.state === "stale";
    return (
        <View class="rounded-2xl bg-card border border-border p-4 gap-3" testID={`card-${name}`}>
            <View class="flex-row items-center gap-3">
                <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: brandColor(name), alignItems: "center", justifyContent: "center" }}>
                    <Image src={PROVIDER_LOGO[name]} style={{ width: 14, height: 14 }} />
                </View>
                <View class="flex-1 min-w-0 gap-0.5">
                    <Text class="text-sm font-semibold text-foreground">{PROVIDER_TITLE[name]}</Text>
                    {/* Never truncated: the token wording is the point of the line, so it wraps or gets its own line. */}
                    <Text class="text-xs text-muted-foreground" testID={`${name}-synced`}>{view().synced}</Text>
                    {view().token ? <Text class="text-xs text-muted-foreground" testID={`${name}-token`}>{view().token}</Text> : null}
                    {view().reason ? <Text class="text-xs" style={{ color: COLORS.alert }} testID={`${name}-reason`}>{view().reason}</Text> : null}
                </View>
                <Text class="text-xs text-muted-foreground bg-muted rounded-full px-2 py-0.5" testID={`${name}-state`}>{view().state}</Text>
                <IconButton
                    testID={`refresh-${name}`}
                    label={`Refresh ${PROVIDER_TITLE[name]} usage`}
                    glyph="↻"
                    disabled={() => c.refreshing() !== null}
                    onPress={() => void c.refreshProvider(name)}
                />
            </View>
            <View class={dimmed() ? "gap-3 opacity-70" : "gap-3"}>
                <WindowRowItem controller={c} name={name} kind="primary" />
                <WindowRowItem controller={c} name={name} kind="secondary" />
            </View>
        </View>
    );
}

export function UsageScreen(props: { controller: Controller }) {
    const c = props.controller;
    const enabled = (): ProviderName[] => (["codex", "claude"] as const).filter(name => c.settings().providers[name]);
    return (
        <Scroll style={{ flex: 1 }}>
        <View class="gap-3 px-4 pb-4">
            {enabled().map(name => <ProviderCard controller={c} name={name} />)}
            {enabled().length === 0 ? <Text class="text-sm text-muted-foreground">No providers are shown. Turn one on in settings.</Text> : null}
            <MetricTiles controller={c} />
        </View>
        </Scroll>
    );
}
