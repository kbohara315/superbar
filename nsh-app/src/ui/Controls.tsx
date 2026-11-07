// Shared controls of the dashboard: round icon buttons, switch rows, the interval editor and section captions.
// Values that change come in as accessors (`() => value`), so each binding follows its signal.

import { signal, Text, View } from "nsh";
import { Button, Input, Switch } from "nsh/base";
import { defaultUnit, intervalText } from "./format";

export function IconButton(props: { testID: string; label: string; glyph: string; onPress: () => void; disabled?: () => boolean }) {
    return (
        <Button
            testID={props.testID}
            accessibilityLabel={props.label}
            disabled={props.disabled ? props.disabled() : false}
            class="size-8 rounded-full bg-muted items-center justify-center"
            onPress={props.onPress}
        >
            <Text class="text-base text-foreground">{props.glyph}</Text>
        </Button>
    );
}

export function Caption(props: { text: string }) {
    return <Text class="text-xs font-semibold text-muted-foreground">{props.text}</Text>;
}

export function Divider() {
    return <View class="h-px bg-border my-1" />;
}

export function SwitchRow(props: { testID: string; title: string; value: () => boolean; onChange: (on: boolean) => void }) {
    return (
        <View class="flex-row items-center gap-3 py-1">
            <Text class="flex-1 text-sm text-foreground">{props.title}</Text>
            <Switch
                testID={props.testID}
                accessibilityLabel={props.title}
                checked={props.value()}
                onChange={({ checked }) => props.onChange(checked)}
                class="flex-row items-center"
                trackClass="w-10 h-6 rounded-full p-0.5 bg-muted checked:bg-primary"
                thumbClass="size-5 rounded-full bg-background shadow-sm checked:translate-x-4"
            />
        </View>
    );
}

// Minus, a typed value, plus, and a unit button that flips between seconds and minutes. The typed text is committed
// on Return or when the field loses focus; the controller then clamps it to the allowed range.
export function IntervalEditor(props: {
    testID: string;
    label: string;
    seconds: () => number;
    min: number;
    max: number;
    onChange: (seconds: number) => void;
}) {
    const unit = signal<"s" | "m">(defaultUnit(props.seconds()));
    const draft = signal<string | null>(null);
    const perUnit = () => (unit() === "m" ? 60 : 1);
    const commit = (seconds: number) => {
        const clamped = Math.min(props.max, Math.max(props.min, Math.round(seconds)));
        draft.set(null);
        props.onChange(clamped);
    };
    const typed = (text: string) => {
        const value = Number.parseFloat(text);
        if (Number.isFinite(value)) commit(value * perUnit());
        else draft.set(null);
    };
    return (
        <View class="flex-row items-center gap-1" testID={props.testID}>
            <Button accessibilityLabel={`Decrease ${props.label}`} class="size-6 rounded-full bg-muted items-center justify-center"
                onPress={() => commit(props.seconds() - perUnit())}>
                <Text class="text-sm text-foreground">−</Text>
            </Button>
            <Input
                accessibilityLabel={props.label}
                value={draft() ?? intervalText(props.seconds(), unit())}
                onChange={({ value }) => draft.set(value)}
                onSubmit={({ text }) => typed(text)}
                onBlur={() => typed(draft() ?? intervalText(props.seconds(), unit()))}
                keyboardType="decimal-pad"
                style={{ width: 52, height: 26, paddingHorizontal: 4, borderRadius: 8, textAlign: "center", fontSize: 13 }}
                class="bg-muted text-foreground"
            />
            <Button accessibilityLabel={`Increase ${props.label}`} class="size-6 rounded-full bg-muted items-center justify-center"
                onPress={() => commit(props.seconds() + perUnit())}>
                <Text class="text-sm text-foreground">+</Text>
            </Button>
            <Button accessibilityLabel="Switch between seconds and minutes" class="h-6 px-2 rounded-full bg-muted items-center justify-center"
                onPress={() => { unit.set(unit() === "m" ? "s" : "m"); draft.set(null); }}>
                <Text class="text-xs text-foreground">{unit()}</Text>
            </Button>
        </View>
    );
}
