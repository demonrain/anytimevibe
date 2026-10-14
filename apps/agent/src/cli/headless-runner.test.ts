import { describe, expect, it } from "vitest";
import { mergeAgyAssistantText } from "./headless-runner";

describe("Antigravity assistant output", () => {
  it("does not append the final cumulative response after incremental updates", () => {
    let text = "";
    const deltas: string[] = [];

    for (const incoming of ["The result", " is ready.", "The result is ready."]) {
      const merged = mergeAgyAssistantText(text, incoming);
      text = merged.text;
      if (merged.delta) deltas.push(merged.delta);
    }

    expect(text).toBe("The result is ready.");
    expect(deltas.join("")).toBe("The result is ready.");
  });

  it("emits only the suffix when agy sends cumulative snapshots", () => {
    let text = "";
    const deltas: string[] = [];

    for (const incoming of ["The", "The result", "The result is ready."]) {
      const merged = mergeAgyAssistantText(text, incoming);
      text = merged.text;
      if (merged.delta) deltas.push(merged.delta);
    }

    expect(text).toBe("The result is ready.");
    expect(deltas.join("")).toBe("The result is ready.");
  });
});
