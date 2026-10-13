type NativeThread = Record<string, any>;

function threadId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Native subagent metadata only: an unnamed session or a user fork is not a child. */
export function codexSubagentInfo(thread: NativeThread): { parentThreadId?: string } | undefined {
  const source = thread.source;
  const subagent = source && typeof source === "object" ? source.subAgent ?? source.subagent : undefined;
  const spawn = subagent && typeof subagent === "object" ? subagent.thread_spawn ?? subagent.threadSpawn : undefined;
  const parent = threadId(thread.parentThreadId) || threadId(thread.parent_thread_id)
    || threadId(spawn?.parent_thread_id) || threadId(spawn?.parentThreadId);
  const marker = source && typeof source === "object"
    ? (source.subAgent ?? source.subagent)
    : undefined;
  // Some Codex versions include `subAgent: null/false` on ordinary root
  // threads. Property presence alone is not proof that a session is a child.
  const marked = Boolean(marker) || (typeof marker === "object" && marker !== null);
  if (!parent && !marked) return undefined;
  return parent && parent !== threadId(thread.id) ? { parentThreadId: parent } : {};
}

/** Keep product task identity separate from Codex's internal collaboration threads. */
export class CodexThreadRegistry {
  private readonly threads = new Map<string, { subagent: boolean; parentThreadId?: string }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly readThreadIds = new Set<string>();

  observeThread(thread: NativeThread | undefined): boolean {
    const id = threadId(thread?.id);
    if (!id || !thread) return false;
    const info = codexSubagentInfo(thread);
    // Partial/read notifications must never undo an already-proven child relation.
    if (info) this.observeChild(id, info.parentThreadId);
    else if (!this.threads.has(id)) this.threads.set(id, { subagent: false });
    return this.isSubagent(id);
  }

  private observeChild(id: string, parent?: string): void {
    if (!id) return;
    const parentThreadId = parent && parent !== id ? parent : this.threads.get(id)?.parentThreadId;
    this.threads.set(id, {
      subagent: true,
      ...(parentThreadId ? { parentThreadId } : {})
    });
  }

  observeItem(item: NativeThread, senderThreadId: string): string[] {
    const ids: string[] = [];
    if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
      const parent = threadId(item.senderThreadId) || senderThreadId;
      for (const receiver of item.receiverThreadIds ?? []) {
        const id = threadId(receiver);
        if (!id || id === parent) continue;
        this.observeChild(id, parent);
        ids.push(id);
      }
    }
    if (item.type === "subAgentActivity") {
      const id = threadId(item.agentThreadId);
      if (id && id !== senderThreadId) {
        this.observeChild(id, senderThreadId);
        ids.push(id);
      }
    }
    return ids;
  }

  isSubagent(id: string): boolean {
    return this.threads.get(id)?.subagent === true;
  }

  subagentIds(): string[] {
    return [...this.threads].filter(([, info]) => info.subagent).map(([id]) => id);
  }

  async ensureRootThreadId(id: string, read: (id: string) => Promise<NativeThread | undefined>): Promise<string | undefined> {
    const seen = new Set<string>();
    let current = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      await this.ensureThread(current, read);
      if (!this.threads.has(current)) return undefined;
      if (!this.isSubagent(current)) return current;
      current = this.threads.get(current)?.parentThreadId || "";
    }
    return undefined;
  }

  async ensureThread(id: string, read: (id: string) => Promise<NativeThread | undefined>): Promise<void> {
    if (!id) return;
    const info = this.threads.get(id);
    if (info && (!info.subagent || info.parentThreadId || this.readThreadIds.has(id))) return;
    let pending = this.pending.get(id);
    if (!pending) {
      pending = (async () => {
        const thread = await read(id);
        if (thread) {
          this.observeThread(thread);
          this.readThreadIds.add(id);
        }
      })();
      this.pending.set(id, pending);
    }
    try { await pending; }
    finally { if (this.pending.get(id) === pending) this.pending.delete(id); }
  }
}
