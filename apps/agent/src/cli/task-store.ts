import { promises as fs } from "node:fs";
import path from "node:path";
import type { CliEngine } from "@anytimevibe/protocol";
import type { StoredTask } from "./types";

export type TaskStoreData = {
  defaultEngine: CliEngine;
  tasks: Record<string, StoredTask>;
};

export class TaskStore {
  private data: TaskStoreData = { defaultEngine: "codex", tasks: {} };
  private filePath = "";

  async load(userDataDir: string): Promise<void> {
    this.filePath = path.join(userDataDir, "multi-cli-tasks.json");
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as TaskStoreData;
      this.data = {
        defaultEngine: raw.defaultEngine === "claude" || raw.defaultEngine === "grok" || raw.defaultEngine === "codex"
          ? raw.defaultEngine
          : "codex",
        tasks: raw.tasks && typeof raw.tasks === "object" ? raw.tasks : {}
      };
    } catch {
      this.data = { defaultEngine: "codex", tasks: {} };
    }
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), "utf8");
  }

  getDefaultEngine(): CliEngine {
    return this.data.defaultEngine;
  }

  async setDefaultEngine(engine: CliEngine): Promise<void> {
    this.data.defaultEngine = engine;
    await this.save();
  }

  get(threadId: string): StoredTask | undefined {
    return this.data.tasks[threadId];
  }

  list(limit = 50): StoredTask[] {
    return Object.values(this.data.tasks)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async upsert(task: StoredTask): Promise<void> {
    this.data.tasks[task.threadId] = task;
    await this.save();
  }

  async appendMessage(threadId: string, message: StoredTask["messages"][number]): Promise<void> {
    const task = this.data.tasks[threadId];
    if (!task) return;
    task.messages.push(message);
    // Cap stored transcript for local index size.
    if (task.messages.length > 200) task.messages = task.messages.slice(-200);
    task.updatedAt = Date.now() / 1000;
    await this.save();
  }

  async setStatus(threadId: string, status: string): Promise<void> {
    const task = this.data.tasks[threadId];
    if (!task) return;
    task.status = status;
    task.updatedAt = Date.now() / 1000;
    await this.save();
  }

  async setProviderSession(threadId: string, providerSessionId: string): Promise<void> {
    const task = this.data.tasks[threadId];
    if (!task) return;
    task.providerSessionId = providerSessionId;
    await this.save();
  }
}
