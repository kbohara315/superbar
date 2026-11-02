const std = @import("std");
const store_mod = @import("store.zig");

const Snapshot = struct {
    schema_version: u8 = 1,
    generated_at: []const u8 = "",
    providers: Providers,
};
const Providers = struct { codex: Provider, claude: Provider };
const Provider = struct {
    state: []const u8 = "unavailable",
    last_success_at: ?[]const u8 = null,
    windows: Windows = .{},
    @"error": ?Error = null,
};
const Windows = struct { primary: ?Window = null, secondary: ?Window = null };
const Window = struct { label: []const u8, used_percent: f64, reset_at: ?[]const u8 = null, duration_seconds: ?u64 = null };
const Error = struct { code: []const u8, message: []const u8 };
const HttpResponse = struct { status: u16, body: []u8 };
const ProviderSelection = enum { all, codex, claude };

fn parseProviderSelection(value: []const u8) !ProviderSelection {
    if (std.mem.eql(u8, value, "all")) return .all;
    if (std.mem.eql(u8, value, "codex")) return .codex;
    if (std.mem.eql(u8, value, "claude")) return .claude;
    return error.InvalidProvider;
}

test "provider selection supports global and targeted refresh" {
    try std.testing.expectEqual(ProviderSelection.all, try parseProviderSelection("all"));
    try std.testing.expectEqual(ProviderSelection.codex, try parseProviderSelection("codex"));
    try std.testing.expectEqual(ProviderSelection.claude, try parseProviderSelection("claude"));
    try std.testing.expectError(error.InvalidProvider, parseProviderSelection("unknown"));
}

const max_credential_bytes = 64 * 1024;
const max_response_bytes = 256 * 1024;
// The isolated worker performs both providers sequentially. This deadline is
// deliberately larger than their individual request budgets, while still
// bounding DNS, TLS, socket, parsing, and filesystem stalls in the CLI caller.
const fetch_worker_timeout_ns: u64 = 35 * std.time.ns_per_s;
const ResponseBuffer = struct {
    writer: std.Io.Writer,
    bytes: [max_response_bytes]u8 = undefined,
    fn init(self: *ResponseBuffer) void {
        self.writer = .fixed(&self.bytes);
    }
    fn slice(self: *ResponseBuffer) []const u8 {
        return self.bytes[0..self.writer.end];
    }
};

fn field(v: std.json.Value, name: []const u8) ?std.json.Value {
    if (v != .object) return null;
    return v.object.get(name);
}
fn fieldString(v: std.json.Value, name: []const u8) ?[]const u8 {
    const x = field(v, name) orelse return null;
    return if (x == .string and x.string.len != 0) x.string else null;
}
fn fieldNumber(v: std.json.Value, name: []const u8) ?f64 {
    const x = field(v, name) orelse return null;
    return switch (x) {
        .float => x.float,
        .integer => @floatFromInt(x.integer),
        else => null,
    };
}
fn epochIso(allocator: std.mem.Allocator, seconds: f64) ?[]const u8 {
    if (!std.math.isFinite(seconds) or seconds < 0 or seconds > 253402300799) return null;
    const whole: u64 = @intFromFloat(seconds);
    const ep = std.time.epoch.EpochSeconds{ .secs = whole };
    const yd = ep.getEpochDay().calculateYearDay();
    const md = yd.calculateMonthDay();
    const ds = ep.getDaySeconds();
    return std.fmt.allocPrint(allocator, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z", .{
        yd.year, md.month.numeric(), md.day_index + 1, ds.getHoursIntoDay(), ds.getMinutesIntoHour(), ds.getSecondsIntoMinute(),
    }) catch null;
}
fn parseWindow(v: std.json.Value, label: []const u8, allocator: std.mem.Allocator) ?Window {
    const percent = fieldNumber(v, "utilization") orelse fieldNumber(v, "used_percent") orelse return null;
    if (!std.math.isFinite(percent) or percent < 0 or percent > 100) return null;
    const reset_value = field(v, "resets_at") orelse field(v, "reset_at");
    const reset: ?[]const u8 = if (reset_value) |rv| switch (rv) {
        .string => |s| allocator.dupe(u8, s) catch null,
        .integer => |n| epochIso(allocator, @floatFromInt(n)),
        .float => |n| epochIso(allocator, n),
        else => null,
    } else null;
    const duration: ?u64 = if (fieldNumber(v, "limit_window_seconds")) |n| if (n >= 0 and n <= 31536000 and @floor(n) == n) @intFromFloat(n) else null else null;
    return .{ .label = label, .used_percent = percent, .reset_at = reset, .duration_seconds = duration };
}
fn parseCodex(body: []const u8, allocator: std.mem.Allocator) !Windows {
    // The JSON tree is only inspected while `body` is alive. Borrowing string
    // values avoids duplicating response text into the fetch worker's arena.
    const p = try std.json.parseFromSlice(std.json.Value, allocator, body, .{ .allocate = .alloc_if_needed });
    defer p.deinit();
    const rate = field(p.value, "rate_limit") orelse return error.InvalidResponse;
    return .{ .primary = if (field(rate, "primary_window")) |v| parseWindow(v, "Session", allocator) else null, .secondary = if (field(rate, "secondary_window")) |v| parseWindow(v, "Additional limit", allocator) else null };
}
fn parseClaude(body: []const u8, allocator: std.mem.Allocator) !Windows {
    const p = try std.json.parseFromSlice(std.json.Value, allocator, body, .{ .allocate = .alloc_if_needed });
    defer p.deinit();
    return .{ .primary = if (field(p.value, "five_hour")) |v| parseWindow(v, "5-hour", allocator) else null, .secondary = if (field(p.value, "seven_day")) |v| parseWindow(v, "7-day", allocator) else null };
}
fn readBounded(io: std.Io, allocator: std.mem.Allocator, path: []const u8) ![]u8 {
    return std.Io.Dir.cwd().readFileAlloc(io, path, allocator, .limited(max_credential_bytes));
}
fn httpGet(init: std.process.Init, url: []const u8, token: []const u8, account: ?[]const u8, claude: bool) !HttpResponse {
    var client: std.http.Client = .{ .allocator = init.gpa, .io = init.io };
    defer client.deinit();
    const auth = try std.fmt.allocPrint(init.gpa, "Bearer {s}", .{token});
    defer init.gpa.free(auth);
    var headers: [4]std.http.Header = undefined;
    headers[0] = .{ .name = "authorization", .value = auth };
    var count: usize = 1;
    if (account) |a| {
        headers[count] = .{ .name = "chatgpt-account-id", .value = a };
        count += 1;
    }
    if (claude) {
        headers[count] = .{ .name = "anthropic-beta", .value = "oauth-2025-04-20" };
        count += 1;
    }
    headers[count] = .{ .name = "user-agent", .value = "superbar/1.0" };
    count += 1;
    var rb: ResponseBuffer = .{ .writer = undefined };
    rb.init();
    // Never forward bearer credentials through a redirect. `unhandled` also
    // prevents redirect-based token exfiltration.
    // In Zig 0.17's std.http.Client, privileged_headers are only considered
    // during redirect handling; extra_headers are the headers sent on wire.
    // Redirects stay unhandled so credentials can never be forwarded.
    const result = try client.fetch(.{ .location = .{ .url = url }, .method = .GET, .redirect_behavior = .unhandled, .extra_headers = headers[0..count], .response_writer = &rb.writer });
    return .{ .status = @backingInt(result.status), .body = try init.gpa.dupe(u8, rb.slice()) };
}

fn emptySnapshot() Snapshot {
    return .{ .providers = .{ .codex = fetchError("snapshot_missing", "No saved snapshot. Use the panel menu to refresh."), .claude = fetchError("snapshot_missing", "No saved snapshot. Use the panel menu to refresh.") } };
}

fn openStore(init: std.process.Init) !store_mod.Store {
    const runtime = init.environ_map.get("XDG_RUNTIME_DIR") orelse return error.NoRuntimeDir;
    return store_mod.Store.open(runtime);
}

pub fn main(init: std.process.Init) !void {
    var args = std.process.Args.Iterator.init(init.minimal.args);
    _ = args.next();
    const command = args.next() orelse "status";
    if (std.mem.eql(u8, command, "fetch")) {
        var selection: ProviderSelection = .all;
        while (args.next()) |arg| {
            if (std.mem.eql(u8, arg, "--provider")) selection = try parseProviderSelection(args.next() orelse return error.InvalidProvider);
        }
        return fetch(init, selection);
    }
    if (std.mem.eql(u8, command, "--fetch-worker")) return fetchSnapshot(init, false, try parseProviderSelection(args.next() orelse "all"));
    if (!std.mem.eql(u8, command, "status")) return error.InvalidCommand;
    var initial: ?std.json.Parsed(Snapshot) = null;
    if (openStore(init)) |store_value| {
        var store = store_value;
        defer store.close();
        if (store.lock()) {
            defer store.unlock();
            if (store.read(init.gpa)) |bytes| {
                defer init.gpa.free(bytes);
                initial = std.json.parseFromSlice(Snapshot, init.gpa, bytes, .{ .allocate = .alloc_always }) catch null;
            } else |_| {}
        } else |_| {}
    } else |_| {}
    const parsed = initial orelse return error.SnapshotUnavailable;
    defer parsed.deinit();
    if (parsed.value.schema_version != 1) return error.UnsupportedSchema;
    const safe_json = try std.json.Stringify.valueAlloc(init.gpa, parsed.value, .{});
    defer init.gpa.free(safe_json);
    try std.Io.File.writeStreamingAll(.stdout(), init.io, safe_json);
    try std.Io.File.writeStreamingAll(.stdout(), init.io, "\n");
}

fn credentialPath(a: std.mem.Allocator, env: *std.process.Environ.Map, subpath: []const u8) ![]u8 {
    if (env.get("CODEX_HOME")) |codex| if (std.mem.eql(u8, subpath, ".codex/auth.json")) return std.fmt.allocPrint(a, "{s}/auth.json", .{codex});
    const home = env.get("HOME") orelse return error.CredentialsMissing;
    return std.fmt.allocPrint(a, "{s}/{s}", .{ home, subpath });
}
fn fetchProvider(init: std.process.Init, codex: bool) Provider {
    const path = credentialPath(init.gpa, init.environ_map, if (codex) ".codex/auth.json" else ".claude/.credentials.json") catch return .{ .@"error" = .{ .code = "credentials_missing", .message = "Credential file unavailable" } };
    defer init.gpa.free(path);
    const bytes = readBounded(init.io, init.gpa, path) catch return .{ .@"error" = .{ .code = "credentials_unavailable", .message = "Could not read credential file" } };
    defer init.gpa.free(bytes);
    const parsed = std.json.parseFromSlice(std.json.Value, init.gpa, bytes, .{ .allocate = .alloc_always }) catch return .{ .@"error" = .{ .code = "credentials_invalid", .message = "Credential file is invalid" } };
    defer parsed.deinit();
    const token = if (codex) fieldString(field(parsed.value, "tokens") orelse .null, "access_token") else fieldString(field(parsed.value, "claudeAiOauth") orelse .null, "accessToken");
    if (token == null) return .{ .@"error" = .{ .code = "credentials_missing", .message = "Access token unavailable" } };
    const account = if (codex) fieldString(field(parsed.value, "tokens") orelse .null, "account_id") else null;
    const response = httpGet(init, if (codex) "https://chatgpt.com/backend-api/wham/usage" else "https://api.anthropic.com/api/oauth/usage", token.?, account, !codex) catch |err| {
        return switch (err) {
            error.StreamTooLong => fetchError("response_too_large", "Provider response exceeded the size limit"),
            error.Timeout => fetchError("timeout", "Provider request timed out"),
            else => fetchError("network_error", "Could not connect to provider"),
        };
    };
    defer init.gpa.free(response.body);
    if (response.status != 200) {
        return httpErrorProvider(response.status);
    }
    const windows = (if (codex) parseCodex(response.body, init.gpa) else parseClaude(response.body, init.gpa)) catch return fetchError("response_invalid", "Provider response was invalid");
    if (windows.primary == null and windows.secondary == null) return fetchError("response_invalid", "Provider response contained no valid usage windows");
    return .{ .state = "fresh", .last_success_at = nowIso(init) catch null, .windows = windows };
}
fn freeProvider(init: std.process.Init, p: Provider) void {
    inline for (.{ p.windows.primary, p.windows.secondary }) |maybe_window| {
        if (maybe_window) |w| if (w.reset_at) |reset| init.gpa.free(reset);
    }
    if (p.last_success_at) |stamp| init.gpa.free(stamp);
}
fn nowIso(init: std.process.Init) ![]const u8 {
    const secs = std.Io.Clock.Timestamp.now(init.io, .real).raw.toSeconds();
    return (epochIso(init.gpa, @floatFromInt(secs)) orelse return error.ClockUnavailable);
}
fn fetchError(code: []const u8, message: []const u8) Provider {
    return .{ .state = "unavailable", .@"error" = .{ .code = code, .message = message } };
}
fn httpErrorProvider(status: u16) Provider {
    return switch (status) {
        401 => fetchError("authentication_required", "Provider rejected authentication; sign-in may have expired"),
        403 => fetchError("access_denied", "Provider denied access to usage data"),
        429 => fetchError("rate_limited", "Provider rate limit reached"),
        500...599 => fetchError("provider_server_error", "Provider is temporarily unavailable"),
        else => fetchError("http_error", "Provider returned an unexpected HTTP status"),
    };
}
fn fetch(init: std.process.Init, selection: ProviderSelection) !void {
    // Keep all credential reads and network work in a disposable child. The
    // child owns the runtime lock; timeout termination therefore closes its
    // descriptors and releases the lock even if a resolver/TLS call is stuck.
    const executable = try std.process.executablePathAlloc(init.io, init.gpa);
    defer init.gpa.free(executable);
    const argv = [_][]const u8{ executable, "--fetch-worker", @tagName(selection) };
    const result = runBounded(init.gpa, init.io, &argv, fetch_worker_timeout_ns) catch |err| switch (err) {
        error.Timeout => return error.FetchTimedOut,
        else => return err,
    };
    defer init.gpa.free(result.stdout);
    defer init.gpa.free(result.stderr);
    switch (result.term) {
        .exited => |code| if (code != 0) return error.FetchWorkerFailed,
        else => return error.FetchWorkerFailed,
    }
    // Read the canonical sanitized snapshot only after the worker has exited,
    // avoiding a second fetch and ensuring no worker output carries secrets.
    var store = try openStore(init);
    defer store.close();
    try store.lock();
    defer store.unlock();
    const json = try store.read(init.gpa);
    defer init.gpa.free(json);
    try std.Io.File.writeStreamingAll(.stdout(), init.io, json);
    try std.Io.File.writeStreamingAll(.stdout(), init.io, "\n");
}

fn runBounded(allocator: std.mem.Allocator, io: std.Io, argv: []const []const u8, timeout_ns: u64) !std.process.RunResult {
    return std.process.run(allocator, io, .{
        .argv = argv,
        .stdout_limit = .limited(1024),
        .stderr_limit = .limited(1024),
        .timeout = .{ .duration = .{ .raw = .{ .nanoseconds = timeout_ns }, .clock = .awake } },
    });
}

fn fetchSnapshot(init: std.process.Init, print_json: bool, selection: ProviderSelection) !void {
    // Prevent overlapping fetches and concurrent readers. If another process
    // owns the lock, fail explicitly without changing the previous snapshot.
    var store = try openStore(init);
    defer store.close();
    try store.lock();
    defer store.unlock();
    // Keep a parsed previous snapshot alive through serialization so stale
    // windows can borrow its strings without copying or invalidating them.
    const previous_bytes = store.read(init.gpa) catch null;
    defer if (previous_bytes) |bytes| init.gpa.free(bytes);
    const previous = if (previous_bytes) |bytes| std.json.parseFromSlice(Snapshot, init.gpa, bytes, .{ .allocate = .alloc_if_needed }) catch null else null;
    defer if (previous) |parsed| parsed.deinit();
    const generated = try nowIso(init);
    defer init.gpa.free(generated);
    const fetch_codex = selection != .claude;
    const fetch_claude = selection != .codex;
    var codex = if (fetch_codex) fetchProvider(init, true) else if (previous) |old| old.value.providers.codex else fetchError("not_fetched", "Provider was not refreshed yet");
    var claude = if (fetch_claude) fetchProvider(init, false) else if (previous) |old| old.value.providers.claude else fetchError("not_fetched", "Provider was not refreshed yet");
    if (previous) |old| {
        if (old.value.schema_version == 1) {
            if (fetch_codex) carryForwardIfUnavailable(init.gpa, &codex, old.value.providers.codex) catch {};
            if (fetch_claude) carryForwardIfUnavailable(init.gpa, &claude, old.value.providers.claude) catch {};
        }
    }
    const snapshot = Snapshot{ .generated_at = generated, .providers = .{ .codex = codex, .claude = claude } };
    defer if (fetch_codex) freeProvider(init, snapshot.providers.codex);
    defer if (fetch_claude) freeProvider(init, snapshot.providers.claude);
    const json = try std.json.Stringify.valueAlloc(init.gpa, snapshot, .{});
    defer init.gpa.free(json);
    try store.write(json);
    if (print_json) {
        try std.Io.File.writeStreamingAll(.stdout(), init.io, json);
        try std.Io.File.writeStreamingAll(.stdout(), init.io, "\n");
    }
}

fn carryForwardIfUnavailable(allocator: std.mem.Allocator, current: *Provider, previous: Provider) !void {
    if (std.mem.eql(u8, current.state, "fresh") or (previous.windows.primary == null and previous.windows.secondary == null)) return;
    const stamp = if (previous.last_success_at) |value| try allocator.dupe(u8, value) else null;
    errdefer if (stamp) |value| allocator.free(value);
    const primary_reset = if (previous.windows.primary) |window| if (window.reset_at) |value| try allocator.dupe(u8, value) else null else null;
    errdefer if (primary_reset) |value| allocator.free(value);
    const secondary_reset = if (previous.windows.secondary) |window| if (window.reset_at) |value| try allocator.dupe(u8, value) else null else null;
    errdefer if (secondary_reset) |value| allocator.free(value);
    current.state = "stale";
    current.last_success_at = stamp;
    current.windows = previous.windows;
    if (current.windows.primary) |*window| window.reset_at = primary_reset;
    if (current.windows.secondary) |*window| window.reset_at = secondary_reset;
}

test "failed refresh carries forward last good usage and timestamp" {
    const testing = std.testing;
    var current = fetchError("network_error", "Could not connect to provider");
    const previous = Provider{
        .state = "fresh",
        .last_success_at = "2026-10-31T10:00:00Z",
        .windows = .{ .primary = .{ .label = "Session", .used_percent = 42, .reset_at = "2026-11-01T00:00:00Z" } },
    };
    try carryForwardIfUnavailable(testing.allocator, &current, previous);
    defer {
        testing.allocator.free(current.last_success_at.?);
        testing.allocator.free(current.windows.primary.?.reset_at.?);
    }
    try testing.expectEqualStrings("stale", current.state);
    try testing.expectEqualStrings("network_error", current.@"error".?.code);
    try testing.expectEqual(@as(f64, 42), current.windows.primary.?.used_percent);
    try testing.expectEqualStrings("2026-10-31T10:00:00Z", current.last_success_at.?);
}

test "provider parsers normalize synthetic usage windows" {
    const codex = try parseCodex("{\"rate_limit\":{\"primary_window\":{\"used_percent\":23,\"limit_window_seconds\":18000},\"secondary_window\":{\"utilization\":55}}}", std.testing.allocator);
    try std.testing.expectEqual(@as(f64, 23), codex.primary.?.used_percent);
    try std.testing.expectEqual(@as(?u64, 18000), codex.primary.?.duration_seconds);
    const claude = try parseClaude("{\"five_hour\":{\"utilization\":12},\"seven_day\":{\"utilization\":34}}", std.testing.allocator);
    try std.testing.expectEqual(@as(f64, 34), claude.secondary.?.used_percent);
}

test "Codex numeric reset timestamp becomes UTC and invalid windows are rejected" {
    const windows = try parseCodex("{\"rate_limit\":{\"primary_window\":{\"used_percent\":25,\"reset_at\":1790812800},\"secondary_window\":{\"used_percent\":101}}}", std.testing.allocator);
    defer if (windows.primary.?.reset_at) |reset| std.testing.allocator.free(reset);
    try std.testing.expectEqualStrings("2026-10-01T00:00:00Z", windows.primary.?.reset_at.?);
    try std.testing.expect(windows.secondary == null);
}

test "HTTP statuses map to safe provider error categories" {
    try std.testing.expectEqualStrings("authentication_required", httpErrorProvider(401).@"error".?.code);
    try std.testing.expectEqualStrings("access_denied", httpErrorProvider(403).@"error".?.code);
    try std.testing.expectEqualStrings("rate_limited", httpErrorProvider(429).@"error".?.code);
    try std.testing.expectEqualStrings("provider_server_error", httpErrorProvider(503).@"error".?.code);
}

test "worker watchdog terminates and reaps a deterministic stalled child" {
    const argv = [_][]const u8{ "/bin/sleep", "5" };
    const started = std.Io.Clock.Timestamp.now(std.testing.io, .awake);
    try std.testing.expectError(error.Timeout, runBounded(std.testing.allocator, std.testing.io, &argv, 20 * std.time.ns_per_ms));
    const elapsed = started.durationFromNow(std.testing.io);
    try std.testing.expect(elapsed.raw.nanoseconds < 2 * std.time.ns_per_s);
}
