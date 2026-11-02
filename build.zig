const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    // Ship the size-optimized binary by default. Callers can still select
    // Debug, Safe, or Fast with -Doptimize=<mode> or Zig's --release flag.
    if (b.graph.release_mode == .off) b.graph.release_mode = .small;
    const optimize = b.standardOptimizeOption(.{});
    const strip = b.option(bool, "strip", "Strip debug information from the executable") orelse (optimize != .debug);
    const module = b.createModule(.{ .root_source_file = b.path("src/main.zig"), .target = target, .optimize = optimize, .strip = strip });
    const exe = b.addExecutable(.{ .name = "superbar", .root_module = module });
    b.installArtifact(exe);
    const run = b.addRunArtifact(exe);
    b.step("run", "Run superbar").dependOn(&run.step);
    const test_step = b.step("test", "Run unit and isolated integration tests");

    const core_tests = b.addTest(.{ .root_module = b.createModule(.{ .root_source_file = b.path("tests/core.zig"), .target = target, .optimize = optimize }) });
    test_step.dependOn(&b.addRunArtifact(core_tests).step);

    const app_test_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    const app_tests = b.addTest(.{ .root_module = app_test_module });
    const run_app_tests = b.addRunArtifact(app_tests);
    test_step.dependOn(&run_app_tests.step);

    const store_tests = b.addTest(.{ .root_module = b.createModule(.{ .root_source_file = b.path("src/store.zig"), .target = target, .optimize = optimize }) });
    test_step.dependOn(&b.addRunArtifact(store_tests).step);

    const integration = b.addSystemCommand(&.{ "bash", "tests/integration.sh" });
    integration.setCwd(b.path("."));
    integration.addArtifactArg(exe);
    integration.step.dependOn(&run_app_tests.step);
    test_step.dependOn(&integration.step);
}
