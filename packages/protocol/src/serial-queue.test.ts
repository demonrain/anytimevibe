import { describe, expect, it } from "vitest";
import { SerialPromiseQueue } from "./serial-queue";

describe("SerialPromiseQueue", () => {
  it("runs asynchronous jobs in enqueue order", async () => {
    const queue = new SerialPromiseQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const firstResult = queue.run(async () => {
      order.push("first:start");
      await first;
      order.push("first:end");
      return "one";
    });
    const secondResult = queue.run(async () => {
      order.push("second");
      return "two";
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await expect(firstResult).resolves.toBe("one");
    await expect(secondResult).resolves.toBe("two");
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues with later jobs after a failed job", async () => {
    const queue = new SerialPromiseQueue();
    const order: string[] = [];

    const failed = queue.run(async () => {
      order.push("failed");
      throw new Error("expected");
    });
    const recovered = queue.run(async () => {
      order.push("recovered");
      return true;
    });

    await expect(failed).rejects.toThrow("expected");
    await expect(recovered).resolves.toBe(true);
    expect(order).toEqual(["failed", "recovered"]);
  });
});
