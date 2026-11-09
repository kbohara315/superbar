// System metric tiles: enabled metrics in two columns, network on a row of its own. A tile click samples that metric;
// the CPU and memory tiles also open the top-five process list.

import { Image, Text, View } from "nsh";
import { Button } from "nsh/base";
import type { Controller } from "../controller";
import type { MetricName } from "../types";
import { COLORS, METRIC_TITLE, sparkHeights, tileView } from "./format";
import { metricIconUri } from "./icons";

export const METRIC_ORDER: readonly MetricName[] = ["cpu", "memory", "swap", "disk", "network", "battery", "temperature"];
const WIDE: readonly MetricName[] = ["network"];
const SPARK: readonly MetricName[] = ["cpu", "network"];
const PROCESS: readonly MetricName[] = ["cpu", "memory"];
const SPARK_SAMPLES = 30;
// The wide network tile draws a longer sparkline than the narrow tiles.
const WIDE_SPARK_SAMPLES = 64;

// Rows of tiles: two per row, a wide tile takes a row of its own, and a lone narrow tile keeps half width (`null`
// is the empty half).
export function packTiles(names: readonly MetricName[]): (MetricName | null)[][] {
    const rows: (MetricName | null)[][] = [];
    let row: (MetricName | null)[] = [];
    let slots = 0;
    for (const name of names) {
        const need = WIDE.includes(name) ? 2 : 1;
        if (row.length === 0 || slots + need > 2) {
            if (row.length > 0) {
                if (slots === 1) row.push(null);
                rows.push(row);
            }
            row = [];
            slots = 0;
        }
        row.push(name);
        slots += need;
    }
    if (row.length > 0) {
        if (slots === 1) row.push(null);
        rows.push(row);
    }
    return rows;
}

function Spark(props: { history: () => number[]; color: () => string; unbounded: boolean; samples: number }) {
    return (
        <View class="flex-row items-end h-4 gap-px">
            {/* The heights are computed once per change of the history, not once per bar. */}
            {(() => {
                const heights = sparkHeights(props.history(), props.unbounded);
                const offset = props.samples - heights.length;
                return Array.from({ length: props.samples }, (_, index) => {
                    const h = index < offset ? 0 : heights[index - offset];
                    return (
                        <View
                            style={{ flex: 1, height: Math.max(1, Math.round(16 * h)), borderRadius: 1, backgroundColor: props.color() }}
                        />
                    );
                });
            })()}
        </View>
    );
}

function MetricTile(props: { controller: Controller; name: MetricName }) {
    const c = props.controller;
    const name = props.name;
    const view = () => tileView(name, c.metrics()[name], c.settings().diskAlertThreshold);
    const color = () => (view().alert ? COLORS.alert : COLORS.metric[name]);
    const press = () => {
        if (PROCESS.includes(name)) c.toggleProcesses(name as "cpu" | "memory");
        void c.sampleMetric(name);
    };
    return (
        <Button
            testID={`tile-${name}`}
            accessibilityLabel={`Refresh ${METRIC_TITLE[name]}`}
            class="flex-1 rounded-xl bg-card border border-border p-2.5 gap-2 min-w-0"
            onPress={press}
        >
            <View class="flex-row items-center gap-1.5">
                <Image src={metricIconUri(name, COLORS.metric[name])} style={{ width: 14, height: 14 }} />
                <Text class="truncate text-sm font-semibold text-foreground">{view().value}</Text>
                <Text class="flex-1 text-right text-xs text-muted-foreground">{view().detail}</Text>
            </View>
            {SPARK.includes(name) ? (
                <Spark history={() => view().history} color={color} unbounded={name === "network"}
                    samples={name === "network" ? WIDE_SPARK_SAMPLES : SPARK_SAMPLES} />
            ) : (
                <View class="h-1.5 rounded-full bg-muted overflow-hidden">
                    <View style={{ width: `${view().fill}%`, minWidth: view().fill > 0 ? 4 : 0, height: "100%", borderRadius: 3, backgroundColor: color() }} />
                </View>
            )}
        </Button>
    );
}

function ProcessList(props: { controller: Controller; metric: "cpu" | "memory" }) {
    const c = props.controller;
    const rows = () => c.processes().rows ?? [];
    // Loading (no rows yet) and the first CPU list (placeholders only, until a second reading) both show "sampling…".
    const loading = () => c.processes().rows === null;
    const placeholders = () => props.metric === "cpu" && rows().length > 0 && rows().every(row => row.text === "—");
    const waiting = () => loading() || placeholders();
    return (
        <View class="rounded-xl bg-card border border-border p-3 gap-1.5" testID={`processes-${props.metric}`}>
            <Text class="text-xs font-semibold text-muted-foreground">{`TOP PROCESSES · ${METRIC_TITLE[props.metric].toUpperCase()}`}</Text>
            {waiting() ? <Text class="text-xs text-muted-foreground" testID={`processes-${props.metric}-sampling`}>sampling…</Text> : null}
            {!waiting() && rows().length === 0 ? <Text class="text-xs text-muted-foreground">no processes</Text> : null}
            {waiting() ? null : rows().map(row => (
                <View class="flex-row items-center gap-2">
                    <Text class="flex-1 truncate text-sm text-foreground">{row.name}</Text>
                    <Text class="text-sm font-semibold text-foreground">{row.text}</Text>
                </View>
            ))}
        </View>
    );
}

export function MetricTiles(props: { controller: Controller }) {
    const c = props.controller;
    const names = () => METRIC_ORDER.filter(name => c.settings().metrics[name].enabled);
    const open = () => c.processes().metric;
    return (
        <View class="gap-2">
            {packTiles(names()).map(row => (
                <View class="flex-row gap-2">
                    {row.map(name => (name ? <MetricTile controller={c} name={name} /> : <View class="flex-1" />))}
                </View>
            ))}
            {open() === "cpu" || open() === "memory" ? <ProcessList controller={c} metric={open() as "cpu" | "memory"} /> : null}
        </View>
    );
}
