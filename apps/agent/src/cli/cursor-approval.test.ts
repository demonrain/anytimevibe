import { describe, expect, it } from "vitest";
import { findApprovalPlan, findApprovalQuestions } from "./headless-runner";

/**
 * Cursor moves askQuestion / createPlan payloads between `args` and `result`
 * (each optionally wrapped in `success`) across started/completed and across CLI
 * versions. The regression these guard: `asRecord({})` is truthy, so a chain of
 * `asRecord(node.args) || asRecord(node.result)` stopped at an EMPTY `args` and
 * never read `result` — the web then rendered an approval card with a title and
 * nothing to click.
 *
 * The `questions[{id,prompt,options:[{id,label}]}]` shape below is verbatim from
 * a real Cursor `AskQuestion` call.
 */

const REAL_QUESTIONS = [
  {
    id: "finalize",
    prompt: "本次修改如何收尾？",
    options: [
      { id: "commit_bump", label: "提交推送 + 打新客户端版本 tag（推荐）" },
      { id: "commit_only", label: "只提交推送本次交互弹窗修复，不打版本 tag" },
      { id: "code_only", label: "只保留代码改动，先不提交" }
    ]
  }
] as const;

describe("findApprovalQuestions — container search", () => {
  it("reads questions out of args", () => {
    const found = findApprovalQuestions({ args: { questions: REAL_QUESTIONS } });
    expect(found).toHaveLength(1);
    expect(found[0]?.options).toHaveLength(3);
    expect(found[0]?.options[0]?.id).toBe("commit_bump");
  });

  it("reads questions out of result when args is an EMPTY object", () => {
    // The exact regression: `{}` is truthy, so the old code never looked here.
    const found = findApprovalQuestions({ args: {}, result: { questions: REAL_QUESTIONS } });
    expect(found).toHaveLength(1);
    expect(found[0]?.prompt).toBe("本次修改如何收尾？");
  });

  it("reads questions out of a success envelope inside result", () => {
    const found = findApprovalQuestions({ args: {}, result: { success: { questions: REAL_QUESTIONS } } });
    expect(found).toHaveLength(1);
    expect(found[0]?.options).toHaveLength(3);
  });

  it("reads questions off the node itself", () => {
    const found = findApprovalQuestions({ questions: REAL_QUESTIONS });
    expect(found).toHaveLength(1);
  });

  it("prefers an explicit array over treating a container as one question", () => {
    // Node carries a stray title/options pair; the real list is in result.
    const found = findApprovalQuestions({
      title: "stray",
      options: [{ id: "x", label: "x" }],
      prompt: "stray prompt",
      result: { questions: REAL_QUESTIONS }
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("finalize");
  });
});

describe("findApprovalQuestions — alternate shapes", () => {
  it("accepts a single inline question with no wrapper array", () => {
    const found = findApprovalQuestions({
      args: { question: "选哪个方案？", options: ["方案 A", "方案 B"] }
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.prompt).toBe("选哪个方案？");
    // Plain-string options become {id,label} so the web can render buttons.
    expect(found[0]?.options).toEqual([
      { id: "方案 A", label: "方案 A" },
      { id: "方案 B", label: "方案 B" }
    ]);
  });

  it("accepts `choices` as the option key", () => {
    const found = findApprovalQuestions({
      result: { questions: [{ id: "q1", prompt: "?", choices: [{ id: "a", label: "A" }] }] }
    });
    expect(found[0]?.options).toEqual([{ id: "a", label: "A" }]);
  });

  it("carries allowMultiple through", () => {
    const found = findApprovalQuestions({
      args: { questions: [{ id: "q1", prompt: "?", options: [{ id: "a", label: "A" }], allowMultiple: true }] }
    });
    expect(found[0]?.allowMultiple).toBe(true);
  });

  it("returns nothing when there are no options to choose from", () => {
    // Must stay empty so the caller shows the raw-payload fallback card.
    expect(findApprovalQuestions({ args: {}, result: {} })).toEqual([]);
    expect(findApprovalQuestions({ args: { questions: [{ id: "q1", prompt: "?", options: [] }] } })).toEqual([]);
    expect(findApprovalQuestions({ args: { title: "just a title" } })).toEqual([]);
  });
});

describe("findApprovalPlan — container search", () => {
  it("reads a plan out of result when args is empty", () => {
    const plan = findApprovalPlan({ args: {}, result: { plan: "1. 改代码\n2. 跑测试", name: "重构" } });
    expect(plan?.plan).toBe("1. 改代码\n2. 跑测试");
    expect(plan?.name).toBe("重构");
  });

  it("reads a plan out of a success envelope", () => {
    const plan = findApprovalPlan({ args: {}, result: { success: { plan: "步骤一" } } });
    expect(plan?.plan).toBe("步骤一");
  });

  it("keeps todos", () => {
    const plan = findApprovalPlan({
      args: { plan: "p", todos: [{ id: "t1", content: "做这个", status: "pending" }] }
    });
    expect(plan?.todos).toEqual([{ id: "t1", content: "做这个", status: "pending" }]);
  });

  it("returns null when no container holds plan text", () => {
    expect(findApprovalPlan({ args: {}, result: {} })).toBeNull();
  });
});
