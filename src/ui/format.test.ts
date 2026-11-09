import { expect, test } from "nsh/test";
import { cardView, COLORS, defaultUnit, headerStatus, intervalText, sparkHeights, windowRow } from "./format";
import { packTiles } from "./MetricTiles";
import { HOUR, MINUTE, provider, T0, window } from "../../tests/fakes";

test("a window row shows the amount shown, fills with it, and turns red at 90% used", () => {
    const fresh = windowRow(window("5-hour", 20), T0, "remaining", COLORS.codex);
    expect(fresh.percentText).toBe("80% left");
    expect(fresh.fill).toBe(80);
    expect(fresh.fillColor).toBe(COLORS.codex);
    expect(fresh.resetText.startsWith("↻ 3h 0m")).toBe(true);

    const used = windowRow(window("5-hour", 20), T0, "used", COLORS.codex);
    expect(used.percentText).toBe("20% used");
    expect(used.fill).toBe(20);

    const hot = windowRow(window("5-hour", 92), T0, "remaining", COLORS.codex);
    expect(hot.fillColor).toBe(COLORS.alert);
    expect(hot.percentText).toBe("8% left");
});

test("an expired window reads as reset with unknown usage, an empty bar and the awaiting-data line", () => {
    const row = windowRow(window("5-hour", 40, -HOUR), T0, "remaining", COLORS.codex);
    expect(row.percentText).toBe("reset · usage unknown");
    expect(row.resetText).toBe("↻ reset passed · awaiting data");
    expect(row.fill).toBe(0);
    expect(row.expired).toBe(true);
});

test("a missing window shows unavailable with an empty bar and no reset line", () => {
    const row = windowRow(null, T0, "remaining", COLORS.codex);
    expect(row.percentText).toBe("unavailable");
    expect(row.resetText).toBe("");
    expect(row.fill).toBe(0);
});

test("a card's token line says expires, renews on next use, or the failed sign-in", () => {
    const live = provider("fresh", window("5-hour", 10));
    const expiring = { ...live, expires_at: new Date(T0 + 20 * MINUTE).toISOString() };
    expect(cardView("codex", expiring, T0, null).token).toBe("token expires in 20m");
    expect(cardView("codex", expiring, T0, null).synced.startsWith("Synced ")).toBe(true);

    const past = { ...live, expires_at: new Date(T0 - MINUTE).toISOString() };
    expect(cardView("codex", past, T0, null).token).toBe("token renews on next use");

    const failed = { ...past, state: "stale" as const, error: { code: "authentication_required", message: "x" } };
    expect(cardView("claude", failed, T0, null).token).toBe("token expired · sign in again");
    expect(cardView("claude", failed, T0, null).reason).toBe("authentication_required: Run `claude` to sign in again");
});

test("the card's live expiry from the credential file wins over the saved one", () => {
    const saved = { ...provider("fresh", window("5-hour", 10)), expires_at: new Date(T0 - MINUTE).toISOString() };
    const renewed = new Date(T0 + 45 * MINUTE).toISOString();
    expect(cardView("codex", saved, T0, renewed).token).toBe("token expires in 45m");
    
});

test("the header says what the last refresh did and nothing when it succeeded", () => {
    expect(headerStatus("refreshing", true)).toBe("Refreshing…");
    expect(headerStatus("busy", false)).toBe("Refresh busy");
    expect(headerStatus("timeout", false)).toBe("Refresh timed out");
    expect(headerStatus("failed", false)).toBe("Refresh failed");
    expect(headerStatus("idle", false)).toBe("");
});

test("tiles pack two per row, network takes a row of its own, and a lone tile keeps half width", () => {
    expect(packTiles(["cpu", "memory", "swap"])).toEqual([["cpu", "memory"], ["swap", null]]);
    expect(packTiles(["cpu", "network", "disk"])).toEqual([["cpu", null], ["network"], ["disk", null]]);
    expect(packTiles([])).toEqual([]);
});

test("interval text follows the unit, and the unit starts in minutes only for whole minutes", () => {
    expect(intervalText(90, "m")).toBe("1.5");
    expect(intervalText(90, "s")).toBe("90");
    expect(defaultUnit(120)).toBe("m");
    expect(defaultUnit(90)).toBe("s");
});

test("sparkline heights scale to 100 for percentages and to the busiest sample for rates", () => {
    expect(sparkHeights([50, 100], false)).toEqual([0.5, 1]);
    // Rates are bytes per second; the busiest sample here is above the 32 KiB/s floor.
    expect(sparkHeights([8192, 16384, 32768 * 2], true)).toEqual([0.125, 0.25, 1]);
    expect(sparkHeights([], true)).toEqual([]);
});

test("an idle link does not amplify noise: rates scale to the floor, not to the noise", () => {
    const heights = sparkHeights([100, 200, 150], true);
    expect(heights.every(height => height < 0.01)).toBe(true);
});
