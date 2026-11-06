//! Private Linux/XDG runtime snapshot storage.
//!
//! This module deliberately uses dir-relative Linux syscalls: every path
//! component is opened with O_NOFOLLOW, so a symlink in XDG_RUNTIME_DIR cannot
//! redirect creation or access outside the intended tree.
const std = @import("std");
const linux = std.os.linux;

pub const max_snapshot_bytes: usize = 256 * 1024;

pub const Inspection = enum { missing, present };

fn validateRuntimeDir(runtime_dir: []const u8) !void {
    if (runtime_dir.len < 2 or runtime_dir[0] != '/' or containsDotDot(runtime_dir) or std.mem.indexOfScalar(u8, runtime_dir, 0) != null) return error.InvalidRuntimeDir;
}

/// Read-only check of `$XDG_RUNTIME_DIR`: the base directory must be absolute, owned by this user and private.
/// Reports whether `superbar` exists yet. Unlike `open`, nothing is created.
pub fn inspect(runtime_dir: []const u8) !Inspection {
    try validateRuntimeDir(runtime_dir);
    const root = try openAbsoluteDir(runtime_dir);
    defer closeFd(root);
    try verifyPrivateDir(root);
    const app_fd = openDirAt(root, "superbar") catch |e| switch (e) {
        error.NotFound => return .missing,
        else => return e,
    };
    defer closeFd(app_fd);
    try verifyPrivateDir(app_fd);
    return .present;
}
const snapshot_name = "snapshot.json";
const lock_name = ".lock";

pub const Store = struct {
    dir_fd: linux.fd_t,
    lock_fd: linux.fd_t,

    /// Open (and, if needed, create) `$XDG_RUNTIME_DIR/superbar`.
    /// runtime_dir must be absolute, owned by this user, and mode 0700.
    pub fn open(runtime_dir: []const u8) !Store {
        try validateRuntimeDir(runtime_dir);
        var root = try openAbsoluteDir(runtime_dir);
        errdefer if (root >= 0) closeFd(root);
        try verifyPrivateDir(root);

        const name = "superbar";
        const app_fd = openDirAt(root, name) catch |e| switch (e) {
            error.NotFound => blk: {
                try syscallOk(linux.mkdirat(root, name, 0o700));
                break :blk try openDirAt(root, name);
            },
            else => return e,
        };
        closeFd(root);
        root = -1;
        errdefer closeFd(app_fd);
        try verifyPrivateDir(app_fd);

        const lock_fd = try openAt(app_fd, lock_name, .{ .CREAT = true, .EXCL = false, .CLOEXEC = true, .NOFOLLOW = true, .ACCMODE = .WRONLY }, 0o600);
        errdefer closeFd(lock_fd);
        try verifyPrivateFile(lock_fd);
        return .{ .dir_fd = app_fd, .lock_fd = lock_fd };
    }

    pub fn close(self: *Store) void {
        closeFd(self.lock_fd);
        closeFd(self.dir_fd);
        self.* = undefined;
    }

    /// Nonblocking exclusive lock. Returns error.Busy if another cooperating
    /// process currently holds it. Call unlock after the operation.
    pub fn lock(self: *Store) !void {
        const rc = linux.flock(self.lock_fd, 2 | 4); // LOCK_EX | LOCK_NB
        if (linux.errno(rc) == .AGAIN) return error.Busy;
        try syscallOk(rc);
    }
    pub fn unlock(self: *Store) void {
        _ = linux.flock(self.lock_fd, 8); // LOCK_UN
    }

    /// Atomically replace snapshot.json. Caller must hold lock(). Bytes are
    /// opaque; enforce the same bound on write and read.
    pub fn write(self: *Store, bytes: []const u8) !void {
        if (bytes.len > max_snapshot_bytes) return error.SnapshotTooLarge;
        const temp = try self.createTemp();
        var tmp = temp.fd;
        errdefer {
            if (tmp >= 0) closeFd(tmp);
            _ = linux.unlinkat(self.dir_fd, temp.name, 0);
            std.heap.page_allocator.free(temp.name);
        }
        var at: usize = 0;
        while (at < bytes.len) {
            const w = linux.write(tmp, bytes[at..].ptr, bytes.len - at);
            if (linux.errno(w) != .SUCCESS) return error.IoFailure;
            if (w == 0) return error.IoFailure;
            at += w;
        }
        try syscallOk(linux.fchmod(tmp, 0o600));
        closeFd(tmp);
        tmp = -1;
        try syscallOk(linux.renameat(self.dir_fd, temp.name, self.dir_fd, snapshot_name));
        std.heap.page_allocator.free(temp.name);
    }

    fn createTemp(self: *Store) !TempFile {
        var random: [16]u8 = undefined;
        var tries: usize = 0;
        while (tries < 8) : (tries += 1) {
            const rc = linux.getrandom(&random, random.len, 0);
            try syscallOk(rc);
            if (rc != random.len) continue;
            const name = try std.fmt.allocPrintSentinel(std.heap.page_allocator, ".snapshot.{x}.tmp", .{std.mem.readInt(u128, &random, .little)}, 0);
            defer std.heap.page_allocator.free(name);
            const fd = openAtZ(self.dir_fd, name, .{ .CREAT = true, .EXCL = true, .CLOEXEC = true, .NOFOLLOW = true, .ACCMODE = .WRONLY }, 0o600) catch |err| {
                if (err == error.AlreadyExists) continue;
                return err;
            };
            const owned = std.heap.page_allocator.dupeSentinel(u8, name, 0) catch |err| {
                closeFd(fd);
                _ = linux.unlinkat(self.dir_fd, name, 0);
                return err;
            };
            return .{ .fd = fd, .name = owned };
        }
        return error.TempNameExhausted;
    }

    /// Read a regular, user-owned, private snapshot while holding lock().
    /// Caller owns returned allocation.
    pub fn read(self: *Store, allocator: std.mem.Allocator) ![]u8 {
        const fd = try openAt(self.dir_fd, snapshot_name, .{ .CLOEXEC = true, .NOFOLLOW = true, .ACCMODE = .RDONLY }, 0);
        defer closeFd(fd);
        try verifyPrivateFile(fd);
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(allocator);
        var buf: [4096]u8 = undefined;
        while (true) {
            const rc = linux.read(fd, &buf, buf.len);
            if (linux.errno(rc) != .SUCCESS) return error.IoFailure;
            if (rc == 0) break;
            if (out.items.len + rc > max_snapshot_bytes) return error.SnapshotTooLarge;
            try out.appendSlice(allocator, buf[0..rc]);
        }
        return out.toOwnedSlice(allocator);
    }
};

const TempFile = struct { fd: linux.fd_t, name: [:0]u8 };

fn containsDotDot(path: []const u8) bool {
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |part| if (std.mem.eql(u8, part, "..")) return true;
    return false;
}

fn openAbsoluteDir(path: []const u8) !linux.fd_t {
    var fd = try openDirAt(linux.AT.FDCWD, "/");
    errdefer closeFd(fd);
    var it = std.mem.splitScalar(u8, path, '/');
    while (it.next()) |part| {
        if (part.len == 0 or std.mem.eql(u8, part, ".")) continue;
        const next = try openDirAt(fd, part);
        closeFd(fd);
        fd = next;
    }
    return fd;
}

fn openDirAt(parent: linux.fd_t, name: []const u8) !linux.fd_t {
    const z = try std.fmt.allocPrintSentinel(std.heap.page_allocator, "{s}", .{name}, 0);
    defer std.heap.page_allocator.free(z);
    return openAtZ(parent, z, .{ .DIRECTORY = true, .NOFOLLOW = true, .CLOEXEC = true, .ACCMODE = .RDONLY }, 0);
}

fn openAt(parent: linux.fd_t, name: []const u8, flags: linux.O, mode: linux.mode_t) !linux.fd_t {
    const z = try std.fmt.allocPrintSentinel(std.heap.page_allocator, "{s}", .{name}, 0);
    defer std.heap.page_allocator.free(z);
    return openAtZ(parent, z, flags, mode);
}
fn openAtZ(parent: linux.fd_t, name: [:0]const u8, flags: linux.O, mode: linux.mode_t) !linux.fd_t {
    const rc = linux.openat(parent, name, flags, mode);
    if (linux.errno(rc) == .NOENT) return error.NotFound;
    if (linux.errno(rc) == .EXIST) return error.AlreadyExists;
    try syscallOk(rc);
    return @intCast(rc);
}

fn verifyPrivateDir(fd: linux.fd_t) !void {
    var st: linux.Statx = undefined;
    try syscallOk(linux.statx(fd, "", 0x1000, .{ .TYPE = true, .MODE = true, .UID = true }, &st)); // AT_EMPTY_PATH
    if (st.uid != linux.getuid() or st.mode & 0o170000 != 0o040000 or st.mode & 0o077 != 0) return error.InsecureDirectory;
}
fn verifyPrivateFile(fd: linux.fd_t) !void {
    var st: linux.Statx = undefined;
    try syscallOk(linux.statx(fd, "", 0x1000, .{ .TYPE = true, .MODE = true, .UID = true }, &st));
    if (st.uid != linux.getuid() or st.mode & 0o170000 != 0o100000 or st.mode & 0o777 != 0o600) return error.InsecureFile;
}
fn syscallOk(rc: usize) !void {
    if (linux.errno(rc) != .SUCCESS) return error.IoFailure;
}
fn closeFd(fd: linux.fd_t) void {
    _ = linux.close(fd);
}

test "inspect reports a missing superbar directory without creating it" {
    const testing = std.testing;
    var random: [8]u8 = undefined;
    try syscallOk(linux.getrandom(&random, random.len, 0));
    const path = try std.fmt.allocPrint(testing.allocator, "/tmp/superbar-inspect-test-{d}-{x}", .{ linux.getpid(), std.mem.readInt(u64, &random, .little) });
    defer testing.allocator.free(path);
    const zpath = try std.fmt.allocPrintSentinel(testing.allocator, "{s}", .{path}, 0);
    defer testing.allocator.free(zpath);
    const app_path = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/superbar", .{path}, 0);
    defer testing.allocator.free(app_path);
    const lock_path = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/superbar/.lock", .{path}, 0);
    defer testing.allocator.free(lock_path);
    try syscallOk(linux.mkdirat(linux.AT.FDCWD, zpath, 0o700));
    defer {
        _ = linux.unlinkat(linux.AT.FDCWD, lock_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, app_path, 0x200); // AT_REMOVEDIR
        _ = linux.unlinkat(linux.AT.FDCWD, zpath, 0x200);
    }
    try testing.expectEqual(Inspection.missing, try inspect(path));
    var stat: linux.Statx = undefined;
    try testing.expect(linux.errno(linux.statx(linux.AT.FDCWD, app_path, 0, .{ .TYPE = true }, &stat)) == .NOENT);
    try testing.expectError(error.InvalidRuntimeDir, inspect("relative/path"));

    // A group-accessible base directory is refused, as it is for open.
    const root_fd = try openAbsoluteDir(path);
    defer closeFd(root_fd);
    try syscallOk(linux.fchmod(root_fd, 0o755));
    try testing.expectError(error.InsecureDirectory, inspect(path));
    try syscallOk(linux.fchmod(root_fd, 0o700));

    var store = try Store.open(path);
    store.close();
    try testing.expectEqual(Inspection.present, try inspect(path));
}

test "private store writes and bounded reads in isolated temp dir" {
    const testing = std.testing;
    var random: [8]u8 = undefined;
    try syscallOk(linux.getrandom(&random, random.len, 0));
    const id = std.mem.readInt(u64, &random, .little);
    const path = try std.fmt.allocPrint(testing.allocator, "/tmp/superbar-store-test-{d}-{x}", .{ linux.getpid(), id });
    defer testing.allocator.free(path);
    const zpath = try std.fmt.allocPrintSentinel(testing.allocator, "{s}", .{path}, 0);
    defer testing.allocator.free(zpath);
    const target_path = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/target", .{path}, 0);
    defer testing.allocator.free(target_path);
    const link_path = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/runtime-link", .{path}, 0);
    defer testing.allocator.free(link_path);
    try syscallOk(linux.mkdirat(linux.AT.FDCWD, zpath, 0o700));
    defer {
        const app_path = std.fmt.allocPrintSentinel(testing.allocator, "{s}/superbar", .{path}, 0) catch unreachable;
        defer testing.allocator.free(app_path);
        const snapshot_path = std.fmt.allocPrintSentinel(testing.allocator, "{s}/snapshot.json", .{app_path}, 0) catch unreachable;
        defer testing.allocator.free(snapshot_path);
        const lock_path = std.fmt.allocPrintSentinel(testing.allocator, "{s}/.lock", .{app_path}, 0) catch unreachable;
        defer testing.allocator.free(lock_path);
        const stale_path = std.fmt.allocPrintSentinel(testing.allocator, "{s}/.snapshot.crash-leftover.tmp", .{app_path}, 0) catch unreachable;
        defer testing.allocator.free(stale_path);
        _ = linux.unlinkat(linux.AT.FDCWD, snapshot_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, lock_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, stale_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, app_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, app_path, 0x200); // AT_REMOVEDIR
        _ = linux.unlinkat(linux.AT.FDCWD, link_path, 0);
        _ = linux.unlinkat(linux.AT.FDCWD, target_path, 0x200);
        _ = linux.unlinkat(linux.AT.FDCWD, zpath, 0x200);
    }

    // Runtime directory permissions are validated instead of silently trusted.
    const root_fd = try openAbsoluteDir(path);
    defer closeFd(root_fd);
    try syscallOk(linux.fchmod(root_fd, 0o755));
    try testing.expectError(error.InsecureDirectory, Store.open(path));
    try syscallOk(linux.fchmod(root_fd, 0o700));

    // A symlink in the configured runtime path is rejected before app data is touched.
    try syscallOk(linux.mkdirat(linux.AT.FDCWD, target_path, 0o700));
    try syscallOk(linux.symlinkat(target_path, linux.AT.FDCWD, link_path));
    try testing.expectError(error.IoFailure, Store.open(link_path));
    _ = linux.unlinkat(linux.AT.FDCWD, link_path, 0);

    // The final superbar component is also opened without following links.
    const app_link = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/superbar", .{path}, 0);
    defer testing.allocator.free(app_link);
    try syscallOk(linux.symlinkat(target_path, linux.AT.FDCWD, app_link));
    try testing.expectError(error.IoFailure, Store.open(path));
    _ = linux.unlinkat(linux.AT.FDCWD, app_link, 0);
    const target_app = try std.fmt.allocPrintSentinel(testing.allocator, "{s}/superbar", .{target_path}, 0);
    defer testing.allocator.free(target_app);
    var target_check: linux.Statx = undefined;
    try testing.expect(linux.errno(linux.statx(linux.AT.FDCWD, target_app, 0, .{ .TYPE = true }, &target_check)) == .NOENT);
    _ = linux.unlinkat(linux.AT.FDCWD, target_path, 0x200);

    var store = try Store.open(path);
    defer store.close();
    try store.lock();
    defer store.unlock();
    try syscallOk(linux.fchmod(store.lock_fd, 0o644));
    try testing.expectError(error.InsecureFile, Store.open(path));
    try syscallOk(linux.fchmod(store.lock_fd, 0o600));
    var second = try Store.open(path);
    defer second.close();
    try testing.expectError(error.Busy, second.lock());
    const stale = try openAt(store.dir_fd, ".snapshot.crash-leftover.tmp", .{ .CREAT = true, .EXCL = true, .CLOEXEC = true, .NOFOLLOW = true, .ACCMODE = .WRONLY }, 0o600);
    closeFd(stale);
    try store.write("synthetic snapshot only");
    // A crash-leftover temp file does not block a new atomic write and is not
    // removed as though it belonged to this invocation.
    var stale_stat: linux.Statx = undefined;
    try syscallOk(linux.statx(store.dir_fd, ".snapshot.crash-leftover.tmp", 0, .{ .TYPE = true }, &stale_stat));
    const readback = try store.read(testing.allocator);
    defer testing.allocator.free(readback);
    try testing.expectEqualStrings("synthetic snapshot only", readback);
    var stat: linux.Statx = undefined;
    try syscallOk(linux.statx(store.dir_fd, "snapshot.json", 0, .{ .MODE = true }, &stat));
    try testing.expectEqual(@as(u16, 0o100600), stat.mode);
    const snapshot_fd = try openAt(store.dir_fd, "snapshot.json", .{ .CLOEXEC = true, .NOFOLLOW = true, .ACCMODE = .RDONLY }, 0);
    try syscallOk(linux.fchmod(snapshot_fd, 0o644));
    try testing.expectError(error.InsecureFile, store.read(testing.allocator));
    try syscallOk(linux.fchmod(snapshot_fd, 0o600));
    closeFd(snapshot_fd);
    try store.write("replacement snapshot");
    const replacement = try store.read(testing.allocator);
    defer testing.allocator.free(replacement);
    try testing.expectEqualStrings("replacement snapshot", replacement);
    try testing.expect(!containsDotDot("/tmp/private"));
    try testing.expect(containsDotDot("/tmp/../private"));
}
