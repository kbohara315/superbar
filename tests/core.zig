const std = @import("std");

const Provider = struct {
    state: []const u8,
    last_success_at: ?[]const u8,
    windows: struct { primary: ?Window, secondary: ?Window },
    @"error": ?struct { code: []const u8, message: []const u8 },
};
const Window = struct { label: []const u8, used_percent: f64, reset_at: ?[]const u8, duration_seconds: ?u64 };
const Snapshot = struct { schema_version: u8, generated_at: []const u8, providers: struct { codex: Provider, claude: Provider } };

test "schema accepts unknown values as null and provider errors independently" {
    const json = "{\"schema_version\":1,\"generated_at\":\"2026-10-31T00:00:00Z\",\"providers\":{\"codex\":{\"state\":\"fresh\",\"last_success_at\":\"2026-10-31T00:00:00Z\",\"windows\":{\"primary\":{\"label\":\"Session\",\"used_percent\":7,\"reset_at\":null,\"duration_seconds\":null},\"secondary\":null},\"error\":null},\"claude\":{\"state\":\"unavailable\",\"last_success_at\":null,\"windows\":{\"primary\":null,\"secondary\":null},\"error\":{\"code\":\"credentials_missing\",\"message\":\"Sign in using Claude Code\"}}}}";
    const parsed = try std.json.parseFromSlice(Snapshot, std.testing.allocator, json, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u8, 1), parsed.value.schema_version);
    try std.testing.expectEqual(@as(f64, 7), parsed.value.providers.codex.windows.primary.?.used_percent);
    try std.testing.expect(parsed.value.providers.claude.windows.primary == null);
    try std.testing.expectEqualStrings("credentials_missing", parsed.value.providers.claude.@"error".?.code);
}
