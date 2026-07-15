import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveEngineBinary } from "./detect";
import type { TaskStore } from "./task-store";
import type { StoredTask } from "./types";

const execFileAsync = promisify(execFile);

function parseGrokSessionsTable(stdout: string): Array<{ id: string; summary: string; updatedAt: number }> {
  const rows: Array<{ id: string; summary: string; updatedAt: number }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    // SESSION ID looks like UUID (v4 or custom 019f...)
    const match = line.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/i);
    if (!match) continue;
    const id = match[1]!;
    const updated = match[3]!;
    const summary = (match[5] || "").trim() || id.slice(0, 8);
    const updatedAt = Date.parse(updated) ? Date.parse(updated) / 1000 : Date.now() / 1000;
    rows.push({ id, summary: summary === "(no summary)" ? `Grok ${id.slice(0, 8)}` : summary, updatedAt });
  }
  return rows;
}

async function readGrokSessionMeta(sessionId: string): Promise<{ cwd?: string; title?: string; messages?: StoredTask["messages"] }> {
  const root = process.env.GROK_HOME || path.join(os.homedir(), ".grok", "sessions");
  // Sessions are nested under path-encoded project dirs.
  async function walk(dir: string, depth: number): Promise<string | null> {
    if (depth > 4) return null;
    let entries: string[] = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (entry === sessionId) return full;
      try {
        const st = await fs.stat(full);
        if (st.isDirectory()) {
          const found = await walk(full, depth + 1);
          if (found) return found;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }
  const dir = await walk(root, 0);
  if (!dir) return {};
  let title: string | undefined;
  let cwd: string | undefined;
  const messages: StoredTask["messages"] = [];
  try {
    const summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) as {
      title?: string;
      summary?: string;
      cwd?: string;
    };
    title = summary.title || summary.summary;
    cwd = summary.cwd;
  } catch {
    // ignore
  }
  try {
    const history = await fs.readFile(path.join(dir, "chat_history.jsonl"), "utf8");
    for (const line of history.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { role?: string; text?: string; content?: string };
        const role = row.role === "user" || row.role === "assistant" || row.role === "system" ? row.role : null;
        const text = String(row.text ?? row.content ?? "").trim();
        if (role && text) messages.push({ id: crypto.randomUUID(), role, text: text.slice(0, 20_000) });
      } catch {
        // ignore bad lines
      }
    }
  } catch {
    // ignore
  }
  // Infer cwd from parent folder name (URL-encoded path)
  if (!cwd) {
    const parent = path.basename(path.dirname(dir));
    try {
      const decoded = decodeURIComponent(parent.replace(/%5C/gi, "\\").replace(/%3A/gi, ":"));
      if (/^[A-Za-z]:\\|^\//.test(decoded) || decoded.includes("\\") || decoded.includes("/")) cwd = decoded;
    } catch {
      // ignore
    }
  }
  return {
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    ...(messages.length ? { messages: messages.slice(-80) } : {})
  };
}

async function importGrokSessions(store: TaskStore, limit: number): Promise<number> {
  const binary = await resolveEngineBinary("grok");
  if (!binary) return 0;
  try {
    const { stdout } = await execFileAsync(binary, ["sessions", "list", "--limit", String(limit)], {
      timeout: 20_000,
      windowsHide: true,
      env: process.env,
      maxBuffer: 2_000_000
    });
    const rows = parseGrokSessionsTable(stdout).slice(0, limit);
    let added = 0;
    for (const row of rows) {
      const existing = store.get(row.id);
      const meta = await readGrokSessionMeta(row.id);
      const task: StoredTask = {
        threadId: row.id,
        engine: "grok",
        providerSessionId: row.id,
        cwd: meta.cwd || existing?.cwd || "",
        title: meta.title || existing?.title || row.summary,
        status: existing?.status === "active" ? "active" : "completed",
        createdAt: existing?.createdAt ?? row.updatedAt,
        updatedAt: Math.max(existing?.updatedAt ?? 0, row.updatedAt),
        messages: (meta.messages && meta.messages.length ? meta.messages : existing?.messages) || []
      };
      await store.upsert(task);
      added += 1;
    }
    return added;
  } catch {
    return 0;
  }
}

async function importClaudeSessions(store: TaskStore, limit: number): Promise<number> {
  // Claude Code stores project sessions under ~/.claude/projects/<encoded-path>/
  const root = path.join(os.homedir(), ".claude", "projects");
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(root)).map((name) => path.join(root, name));
  } catch {
    return 0;
  }
  type Hit = { id: string; file: string; mtime: number; cwd: string };
  const hits: Hit[] = [];
  for (const project of projectDirs) {
    let files: string[] = [];
    try {
      files = await fs.readdir(project);
    } catch {
      continue;
    }
    let cwd = "";
    try {
      const base = path.basename(project);
      cwd = decodeURIComponent(base.replace(/^-/, "").replace(/-/g, (m, offset, str) => {
        // Claude uses path with - separators; best-effort decode
        return m;
      }));
      // Common form: C--Users-... → C:\Users\...
      if (/^[A-Za-z]--/.test(base)) {
        cwd = base.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
      }
    } catch {
      cwd = "";
    }
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(/\.jsonl$/i, "");
      if (!/^[0-9a-f-]{16,}$/i.test(id)) continue;
      try {
        const st = await fs.stat(path.join(project, file));
        hits.push({ id, file: path.join(project, file), mtime: st.mtimeMs / 1000, cwd });
      } catch {
        // ignore
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  let added = 0;
  for (const hit of hits.slice(0, limit)) {
    const existing = store.get(hit.id);
    const messages: StoredTask["messages"] = [];
    try {
      const raw = await fs.readFile(hit.file, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string };
            role?: string;
          };
          const role = row.message?.role || row.role;
          if (role !== "user" && role !== "assistant") continue;
          let text = "";
          const content = row.message?.content;
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            text = content.filter((c) => c?.type === "text" && c.text).map((c) => c.text).join("\n");
          }
          if (text.trim()) messages.push({ id: crypto.randomUUID(), role, text: text.trim().slice(0, 20_000) });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    const titleFromUser = [...messages].reverse().find((m) => m.role === "user")?.text?.slice(0, 80);
    const task: StoredTask = {
      threadId: hit.id,
      engine: "claude",
      providerSessionId: hit.id,
      cwd: hit.cwd || existing?.cwd || "",
      title: existing?.title || titleFromUser || `Claude ${hit.id.slice(0, 8)}`,
      status: existing?.status === "active" ? "active" : "completed",
      createdAt: existing?.createdAt ?? hit.mtime,
      updatedAt: Math.max(existing?.updatedAt ?? 0, hit.mtime),
      messages: messages.length ? messages.slice(-80) : (existing?.messages || [])
    };
    await store.upsert(task);
    added += 1;
  }
  return added;
}

/** Import local Claude/Grok CLI sessions into the agent task index for web sync. */
export async function importLocalCliSessions(store: TaskStore, limit = 40): Promise<{ grok: number; claude: number }> {
  const [grok, claude] = await Promise.all([
    importGrokSessions(store, limit),
    importClaudeSessions(store, limit)
  ]);
  return { grok, claude };
}
