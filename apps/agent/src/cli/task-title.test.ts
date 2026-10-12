import { describe, expect, it } from "vitest";
import { summarizeTaskTitle } from "./task-title";

describe("summarizeTaskTitle", () => {
  it("uses the first meaningful paragraph and strips markdown", () => {
    expect(summarizeTaskTitle("# Fix login flow\n\nPlease add tests.")).toBe("Fix login flow");
    expect(summarizeTaskTitle("- `修复登录流程`\n更多背景")).toBe("修复登录流程");
  });

  it("keeps a complete first sentence when possible", () => {
    expect(summarizeTaskTitle("Add the API endpoint. Then update the UI.")).toBe("Add the API endpoint.");
  });

  it("is deterministic and bounded", () => {
    const title = summarizeTaskTitle("x".repeat(200), 20);
    expect(title).toHaveLength(20);
    expect(title.endsWith("…")).toBe(true);
    expect(summarizeTaskTitle("   ")).toBe("Untitled task");
  });

  it("uses the actual requirement after a generic introduction", () => {
    expect(summarizeTaskTitle("帮我完成以下需求：\n1、支持离线升级 CLI\n2、显示任务分支"))
      .toBe("支持离线升级 CLI");
    expect(summarizeTaskTitle("修复登录失败。再补充回归测试。"))
      .toBe("修复登录失败。");
  });
});
