import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resolveEngineBinary } from "./detect";
import { canProbePathWithoutPrompt, isMacTccProtectedPath } from "./macos-fs";
import type { TaskStore } from "./task-store";
import type { StoredTask } from "./types";

const execFileAsync = promisify(execFile);

type HistoryMessage = StoredTask["messages"][number];

/** Keep failure/interrupt from AnytimeVibe turns; only default brand-new CLI imports to completed. */
function mergeImportStatus(existing: StoredTask | undefined): string {
  if (!existing?.status) return "completed";
  const status = existing.status.toLowerCase();
  if (status === "active" || status === "running" || status === "processing") return "active";
  if (["failed", "error", "interrupted", "cancelled", "canceled", "stopped"].includes(status)) {
    return existing.status;
  }
  return existing.status || "completed";
}

/**
 * Resolve the store record for a native CLI session.
 * Web-created Claude/Grok tasks use a UUID threadId and store the CLI id in providerSessionId —
 * never create a second task keyed only by the native session id.
 */
function resolveExistingForProviderSession(
  store: TaskStore,
  providerSessionId: string,
  engine: "claude" | "grok" | "cursor"
): StoredTask | undefined {
  return store.findByProviderSession(providerSessionId, engine) || store.get(providerSessionId);
}

function msToUnixSeconds(ms: number | undefined | null): number {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Date.now() / 1000;
  // Cursor meta uses epoch ms; guard against accidental seconds.
  return n > 1e12 ? n / 1000 : n;
}

/** Temp / scratch dirs used by headless smoke tests — not useful on the web task list. */
export function isEphemeralImportCwd(cwd: string | undefined | null): boolean {
  const raw = String(cwd || "").trim();
  if (!raw) return false;
  const normalized = raw.replace(/\//g, "\\").toLowerCase();
  if (/\\appdata\\local\\temp(\\|$)/i.test(normalized)) return true;
  if (/\\(?:local\\)?temp(?:\\|$)|\btmp(\\|$)/i.test(normalized) && /\\users\\|\\appdata\\/i.test(normalized)) {
    return true;
  }
  // Bare Windows %TEMP% / system temp
  if (/^[a-z]:\\temp(\\|$)/i.test(normalized)) return true;
  if (/^[a-z]:\\windows\\temp(\\|$)/i.test(normalized)) return true;
  const posix = raw.replace(/\\/g, "/").toLowerCase();
  if (posix === "/tmp" || posix.startsWith("/tmp/")) return true;
  if (posix.startsWith("/var/folders/")) return true; // macOS mktemp
  if (/\/t\/tmp\//i.test(posix)) return true;
  return false;
}

function hasUsefulTranscript(messages: HistoryMessage[]): boolean {
  return messages.some((message) => {
    if (message.role !== "user" && message.role !== "assistant") return false;
    return Boolean(message.text?.trim());
  });
}

/** Cursor sessions with no real chat, or only Temp/scratch cwd — skip sync/list noise. */
export function isJunkCursorImportTask(task: {
  cwd?: string;
  title?: string;
  messages?: HistoryMessage[];
  providerSessionId?: string;
  threadId?: string;
}): boolean {
  if (isEphemeralImportCwd(task.cwd)) return true;
  const messages = task.messages || [];
  if (hasUsefulTranscript(messages)) return false;
  const title = String(task.title || "").trim();
  // Named agent / real title without Temp cwd is still worth listing after handoff.
  if (title && !/^cursor\s+[0-9a-f]{8}$/i.test(title) && title !== "New Agent") return false;
  // Fallback title "Cursor ab12cd34" with no real user ask
  if (/^cursor\s+[0-9a-f]{8}$/i.test(title)) return true;
  return true;
}

function titleFromCursorPromptHistory(history: string[]): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const text = String(history[i] || "").trim();
    if (!text) continue;
    if (text.startsWith("/")) continue;
    if (text.length <= 2 && /^[A-Za-z0-9]+$/.test(text)) continue;
    return text.slice(0, 80);
  }
  return undefined;
}

function messagesFromCursorPromptHistory(history: string[]): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  for (const item of history) {
    const text = String(item || "").trim();
    if (!text || text.startsWith("/")) continue;
    if (text.length <= 2 && /^[A-Za-z0-9]+$/.test(text)) continue;
    out.push({ id: crypto.randomUUID(), role: "user", text: text.slice(0, 20_000) });
  }
  return out;
}

async function readCursorPromptHistory(sessionDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(sessionDir, "prompt_history.json"), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Cursor Agent stores chats under ~/.cursor/chats/<workspaceHash>/<sessionId>/.
 * Each session has meta.json (cwd / timestamps), optional prompt_history.json, and store.db.
 *
 * Real handoff sessions often grow store.db to tens/hundreds of MB. Scanning every blob
 * times out and yields zero messages → junk filter drops them. Scan newest JSON blobs only.
 */
async function readCursorSessionMessages(dbPath: string): Promise<{
  messages: HistoryMessage[];
  agentName?: string;
}> {
  const py = process.platform === "win32" ? "python" : "python3";
  // Scan newest blobs first and cap rows — 133MB DBs finish in <100ms this way.
  const script = [
    "import sqlite3,json,sys,binascii,os",
    `db=${JSON.stringify(dbPath)}`,
    "con=sqlite3.connect(db)",
    "cur=con.cursor()",
    "agent_name=''",
    "try:",
    "  mv=cur.execute(\"select value from meta where key='0'\").fetchone()",
    "  if mv:",
    "    s=mv[0].decode('utf-8') if isinstance(mv[0],(bytes,bytearray)) else str(mv[0])",
    "    if all(c in '0123456789abcdefABCDEF' for c in s.strip()):",
    "      meta=json.loads(binascii.unhexlify(s.strip()).decode('utf-8'))",
    "    else:",
    "      meta=json.loads(s)",
    "    agent_name=str(meta.get('name') or '')",
    "except Exception:",
    "  pass",
    "size=0",
    "try:",
    "  size=os.path.getsize(db)",
    "except Exception:",
    "  pass",
    // Large DBs: only the recent window; small DBs can afford a fuller scan.
    "limit=2500 if size>8_000_000 else 8000",
    "rows=cur.execute('select rowid,data from blobs order by rowid desc limit %d'%limit).fetchall()",
    "msgs=[]",
    "for rowid,data in rows:",
    "  raw=bytes(data) if not isinstance(data,str) else data.encode('utf-8','replace')",
    "  if not raw or raw[0] not in (0x7b,0x5b):",
    "    continue",
    "  try:",
    "    obj=json.loads(raw.decode('utf-8'))",
    "  except Exception:",
    "    continue",
    "  if not isinstance(obj,dict):",
    "    continue",
    "  role=obj.get('role')",
    "  if role not in ('user','assistant'):",
    "    continue",
    "  content=obj.get('content')",
    "  parts=[]",
    "  if isinstance(content,str):",
    "    parts.append(content)",
    "  elif isinstance(content,list):",
    "    for block in content:",
    "      if isinstance(block,dict) and block.get('type')=='text' and block.get('text'):",
    "        parts.append(str(block['text']))",
    "  text='\\n'.join(parts).strip()",
    "  if not text:",
    "    continue",
    "  msgs.append({'role':role,'text':text[:20000],'rowid':rowid})",
    // Newest-first → chronological
    "msgs.reverse()",
    "print(json.dumps({'agentName':agent_name,'messages':msgs},ensure_ascii=False))"
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(py, ["-c", script], {
      timeout: 45_000,
      windowsHide: true,
      maxBuffer: 16_000_000
    });
    const parsed = JSON.parse(String(stdout || "{}")) as {
      agentName?: string;
      messages?: Array<{ role?: string; text?: string }>;
    };
    const messages: HistoryMessage[] = [];
    for (const row of parsed.messages || []) {
      const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
      if (!role) continue;
      const cleaned = cleanImportedMessageText(role, String(row.text || ""));
      if (!cleaned) continue;
      messages.push({ id: crypto.randomUUID(), role, text: cleaned });
    }
    return {
      messages,
      ...(parsed.agentName?.trim() ? { agentName: parsed.agentName.trim() } : {})
    };
  } catch {
    return { messages: [] };
  }
}

async function importCursorSessions(store: TaskStore, limit: number): Promise<number> {
  const root = path.join(os.homedir(), ".cursor", "chats");
  let workspaceDirs: string[] = [];
  try {
    workspaceDirs = (await fs.readdir(root)).map((name) => path.join(root, name));
  } catch {
    return 0;
  }

  type Hit = {
    id: string;
    dir: string;
    mtime: number;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    hasConversation: boolean;
    isSubagent: boolean;
  };
  const hits: Hit[] = [];

  for (const workspaceDir of workspaceDirs) {
    let sessionDirs: string[] = [];
    try {
      const st = await fs.stat(workspaceDir);
      if (!st.isDirectory()) continue;
      sessionDirs = await fs.readdir(workspaceDir);
    } catch {
      continue;
    }
    for (const sessionId of sessionDirs) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) continue;
      const dir = path.join(workspaceDir, sessionId);
      let metaRaw = "";
      try {
        metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf8");
      } catch {
        // Older sessions may only have store.db
      }
      let cwd = "";
      let createdAt = 0;
      let updatedAt = 0;
      let hasConversation = false;
      let isSubagent = false;
      try {
        const meta = JSON.parse(metaRaw || "{}") as {
          cwd?: string;
          createdAtMs?: number;
          updatedAtMs?: number;
          hasConversation?: boolean;
          isSubagent?: boolean;
        };
        cwd = typeof meta.cwd === "string" ? meta.cwd : "";
        createdAt = msToUnixSeconds(meta.createdAtMs);
        updatedAt = msToUnixSeconds(meta.updatedAtMs);
        hasConversation = Boolean(meta.hasConversation);
        isSubagent = Boolean(meta.isSubagent);
      } catch {
        // ignore
      }
      let mtime = updatedAt || createdAt;
      if (!mtime) {
        try {
          mtime = (await fs.stat(path.join(dir, "store.db"))).mtimeMs / 1000;
        } catch {
          try {
            mtime = (await fs.stat(dir)).mtimeMs / 1000;
          } catch {
            mtime = Date.now() / 1000;
          }
        }
      } else {
        // Prefer fresher store.db mtime after local handoff continues the chat.
        try {
          const dbMtime = (await fs.stat(path.join(dir, "store.db"))).mtimeMs / 1000;
          if (dbMtime > mtime) mtime = dbMtime;
        } catch {
          // ignore
        }
      }
      hits.push({
        id: sessionId,
        dir,
        mtime,
        cwd,
        createdAt: createdAt || mtime,
        updatedAt: Math.max(updatedAt || 0, mtime),
        hasConversation,
        isSubagent
      });
    }
  }

  hits.sort((a, b) => b.mtime - a.mtime);
  let added = 0;
  // Over-scan candidates: junk / subagent skips should not starve the recent window.
  for (const hit of hits.slice(0, Math.max(limit * 5, limit))) {
    if (isEphemeralImportCwd(hit.cwd)) continue;
    const existing = resolveExistingForProviderSession(store, hit.id, "cursor");
    const promptHistory = await readCursorPromptHistory(hit.dir);
    const dbPath = path.join(hit.dir, "store.db");
    let imported: Awaited<ReturnType<typeof readCursorSessionMessages>> = { messages: [] };
    try {
      await fs.access(dbPath);
      imported = await readCursorSessionMessages(dbPath);
    } catch {
      // meta/prompt-history only
    }
    const historyMessages = messagesFromCursorPromptHistory(promptHistory);
    let messages = imported.messages.length >= (existing?.messages?.length ?? 0)
      ? imported.messages
      : (existing?.messages || imported.messages);
    // If sqlite yielded nothing useful (timeout / protobuf-heavy), fall back to prompt history.
    if (!hasUsefulTranscript(messages) && historyMessages.length) {
      messages = historyMessages;
    } else if (messages.length < historyMessages.length && historyMessages.length > 0) {
      // Keep richer DB transcript when present; otherwise history is better than empty.
      if (!hasUsefulTranscript(messages)) messages = historyMessages;
    }
    const titleFromUser = messages.find((m) => m.role === "user")?.text?.slice(0, 80);
    const titleFromHistory = titleFromCursorPromptHistory(promptHistory);
    const agentTitle = imported.agentName && imported.agentName !== "New Agent"
      ? imported.agentName
      : undefined;
    const title = existing?.title || agentTitle || titleFromUser || titleFromHistory || `Cursor ${hit.id.slice(0, 8)}`;
    const cwd = (hit.cwd || existing?.cwd)
      ? path.resolve(hit.cwd || existing?.cwd || "")
      : (existing?.cwd || "");
    // Skip empty Cursor subagents with no cwd / transcript (parent chat is the useful one).
    if (hit.isSubagent && !cwd && !hasUsefulTranscript(messages) && !titleFromHistory) {
      continue;
    }
    if (isJunkCursorImportTask({ cwd, title, messages })) {
      // Still keep sessions Cursor itself marks as having a conversation when we at least
      // have a prompt history title — otherwise handoff chats never reach the web list.
      if (!(hit.hasConversation && (titleFromHistory || agentTitle))) {
        continue;
      }
    }
    if (added >= limit) break;
    const threadId = existing?.threadId || hit.id;
    const task: StoredTask = {
      threadId,
      engine: "cursor",
      providerSessionId: hit.id,
      cwd,
      title,
      status: mergeImportStatus(existing),
      createdAt: existing?.createdAt ?? hit.createdAt,
      updatedAt: Math.max(existing?.updatedAt ?? 0, hit.updatedAt, hit.mtime),
      messages: messages.slice(-80),
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(existing?.contextUsage ? { contextUsage: existing.contextUsage } : {})
    };
    await store.upsert(task);
    await removeOrphanNativeDuplicate(store, hit.id, threadId);
    added += 1;
  }
  return added;
}

/** Cursor Temp/empty imports already in the local index — caller should tombstone + delete. */
export function listJunkCursorImportThreadIds(store: TaskStore): string[] {
  return store.list(1000)
    .filter((task) => task.engine === "cursor" && isJunkCursorImportTask(task))
    .map((task) => task.threadId);
}

async function removeOrphanNativeDuplicate(
  store: TaskStore,
  providerSessionId: string,
  keepThreadId: string
): Promise<void> {
  if (providerSessionId === keepThreadId) return;
  const orphan = store.get(providerSessionId);
  if (!orphan) return;
  // Only drop pure native-keyed clones of the same session.
  if (orphan.threadId === providerSessionId && (orphan.providerSessionId === providerSessionId || !orphan.providerSessionId)) {
    await store.remove(providerSessionId);
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as { type?: string; text?: string; content?: string };
    if (typeof row.text === "string" && row.text) parts.push(row.text);
    else if (typeof row.content === "string" && row.content) parts.push(row.content);
  }
  return parts.join("\n");
}

function extractUserQuery(text: string): string {
  const match = text.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (match?.[1]?.trim()) return match[1].trim();
  return text.trim();
}

/** Drop CLI meta / system scaffolding so web transcripts stay human-readable. */
function isNoiseTranscriptText(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // Claude local slash-command wrappers and stdout
  if (
    /<local-command-caveat>|<command-name>|<command-message>|<command-args>|<local-command-stdout>|<local-command-stdin>|<local-command-stderr>/i.test(
      t
    )
  ) {
    return true;
  }
  // Pure environment / git / system blocks with no user ask
  if (/^<user_info>[\s\S]*<\/user_info>\s*$/i.test(t)) return true;
  if (/^<git_status>[\s\S]*<\/git_status>\s*$/i.test(t)) return true;
  if (/^<system-reminder>[\s\S]*<\/system-reminder>\s*$/i.test(t)) return true;
  if (/^<agent_skills>[\s\S]*<\/agent_skills>\s*$/i.test(t)) return true;
  if (/DO NOT respond to these messages/i.test(t) && t.length < 800) return true;
  // Grok/Claude session bootstrap dumps
  if (/^You are Grok\b/i.test(t) && t.length > 400) return true;
  if (/^You are Claude\b/i.test(t) && t.length > 400) return true;
  return false;
}

function cleanImportedMessageText(role: "user" | "assistant" | "system", raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  if (role === "user") {
    text = extractUserQuery(text);
    // Strip leftover injected context blocks when user_query was absent
    text = text
      .replace(/<user_info>[\s\S]*?<\/user_info>/gi, "")
      .replace(/<git_status>[\s\S]*?<\/git_status>/gi, "")
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
      .replace(/<agent_skills>[\s\S]*?<\/agent_skills>/gi, "")
      .replace(/<executing_actions_with_care>[\s\S]*?<\/executing_actions_with_care>/gi, "")
      .trim();
  }
  if (!text || isNoiseTranscriptText(text)) return null;
  return text.slice(0, 20_000);
}

function parseGrokSessionsTable(stdout: string): Array<{ id: string; summary: string; updatedAt: number }> {
  const rows: Array<{ id: string; summary: string; updatedAt: number }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    // SESSION ID may be UUID v4 or ULID-style 019f...
    const match = line.match(
      /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/i
    );
    if (!match) continue;
    const id = match[1]!;
    const updated = match[3]!;
    const summary = (match[5] || "").trim() || id.slice(0, 8);
    const updatedAt = Date.parse(updated) ? Date.parse(updated) / 1000 : Date.now() / 1000;
    rows.push({
      id,
      summary: summary === "(no summary)" ? `Grok ${id.slice(0, 8)}` : summary,
      updatedAt
    });
  }
  return rows;
}

async function walkSessionDirs(root: string, depth: number, hits: Array<{ id: string; dir: string; mtime: number }>): Promise<void> {
  if (depth > 5) return;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "session_search.sqlite" || entry.endsWith(".lock") || entry.endsWith(".jsonl") && !entry.includes("-")) {
      // skip top-level non-session files later via stat
    }
    const full = path.join(root, entry);
    let st;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    // Session dirs look like UUIDs
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) {
      hits.push({ id: entry, dir: full, mtime: st.mtimeMs / 1000 });
      continue;
    }
    await walkSessionDirs(full, depth + 1, hits);
  }
}

function decodeGrokProjectDir(name: string): string {
  try {
    const decoded = decodeURIComponent(name);
    if (/^[A-Za-z]:\\|^\//.test(decoded) || decoded.includes("\\") || decoded.includes("/")) return decoded;
  } catch {
    // ignore
  }
  return "";
}

async function readGrokSessionDir(dir: string, sessionId: string): Promise<{
  cwd?: string;
  title?: string;
  messages: HistoryMessage[];
  updatedAt?: number;
}> {
  let title: string | undefined;
  let cwd: string | undefined;
  let updatedAt: number | undefined;
  const messages: HistoryMessage[] = [];

  try {
    const summary = JSON.parse(await fs.readFile(path.join(dir, "summary.json"), "utf8")) as {
      title?: string;
      summary?: string;
      session_summary?: string;
      generated_title?: string;
      cwd?: string;
      updated_at?: string;
      last_active_at?: string;
      info?: { id?: string; cwd?: string };
    };
    title = summary.generated_title || summary.session_summary || summary.title || summary.summary;
    cwd = summary.cwd || summary.info?.cwd;
    const ts = summary.last_active_at || summary.updated_at;
    if (ts && Date.parse(ts)) updatedAt = Date.parse(ts) / 1000;
  } catch {
    // ignore
  }

  try {
    const history = await fs.readFile(path.join(dir, "chat_history.jsonl"), "utf8");
    for (const line of history.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as {
          type?: string;
          role?: string;
          text?: string;
          content?: unknown;
          synthetic_reason?: string;
        };
        // Grok uses { type: "user"|"assistant", content: string | blocks }
        // Older formats may use role/text.
        const roleRaw = row.type || row.role;
        if (roleRaw !== "user" && roleRaw !== "assistant") continue;
        // Skip compaction meta noise
        if (row.synthetic_reason === "compaction_meta" || row.synthetic_reason === "system_reminder") continue;
        let text = textFromContent(row.content);
        if (!text && typeof row.text === "string") text = row.text;
        const cleaned = cleanImportedMessageText(roleRaw, text);
        if (!cleaned) continue;
        messages.push({ id: crypto.randomUUID(), role: roleRaw, text: cleaned });
      } catch {
        // ignore bad lines
      }
    }
  } catch {
    // ignore
  }

  if (!cwd) {
    const parent = path.basename(path.dirname(dir));
    cwd = decodeGrokProjectDir(parent) || undefined;
  }

  if (!title) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    title = lastUser?.text.slice(0, 80) || `Grok ${sessionId.slice(0, 8)}`;
  }

  return {
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    messages: messages.slice(-80),
    ...(updatedAt ? { updatedAt } : {})
  };
}

async function importGrokSessions(store: TaskStore, limit: number): Promise<number> {
  const root = process.env.GROK_HOME || path.join(os.homedir(), ".grok", "sessions");
  const hits: Array<{ id: string; dir: string; mtime: number }> = [];
  await walkSessionDirs(root, 0, hits);
  hits.sort((a, b) => b.mtime - a.mtime);

  // Merge IDs from `grok sessions list` (may include remote/cloud labels).
  try {
    const binary = await resolveEngineBinary("grok");
    if (binary) {
      const { stdout } = await execFileAsync(binary, ["sessions", "list", "--limit", String(limit)], {
        timeout: 20_000,
        windowsHide: true,
        env: process.env,
        maxBuffer: 2_000_000
      });
      for (const row of parseGrokSessionsTable(stdout)) {
        if (!hits.some((h) => h.id === row.id)) {
          hits.push({ id: row.id, dir: "", mtime: row.updatedAt });
        }
      }
      hits.sort((a, b) => b.mtime - a.mtime);
    }
  } catch {
    // filesystem-only is fine
  }

  let added = 0;
  for (const hit of hits.slice(0, limit)) {
    const existing = resolveExistingForProviderSession(store, hit.id, "grok");
    let meta: Awaited<ReturnType<typeof readGrokSessionDir>> = { messages: [] };
    if (hit.dir) {
      meta = await readGrokSessionDir(hit.dir, hit.id);
    } else {
      // Locate dir by id if list-only entry
      const found: Array<{ id: string; dir: string; mtime: number }> = [];
      await walkSessionDirs(root, 0, found);
      const match = found.find((item) => item.id === hit.id);
      if (match) meta = await readGrokSessionDir(match.dir, hit.id);
    }

    const importedMessages = meta.messages.length ? meta.messages : [];
    const messages = importedMessages.length >= (existing?.messages?.length ?? 0)
      ? importedMessages
      : (existing?.messages || importedMessages);
    // Keep AnytimeVibe threadId (UUID) when this native session was already bound to a web task.
    const threadId = existing?.threadId || hit.id;
    const task: StoredTask = {
      threadId,
      engine: "grok",
      providerSessionId: hit.id,
      cwd: (meta.cwd || existing?.cwd)
        ? path.resolve(meta.cwd || existing?.cwd || "")
        : (existing?.cwd || ""),
      title: existing?.title || meta.title || `Grok ${hit.id.slice(0, 8)}`,
      status: mergeImportStatus(existing),
      createdAt: existing?.createdAt ?? hit.mtime,
      updatedAt: Math.max(existing?.updatedAt ?? 0, meta.updatedAt ?? 0, hit.mtime),
      messages: messages.slice(-80),
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(existing?.contextUsage ? { contextUsage: existing.contextUsage } : {})
    };
    await store.upsert(task);
    await removeOrphanNativeDuplicate(store, hit.id, threadId);
    added += 1;
  }
  return added;
}

/**
 * Claude Code stores projects as ~/.claude/projects/<encoded-path>/ where path
 * separators become `-` and `C:\` becomes `C--`. That encoding is LOSSY when a
 * real directory name already contains hyphens (py-cdp-bridge → py\cdp\bridge).
 * Never use naive global replace alone — resolve against the filesystem / .claude.json.
 */
function naiveDecodeClaudeProjectDir(name: string): string {
  if (/^[A-Za-z]--/.test(name)) {
    return name.replace(/^([A-Za-z])--/, "$1:\\").replace(/-/g, "\\");
  }
  if (name.startsWith("-")) {
    return name.replace(/-/g, "/");
  }
  return "";
}

/** Same rules Claude uses to name the projects/ folder (for reverse lookup). */
function encodeClaudeProjectPath(absPath: string): string {
  const resolved = path.resolve(absPath);
  if (/^[A-Za-z]:[\\/]/.test(resolved)) {
    return resolved
      .replace(/^([A-Za-z]):[\\/]?/, "$1--")
      .replace(/[\\/]+/g, "-");
  }
  // POSIX absolute: /Users/foo → -Users-foo
  if (resolved.startsWith("/")) {
    return resolved.replace(/\//g, "-");
  }
  return resolved.replace(/[\\/]+/g, "-");
}

async function pathIsDirectory(target: string, allowedRoots: string[] = []): Promise<boolean> {
  if (!canProbePathWithoutPrompt(target, allowedRoots)) return false;
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk the real filesystem to reverse Claude's lossy encoding.
 * Prefer longer directory names so `py-cdp-bridge` wins over `py` + `cdp` + `bridge`.
 */
async function matchClaudeEncodedRemainder(
  current: string,
  remainder: string,
  allowedRoots: string[] = []
): Promise<string | null> {
  // macOS: never reverse-walk the real filesystem — it touches Documents/Desktop and
  // triggers repeated TCC “wants to access …” dialogs.
  if (process.platform === "darwin") return null;
  if (!remainder) {
    return (await pathIsDirectory(current, allowedRoots)) ? path.resolve(current) : null;
  }
  if (!(await pathIsDirectory(current, allowedRoots))) return null;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(current);
  } catch {
    return null;
  }
  entries.sort((left, right) => right.length - left.length);
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === remainder) {
      const full = path.join(current, name);
      if (await pathIsDirectory(full, allowedRoots)) return path.resolve(full);
      continue;
    }
    if (remainder.startsWith(`${name}-`)) {
      const nested = await matchClaudeEncodedRemainder(
        path.join(current, name),
        remainder.slice(name.length + 1),
        allowedRoots
      );
      if (nested) return nested;
    }
  }
  return null;
}

/** Load absolute project paths known to Claude (~/.claude.json → projects). */
async function loadClaudeJsonProjectPaths(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const candidates = [
    path.join(os.homedir(), ".claude.json"),
    path.join(os.homedir(), ".claude", ".claude.json")
  ];
  for (const file of candidates) {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8")) as {
        projects?: Record<string, unknown>;
      };
      const projects = raw.projects;
      if (!projects || typeof projects !== "object") continue;
      for (const key of Object.keys(projects)) {
        const abs = path.resolve(key);
        out.set(encodeClaudeProjectPath(abs), abs);
        // Also index basename-encoded form in case keys use mixed separators.
        out.set(encodeClaudeProjectPath(key), abs);
      }
    } catch {
      // optional
    }
  }
  return out;
}

async function resolveClaudeProjectCwd(
  encodedName: string,
  claudeJsonPaths: Map<string, string>,
  allowedRoots: string[] = []
): Promise<string> {
  const fromJson = claudeJsonPaths.get(encodedName);
  if (fromJson) {
    // Prefer Claude's own path table without probing TCC-protected folders.
    if (await pathIsDirectory(fromJson, allowedRoots)) return path.resolve(fromJson);
    if (process.platform === "darwin" && isMacTccProtectedPath(fromJson)) {
      return path.resolve(fromJson);
    }
    if (process.platform !== "darwin") return path.resolve(fromJson);
  }

  // Filesystem-aware reverse of the lossy encoding (handles hyphens in folder names).
  // Skipped on macOS inside matchClaudeEncodedRemainder.
  if (/^[A-Za-z]--/.test(encodedName)) {
    const match = encodedName.match(/^([A-Za-z])--(.*)$/);
    if (match) {
      const root = `${match[1]!.toUpperCase()}:\\`;
      const found = await matchClaudeEncodedRemainder(root, match[2] || "", allowedRoots);
      if (found) return found;
    }
  } else if (encodedName.startsWith("-")) {
    const found = await matchClaudeEncodedRemainder(path.sep, encodedName.slice(1), allowedRoots);
    if (found) return found;
  }

  // Last resort: lossy decode (may be wrong when names contain `-`).
  const naive = naiveDecodeClaudeProjectDir(encodedName);
  if (!naive) return "";
  if (await pathIsDirectory(naive, allowedRoots)) return path.resolve(naive);
  // Keep the decoded path string for display/resume even when we must not probe it.
  if (process.platform === "darwin") return path.resolve(naive);
  return naive;
}

/** Prefer a path that still exists on disk; never let a broken import wipe a good existing cwd. */
async function pickBestTaskCwd(
  allowedRoots: string[],
  ...candidates: Array<string | undefined | null>
): Promise<string> {
  const resolved = candidates
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => {
      try {
        return path.resolve(item);
      } catch {
        return item;
      }
    });
  for (const candidate of resolved) {
    if (await pathIsDirectory(candidate, allowedRoots)) return candidate;
  }
  // On macOS do not fs.stat TCC paths — return first candidate as metadata only.
  return resolved[0] || "";
}

/** Claude jsonl often embeds the real cwd; prefer it over lossy folder-name decode. */
function extractCwdFromClaudeJsonl(raw: string): string {
  // Scan a limited prefix — cwd appears early in most transcripts.
  const head = raw.slice(0, 256_000);
  for (const line of head.split(/\r?\n/)) {
    if (!line.includes("cwd")) continue;
    try {
      const row = JSON.parse(line) as {
        cwd?: string;
        cwd_path?: string;
        workdir?: string;
        message?: { cwd?: string };
      };
      const value = String(row.cwd || row.cwd_path || row.workdir || row.message?.cwd || "").trim();
      if (value && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/"))) {
        return value;
      }
    } catch {
      // ignore
    }
  }
  return "";
}

async function importClaudeSessions(
  store: TaskStore,
  limit: number,
  allowedRoots: string[] = []
): Promise<number> {
  // Claude Code stores project sessions under ~/.claude/projects/<encoded-path>/
  const root = path.join(os.homedir(), ".claude", "projects");
  let projectDirs: string[] = [];
  try {
    projectDirs = (await fs.readdir(root)).map((name) => path.join(root, name));
  } catch {
    return 0;
  }
  const claudeJsonPaths = await loadClaudeJsonProjectPaths();
  type Hit = { id: string; file: string; mtime: number; encodedProject: string; cwd: string };
  const hits: Hit[] = [];
  for (const project of projectDirs) {
    let files: string[] = [];
    try {
      files = await fs.readdir(project);
    } catch {
      continue;
    }
    const base = path.basename(project);
    const cwd = await resolveClaudeProjectCwd(base, claudeJsonPaths, allowedRoots);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.replace(/\.jsonl$/i, "");
      if (!/^[0-9a-f-]{16,}$/i.test(id)) continue;
      try {
        const st = await fs.stat(path.join(project, file));
        hits.push({
          id,
          file: path.join(project, file),
          mtime: st.mtimeMs / 1000,
          encodedProject: base,
          cwd
        });
      } catch {
        // ignore
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  let added = 0;
  for (const hit of hits.slice(0, limit)) {
    const existing = resolveExistingForProviderSession(store, hit.id, "claude");
    const messages: HistoryMessage[] = [];
    let jsonlCwd = "";
    try {
      const raw = await fs.readFile(hit.file, "utf8");
      jsonlCwd = extractCwdFromClaudeJsonl(raw);
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> | string };
            role?: string;
            content?: unknown;
          };
          // Skip tool/queue/system scaffolding lines entirely
          if (row.type && row.type !== "user" && row.type !== "assistant") continue;
          const role = row.message?.role || row.role || (row.type === "user" || row.type === "assistant" ? row.type : undefined);
          if (role !== "user" && role !== "assistant") continue;
          let text = "";
          const content = row.message?.content ?? row.content;
          if (typeof content === "string") text = content;
          else text = textFromContent(content);
          const cleaned = cleanImportedMessageText(role, text);
          if (cleaned) messages.push({ id: crypto.randomUUID(), role, text: cleaned });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    const titleFromUser = [...messages].reverse().find((m) => m.role === "user")?.text?.slice(0, 80);
    const mergedMessages = messages.length >= (existing?.messages?.length ?? 0)
      ? messages
      : (existing?.messages || messages);
    // Keep AnytimeVibe threadId (UUID) when this native session was already bound to a web task.
    const threadId = existing?.threadId || hit.id;
    // Order: transcript cwd → filesystem-resolved project dir → existing store.
    // Prefer sources that still exist on disk (see pickBestTaskCwd). Do not let a
    // prior lossy decode (py-cdp-bridge → py\cdp\bridge) stick forever.
    const cwd = await pickBestTaskCwd(allowedRoots, jsonlCwd, hit.cwd, existing?.cwd);
    const task: StoredTask = {
      threadId,
      engine: "claude",
      providerSessionId: hit.id,
      cwd,
      title: existing?.title || titleFromUser || `Claude ${hit.id.slice(0, 8)}`,
      status: mergeImportStatus(existing),
      createdAt: existing?.createdAt ?? hit.mtime,
      updatedAt: Math.max(existing?.updatedAt ?? 0, hit.mtime),
      messages: mergedMessages.slice(-80),
      ...(existing?.model ? { model: existing.model } : {}),
      ...(existing?.reasoningEffort ? { reasoningEffort: existing.reasoningEffort } : {}),
      ...(existing?.contextUsage ? { contextUsage: existing.contextUsage } : {})
    };
    await store.upsert(task);
    await removeOrphanNativeDuplicate(store, hit.id, threadId);
    added += 1;
  }
  return added;
}

/**
 * Collapse Claude/Grok/Cursor duplicates: same engine + provider session should be one task.
 * Prefer the AnytimeVibe UUID record; keep failed/interrupted over a stale "completed" clone.
 */
export async function dedupeMultiCliTasks(store: TaskStore): Promise<number> {
  const groups = new Map<string, StoredTask[]>();
  // list(1000) is enough for agent index size; import only keeps a recent window anyway.
  for (const task of store.list(1000)) {
    if (task.engine !== "claude" && task.engine !== "grok" && task.engine !== "cursor") continue;
    const native = (task.providerSessionId || task.threadId || "").trim();
    if (!native) continue;
    const key = `${task.engine}:${native}`;
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }
  let removed = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const aWeb = a.providerSessionId && a.providerSessionId !== a.threadId ? 1 : 0;
      const bWeb = b.providerSessionId && b.providerSessionId !== b.threadId ? 1 : 0;
      if (bWeb !== aWeb) return bWeb - aWeb;
      const aFail = /failed|error|interrupt|stop|cancel/i.test(a.status) ? 1 : 0;
      const bFail = /failed|error|interrupt|stop|cancel/i.test(b.status) ? 1 : 0;
      if (bFail !== aFail) return bFail - aFail;
      if ((b.messages?.length || 0) !== (a.messages?.length || 0)) {
        return (b.messages?.length || 0) - (a.messages?.length || 0);
      }
      return b.updatedAt - a.updatedAt;
    });
    const keep = group[0]!;
    const failed = group.find((item) => /failed|error|interrupt|stop|cancel/i.test(item.status));
    if (failed && /completed|idle|unknown/i.test(keep.status)) {
      keep.status = failed.status;
      keep.updatedAt = Math.max(keep.updatedAt, failed.updatedAt);
      await store.upsert(keep);
    }
    for (const extra of group.slice(1)) {
      if (extra.threadId === keep.threadId) continue;
      await store.remove(extra.threadId);
      removed += 1;
    }
  }
  return removed;
}

/** Import local Claude/Grok/Cursor CLI sessions into the agent task index for web sync. */
export async function importLocalCliSessions(
  store: TaskStore,
  limit = 10,
  allowedRoots: string[] = []
): Promise<{ grok: number; claude: number; cursor: number; junkCursorIds: string[] }> {
  const [grok, claude, cursor] = await Promise.all([
    importGrokSessions(store, limit),
    importClaudeSessions(store, limit, allowedRoots),
    importCursorSessions(store, limit)
  ]);
  try {
    await dedupeMultiCliTasks(store);
  } catch {
    // ignore
  }
  const junkCursorIds = listJunkCursorImportThreadIds(store);
  return { grok, claude, cursor, junkCursorIds };
}
