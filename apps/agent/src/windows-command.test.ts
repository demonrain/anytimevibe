import { describe, expect, it } from "vitest";
import {
  normalizeWindowsCommandPath,
  windowsCmdArguments,
  windowsExecutableRank,
  windowsLauncherCandidates,
  windowsNeedsCmdShim
} from "./windows-command";

describe("Windows command invocation", () => {
  it("wraps cmd scripts with the double outer quotes required by cmd /s /c", () => {
    expect(windowsCmdArguments("C:\\Program Files\\nodejs\\codex.cmd", ["--version"])).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\nodejs\\codex.cmd" --version"'
    ]);
  });

  it("removes quotes supplied through CODEX_COMMAND", () => {
    expect(normalizeWindowsCommandPath('"C:\\Program Files\\nodejs\\codex.cmd"')).toBe(
      "C:\\Program Files\\nodejs\\codex.cmd"
    );
  });

  it("prefers .cmd over extensionless npm shims", () => {
    expect(windowsExecutableRank("C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd")).toBeLessThan(
      windowsExecutableRank("C:\\Users\\x\\AppData\\Roaming\\npm\\claude")
    );
    expect(windowsLauncherCandidates("C:\\Users\\x\\AppData\\Roaming\\npm\\claude")).toEqual([
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.exe",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.bat",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.com",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude"
    ]);
  });

  it("requires cmd shim for .cmd and extensionless paths but not .exe", () => {
    const previous = process.platform;
    // windowsNeedsCmdShim only applies on win32
    if (process.platform === "win32") {
      expect(windowsNeedsCmdShim("C:\\npm\\claude.cmd")).toBe(true);
      expect(windowsNeedsCmdShim("C:\\npm\\claude")).toBe(true);
      expect(windowsNeedsCmdShim("C:\\npm\\claude.exe")).toBe(false);
    } else {
      expect(windowsNeedsCmdShim("C:\\npm\\claude.cmd")).toBe(false);
    }
    void previous;
  });
});
