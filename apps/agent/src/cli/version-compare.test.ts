import { describe, expect, it } from "vitest";
import { compareVersions, isUpdateAvailable, normalizeVersionLabel } from "./version-compare";

describe("version-compare", () => {
  it("compares semver and prerelease", () => {
    expect(compareVersions("2.1.156", "2.1.154")).toBeGreaterThan(0);
    expect(compareVersions("2.1.154", "2.1.156")).toBeLessThan(0);
    expect(compareVersions("2.1.156", "2.1.156")).toBe(0);
    expect(compareVersions("2.1.156-beta.1", "2.1.156")).toBeLessThan(0);
    expect(compareVersions("0.45.0-nightly.1", "0.44.1")).toBeGreaterThan(0);
  });

  it("compares Cursor calendar builds", () => {
    expect(compareVersions("2026.09.08-6caf4ff", "2026.08.26-aaaaaaa")).toBeGreaterThan(0);
    expect(compareVersions("2026.09.08-6caf4ff", "2026.09.08-6caf4ff")).toBe(0);
    expect(isUpdateAvailable("2026.08.01-abc", "2026.09.08-6caf4ff")).toBe(true);
    expect(isUpdateAvailable("2026.09.08-6caf4ff", "2026.09.08-6caf4ff")).toBe(false);
  });

  it("does not flag update when local is ahead of latest", () => {
    expect(isUpdateAvailable("2.1.156", "2.1.154")).toBe(false);
    expect(isUpdateAvailable("2.1.154", "2.1.156")).toBe(true);
    expect(isUpdateAvailable(undefined, "1.0.0")).toBe(false);
  });

  it("normalizes branded version labels", () => {
    expect(normalizeVersionLabel("codex-cli 0.153.4")).toBe("0.153.4");
    expect(normalizeVersionLabel("2026.09.08-6caf4ff")).toBe("2026.09.08-6caf4ff");
  });
});
