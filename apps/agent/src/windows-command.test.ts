import { describe, expect, it } from "vitest";
import { normalizeWindowsCommandPath, windowsCmdArguments } from "./windows-command";

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
});
