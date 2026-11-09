// The dashboard window's root: the header, then the usage or settings screen. Closing the window (the user's close,
// which unmounts it) returns the next opening to the usage screen.

import { cleanup, Text, View } from "nsh";
import type { Controller } from "../controller";
import { headerStatus } from "./format";
import { IconButton } from "./Controls";
import { SettingsScreen } from "./SettingsScreen";
import { UsageScreen } from "./UsageScreen";

export interface DashboardProps {
    controller: Controller;
    /** Called when the window's content unmounts (the user closed the window). */
    onClosed?: () => void;
}

export function Dashboard(props: DashboardProps) {
    const c = props.controller;
    cleanup(() => {
        c.screen.set("usage");
        props.onClosed?.();
    });
    const settings = () => c.screen() === "settings";
    return (
        <View class="flex-1 bg-background" testID="dashboard">
            <View class="flex-row items-center gap-2 px-4 pt-4 pb-2">
                {settings() ? (
                    <IconButton testID="settings-back" label="Back to usage" glyph="←" onPress={() => c.screen.set("usage")} />
                ) : null}
                <View class="flex-1 min-w-0">
                    <Text class="text-base font-semibold text-foreground" testID="header-title">{settings() ? "Settings" : "Usage"}</Text>
                    <Text class="text-xs text-muted-foreground" testID="header-status">
                        {headerStatus(c.status(), c.refreshing() !== null)}
                    </Text>
                </View>
                {settings() ? null : (
                    <IconButton testID="open-settings" label="Open Superbar settings" glyph="⚙" onPress={() => c.screen.set("settings")} />
                )}
                {settings() ? null : (
                    <IconButton
                        testID="refresh-all"
                        label="Refresh all usage and system metrics now"
                        glyph="↻"
                        disabled={() => c.refreshing() !== null || !c.ready()}
                        onPress={() => void c.refreshAll()}
                    />
                )}
            </View>
            <View style={{ flex: 1 }}>
                {c.ready() ? (
                    settings() ? <SettingsScreen controller={c} /> : <UsageScreen controller={c} />
                ) : (
                    <Text class="px-4 py-6 text-sm text-muted-foreground">Loading…</Text>
                )}
            </View>
        </View>
    );
}
