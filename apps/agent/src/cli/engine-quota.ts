/**
 * Query subscription / plan usage from local coding CLIs.
 * Prefer native CLI commands (about / usage / auth status); fall back to known local APIs.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ENGINE_QUOTA_DETAIL_MAX, type CliEngine, type EngineQuota } from "@anytimevibe/protocol";
import { windowsCmdArguments } from "../windows-command";
import { resolveEngineBinary } from "./detect";

const execFileAsync = promisify(execFile);
const DETAIL_MAX = ENGINE_QUOTA_DETAIL_MAX;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function runCliText(
  command: string,
  args: string[],
  options?: { timeoutMs?: number; cwd?: string }
): Promise<{ ok: boolean; text: string; code?: number }> {
  const timeoutMs = options?.timeoutMs ?? 25_000;
  try {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? process.env.ComSpec ?? "cmd.exe" : command;
    const finalArgs = isWindows ? windowsCmdArguments(command, args) : args;
    const { stdout, stderr } = await execFileAsync(executable, finalArgs, {
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
      env: process.env,
      cwd: options?.cwd || process.cwd(),
      maxBuffer: 1_000_000
    });
    const text = `${stdout || ""}\n${stderr || ""}`.trim();
    return { ok: true, text, code: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string; code?: number };
    const text = `${err.stdout || ""}\n${err.stderr || ""}`.trim()
      || String(err.message || "").trim();
    return typeof err.code === "number"
      ? { ok: false, text, code: err.code }
      : { ok: false, text };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function compactDetail(text: string, max = DETAIL_MAX): string {
  const cleaned = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

/** Ensure quota objects always pass protocol validation before publish. */
export function sanitizeEngineQuota(quota: EngineQuota): EngineQuota {
  const label = quota.label?.trim().slice(0, 80);
  const currency = quota.currency?.trim().slice(0, 8);
  const detail = quota.detail ? compactDetail(quota.detail, DETAIL_MAX) : undefined;
  return {
    ...quota,
    ...(label ? { label } : {}),
    ...(currency ? { currency } : {}),
    ...(detail ? { detail } : {})
  };
}

/** Parse free-form CLI text into structured quota fields when possible. */
export function parseQuotaFromText(engine: CliEngine, raw: string, label?: string): EngineQuota | null {
  if (!raw.trim()) return null;
  const text = raw.replace(/\r/g, "\n");
  const checkedAt = nowIso();
  const baseLabel = label || engine;

  // Money: $12.34 remaining / used $x of $y
  const moneyPair = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$\s*([0-9]+(?:\.[0-9]+)?)/)
    || text.match(/([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*USD/i);
  if (moneyPair) {
    const used = Number(moneyPair[1]);
    const limit = Number(moneyPair[2]);
    if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
      const remaining = Math.max(0, limit - used);
      return {
        engine,
        label: baseLabel,
        amountRemaining: remaining,
        amountLimit: limit,
        currency: "USD",
        remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))),
        usedPercent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
        detail: compactDetail(text),
        checkedAt
      };
    }
  }
  const moneyRem = text.match(/(?:remaining|left|余额|剩余)[^\n$¥€£]*([$¥€£])\s*([0-9]+(?:\.[0-9]+)?)/i)
    || text.match(/([$¥€£])\s*([0-9]+(?:\.[0-9]+)?)\s*(?:remaining|left|余额|剩余)/i);
  if (moneyRem) {
    const symbol = moneyRem[1] === "$" ? "USD" : moneyRem[1] === "¥" ? "CNY" : moneyRem[1] === "€" ? "EUR" : moneyRem[1] === "£" ? "GBP" : String(moneyRem[1]);
    return {
      engine,
      label: baseLabel,
      amountRemaining: Number(moneyRem[2]),
      currency: symbol,
      detail: compactDetail(text),
      checkedAt
    };
  }

  // Percent remaining / used
  const remainingPct = text.match(/(?:remaining|left|剩余)[^\n%]*?(\d{1,3}(?:\.\d+)?)\s*%/i)
    || text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:remaining|left|剩余)/i);
  const usedPct = text.match(/(?:used|usage|已用)[^\n%]*?(\d{1,3}(?:\.\d+)?)\s*%/i)
    || text.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(?:used|usage|已用)/i);
  if (remainingPct || usedPct) {
    const remainingPercent = remainingPct
      ? Math.max(0, Math.min(100, Number(remainingPct[1])))
      : (usedPct ? Math.max(0, Math.min(100, 100 - Number(usedPct[1]))) : undefined);
    const usedPercent = usedPct
      ? Math.max(0, Math.min(100, Number(usedPct[1])))
      : (remainingPercent != null ? 100 - remainingPercent : undefined);
    return {
      engine,
      label: baseLabel,
      ...(remainingPercent != null ? { remainingPercent } : {}),
      ...(usedPercent != null ? { usedPercent } : {}),
      detail: compactDetail(text),
      checkedAt
    };
  }

  // Absolute remaining / limit pairs
  const pair = text.match(/(?:remaining|left|剩余|used)\s*[:=]?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\/\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i)
    || text.match(/([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)\s*(?:req|requests|tokens)?/i);
  if (pair?.[1] && pair[2]) {
    const a = Number(pair[1].replace(/,/g, ""));
    const b = Number(pair[2].replace(/,/g, ""));
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      // Heuristic: if "used/limit" wording, a is used; if remaining/limit, a is remaining
      const usedStyle = /used|已用/i.test(text) && !/remaining|剩余/i.test(text.slice(0, 80));
      const remaining = usedStyle ? Math.max(0, b - a) : a;
      const used = usedStyle ? a : Math.max(0, b - a);
      return {
        engine,
        label: baseLabel,
        remaining,
        limit: b,
        remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / b) * 100))),
        usedPercent: Math.max(0, Math.min(100, Math.round((used / b) * 100))),
        detail: compactDetail(text),
        checkedAt
      };
    }
  }

  // Always keep raw CLI output when it looks informative
  if (text.trim().length > 0) {
    return {
      engine,
      label: baseLabel,
      detail: compactDetail(text),
      checkedAt
    };
  }
  return null;
}

function parseJsonLoose(raw: string): unknown {
  const t = raw.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // stream-json / mixed: take last {...} object
    const start = t.lastIndexOf("{");
    const end = t.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ── Cursor ──────────────────────────────────────────────────────────────

async function readCursorAccessFromVscdb(): Promise<{ userId?: string; accessToken?: string } | null> {
  const appData = process.env.APPDATA || process.env.HOME || "";
  const candidates = process.platform === "win32"
    ? [path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb")]
    : process.platform === "darwin"
      ? [path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")]
      : [path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb")];
  const dbPath = candidates.find((p) => p) || "";
  if (!dbPath || !(await pathExists(dbPath))) return null;

  // Prefer python sqlite3 (handles large DBs); avoid loading multi-GB files into Node.
  const py = process.platform === "win32" ? "python" : "python3";
  const script = [
    "import sqlite3,sys,json",
    `con=sqlite3.connect(${JSON.stringify(dbPath)})`,
    "cur=con.cursor()",
    "rows=cur.execute(\"select key,value from ItemTable where key like '%cursorAuth%' or key like '%accessToken%' or key like '%email%' or key like '%userId%'\").fetchall()",
    "out={}",
    "for k,v in rows:",
    "  try:",
    "    s=v.decode('utf-8') if isinstance(v,bytes) else str(v)",
    "  except Exception:",
    "    s=str(v)",
    "  out[k]=s[:5000]",
    "print(json.dumps(out))",
  ].join("\n");
  try {
    const { stdout } = await execFileAsync(py, ["-c", script], {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 2_000_000
    });
    const map = JSON.parse(String(stdout || "{}")) as Record<string, string>;
    let accessToken: string | undefined;
    let userId: string | undefined;
    for (const [key, value] of Object.entries(map)) {
      if (/accessToken/i.test(key) && value && value.length > 20) accessToken = value.replace(/^"|"$/g, "");
      if (/userId|authId|cachedEmail/i.test(key) && value) {
        const m = value.match(/user_[A-Za-z0-9]+/);
        if (m) userId = m[0];
        else if (/^\d+$/.test(value)) userId = value;
      }
    }
    // Also try authInfo from cli-config
    try {
      const cliCfg = path.join(os.homedir(), ".cursor", "cli-config.json");
      const raw = await fs.readFile(cliCfg, "utf8");
      const cfg = JSON.parse(raw) as { authInfo?: { userId?: number | string; authId?: string; email?: string } };
      if (!userId && cfg.authInfo?.authId) userId = String(cfg.authInfo.authId);
      if (!userId && cfg.authInfo?.userId != null) userId = String(cfg.authInfo.userId);
    } catch {
      // ignore
    }
    if (!accessToken && !userId) return null;
    return { ...(userId ? { userId } : {}), ...(accessToken ? { accessToken } : {}) };
  } catch {
    return null;
  }
}

async function fetchCursorWebUsage(auth: { userId?: string; accessToken?: string }): Promise<EngineQuota | null> {
  if (!auth.accessToken) return null;
  const user = auth.userId || "";
  const cookie = user
    ? `WorkosCursorSessionToken=${encodeURIComponent(`${user}::${auth.accessToken}`)}`
    : `WorkosCursorSessionToken=${encodeURIComponent(auth.accessToken)}`;
  const urls = [
    user ? `https://cursor.com/api/usage?user=${encodeURIComponent(user)}` : "https://cursor.com/api/usage",
    "https://www.cursor.com/api/usage"
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          Cookie: cookie,
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          "User-Agent": "AnytimeVibe-Agent"
        },
        signal: AbortSignal.timeout(12_000)
      });
      if (!res.ok) continue;
      const data = await res.json() as Record<string, any>;
      // Legacy request-count shape
      const maxReq = Number(data.maxRequestUsage ?? data.max_request_usage ?? 0);
      const usedReq = Number(data.numRequestsTotal ?? data.num_requests ?? data.used ?? 0);
      if (maxReq > 0) {
        const remaining = Math.max(0, maxReq - usedReq);
        return {
          engine: "cursor",
          label: "Cursor",
          remaining,
          limit: maxReq,
          remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / maxReq) * 100))),
          usedPercent: Math.max(0, Math.min(100, Math.round((usedReq / maxReq) * 100))),
          detail: compactDetail(JSON.stringify(data, null, 0)),
          checkedAt: nowIso()
        };
      }
      // USD planUsage shape
      const plan = data.planUsage || data.plan_usage || data;
      const limitCents = Number(plan.limit ?? plan.included ?? plan.limitUsd ?? 0);
      const remainingCents = Number(plan.remaining ?? plan.remainingUsd ?? NaN);
      const totalPct = Number(plan.totalPercentUsed ?? plan.total_percent_used ?? data.totalPercentUsed ?? NaN);
      if (Number.isFinite(limitCents) && limitCents > 0) {
        const limit = limitCents > 1000 ? limitCents / 100 : limitCents; // cents vs dollars heuristic
        let used: number;
        if (Number.isFinite(remainingCents)) {
          const rem = remainingCents > 1000 ? remainingCents / 100 : remainingCents;
          used = Math.max(0, limit - rem);
        } else if (Number.isFinite(totalPct)) {
          used = limit * (totalPct / 100);
        } else {
          used = Number(plan.used ?? 0);
        }
        const remaining = Math.max(0, limit - used);
        return {
          engine: "cursor",
          label: "Cursor",
          amountRemaining: Math.round(remaining * 100) / 100,
          amountLimit: Math.round(limit * 100) / 100,
          currency: "USD",
          remainingPercent: Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))),
          usedPercent: Math.max(0, Math.min(100, Math.round((used / limit) * 100))),
          detail: compactDetail(JSON.stringify(data, null, 0)),
          checkedAt: nowIso()
        };
      }
      // Unknown JSON — still surface it
      return {
        engine: "cursor",
        label: "Cursor",
        detail: compactDetail(JSON.stringify(data)),
        checkedAt: nowIso()
      };
    } catch {
      // try next
    }
  }
  return null;
}

async function queryCursorQuota(binary: string): Promise<EngineQuota> {
  const chunks: string[] = [];
  // 1) Native CLI account info
  const about = await runCliText(binary, ["about", "--format", "json"], { timeoutMs: 15_000 });
  if (about.text) chunks.push(about.text);
  const status = await runCliText(binary, ["status"], { timeoutMs: 12_000 });
  if (status.text) chunks.push(status.text);

  // 2) Web usage API via local desktop session token (same source as Cursor dashboard)
  const auth = await readCursorAccessFromVscdb();
  const apiQuota = auth ? await fetchCursorWebUsage(auth) : null;
  if (apiQuota) {
    // Enrich label from about
    const aboutJson = parseJsonLoose(about.text) as Record<string, any> | null;
    const tier = aboutJson?.subscriptionTier || aboutJson?.subscription_tier;
    if (tier && typeof tier === "string") {
      apiQuota.label = `Cursor ${tier}`;
    }
    const aboutDetail = compactDetail([about.text, status.text].filter(Boolean).join("\n"));
    if (aboutDetail) {
      apiQuota.detail = [apiQuota.detail, aboutDetail].filter(Boolean).join("\n").slice(0, 600);
    }
    return apiQuota;
  }

  // 3) Parse about/status text
  const combined = chunks.join("\n");
  const aboutJson = parseJsonLoose(about.text) as Record<string, any> | null;
  if (aboutJson) {
    const tier = String(aboutJson.subscriptionTier || aboutJson.subscription_tier || "Cursor");
    const email = aboutJson.userEmail || aboutJson.email;
    return {
      engine: "cursor",
      label: `Cursor ${tier}`,
      detail: compactDetail(
        [
          `订阅：${tier}`,
          email ? `账号：${email}` : "",
          "CLI about 未返回剩余额度；桌面 Cursor 未登录时无法读取 dashboard usage。",
          "可打开 https://cursor.com/dashboard?tab=usage 查看。",
          combined
        ].filter(Boolean).join("\n")
      ),
      checkedAt: nowIso()
    };
  }
  return parseQuotaFromText("cursor", combined, "Cursor") || {
    engine: "cursor",
    label: "Cursor",
    detail: compactDetail(combined || "未获取到 Cursor 额度信息。请确认 cursor-agent 已登录。"),
    checkedAt: nowIso()
  };
}

// ── Claude ──────────────────────────────────────────────────────────────

async function queryClaudeQuota(binary: string): Promise<EngineQuota> {
  const chunks: string[] = [];
  // Slash-command style (Claude Code): /usage and /cost via print mode
  for (const prompt of ["/usage", "/cost"]) {
    const r = await runCliText(
      binary,
      ["-p", prompt, "--output-format", "json", "--bare"],
      { timeoutMs: 45_000 }
    );
    if (r.text) chunks.push(`# claude -p ${prompt}\n${r.text}`);
    const j = parseJsonLoose(r.text) as Record<string, any> | null;
    if (j) {
      // result field may hold human text
      const resultText = typeof j.result === "string" ? j.result : "";
      const cost = Number(j.total_cost_usd ?? j.totalCostUsd ?? NaN);
      const usage = j.usage || {};
      const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
      const output = Number(usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
      const parsed = parseQuotaFromText("claude", resultText || r.text, "Claude");
      if (parsed && (parsed.remainingPercent != null || parsed.amountRemaining != null || parsed.remaining != null)) {
        return { ...parsed, detail: compactDetail(chunks.join("\n\n")) };
      }
      if (Number.isFinite(cost) || input || output || resultText) {
        return {
          engine: "claude",
          label: "Claude",
          detail: compactDetail(
            [
              Number.isFinite(cost) ? `本次会话成本：$${Number(cost).toFixed(4)}` : "",
              (input || output) ? `Token：in ${input} / out ${output}` : "",
              resultText,
              "说明：Claude CLI 的 /usage 多为会话用量，订阅池请见 console.anthropic.com",
              chunks.join("\n")
            ].filter(Boolean).join("\n")
          ),
          checkedAt: nowIso()
        };
      }
    }
  }
  const auth = await runCliText(binary, ["auth", "status"], { timeoutMs: 12_000 });
  if (auth.text) chunks.push(`# claude auth status\n${auth.text}`);
  return {
    engine: "claude",
    label: "Claude",
    detail: compactDetail(chunks.join("\n\n") || "未能读取 Claude 用量。请确认 claude 已登录。"),
    checkedAt: nowIso()
  };
}

// ── Codex ───────────────────────────────────────────────────────────────

async function resolveCodexBinary(): Promise<string | null> {
  if (process.env.CODEX_COMMAND) return process.env.CODEX_COMMAND;
  const names = process.platform === "win32"
    ? ["codex.cmd", "codex.exe", "codex"]
    : ["codex"];
  for (const name of names) {
    const hit = await runCliText(name, ["--version"], { timeoutMs: 8_000 });
    if (hit.ok || /codex/i.test(hit.text)) return name;
  }
  return null;
}

async function queryCodexQuota(): Promise<EngineQuota> {
  const binary = await resolveCodexBinary();
  const chunks: string[] = [];
  if (binary) {
    const login = await runCliText(binary, ["login", "status"], { timeoutMs: 12_000 });
    if (login.text) chunks.push(`# codex login status\n${login.text}`);
    const doctor = await runCliText(binary, ["doctor"], { timeoutMs: 20_000 });
    // doctor can be huge / hang — only keep first lines if any
    if (doctor.text) chunks.push(`# codex doctor\n${doctor.text.split(/\r?\n/).slice(0, 30).join("\n")}`);
  }
  // Auth mode from local file (no secret values)
  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    const raw = await fs.readFile(authPath, "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const mode = String(auth.auth_mode || auth.mode || (auth.OPENAI_API_KEY ? "api_key" : "unknown"));
    chunks.push(`auth_mode: ${mode}`);
  } catch {
    // ignore
  }
  const parsed = parseQuotaFromText("codex", chunks.join("\n"), "Codex");
  return parsed || {
    engine: "codex",
    label: "Codex",
    detail: compactDetail(
      [
        chunks.join("\n") || "Codex CLI 已检测。",
        "Codex 无稳定 /usage 子命令；ChatGPT 订阅额度请见 chatgpt.com 账号页。",
        "若使用 API Key，用量见 platform.openai.com/usage。"
      ].join("\n")
    ),
    checkedAt: nowIso()
  };
}

// ── Grok ────────────────────────────────────────────────────────────────

async function queryGrokQuota(binary: string): Promise<EngineQuota> {
  const chunks: string[] = [];
  // Prefer native subcommands; Grok may not expose /usage yet
  for (const args of [["version"], ["models"], ["inspect"]] as string[][]) {
    const r = await runCliText(binary, args, { timeoutMs: 15_000 });
    if (r.text && r.text.length < 4000) chunks.push(`# grok ${args.join(" ")}\n${r.text}`);
  }
  // Try slash-style via single-turn (may no-op)
  const usage = await runCliText(
    binary,
    ["-p", "/usage", "--output-format", "plain", "--always-approve"],
    { timeoutMs: 30_000 }
  );
  if (usage.text && !/unknown command|unrecognized/i.test(usage.text.slice(0, 120))) {
    chunks.push(`# grok -p /usage\n${usage.text}`);
  }
  try {
    const authPath = path.join(os.homedir(), ".grok", "auth.json");
    if (await pathExists(authPath)) {
      const raw = await fs.readFile(authPath, "utf8");
      const auth = JSON.parse(raw) as Record<string, unknown>;
      chunks.push(`auth_entries: ${Object.keys(auth).length}`);
    }
  } catch {
    // ignore
  }
  const parsed = parseQuotaFromText("grok", chunks.join("\n"), "Grok");
  if (parsed && (parsed.remainingPercent != null || parsed.amountRemaining != null || parsed.remaining != null)) {
    return parsed;
  }
  return {
    engine: "grok",
    label: "Grok",
    detail: compactDetail(
      [
        chunks.join("\n\n") || "已检测 Grok CLI。",
        "Grok Build 暂无稳定 usage 子命令；订阅额度请见 console.x.ai / xAI 账号页。"
      ].join("\n")
    ),
    checkedAt: nowIso()
  };
}

// ── Public entry ────────────────────────────────────────────────────────

export async function queryEngineQuotas(
  filter?: CliEngine,
  options?: { codexInstalled?: boolean }
): Promise<EngineQuota[]> {
  const engines: CliEngine[] = filter
    ? [filter]
    : ["codex", "claude", "grok", "cursor"];
  const results: EngineQuota[] = [];

  for (const engine of engines) {
    try {
      if (engine === "codex") {
        if (options?.codexInstalled === false) continue;
        results.push(sanitizeEngineQuota(await queryCodexQuota()));
        continue;
      }
      const binary = await resolveEngineBinary(engine);
      if (!binary) {
        results.push(sanitizeEngineQuota({
          engine,
          label: engine,
          detail: `未找到 ${engine} CLI，无法查询额度。`,
          checkedAt: nowIso()
        }));
        continue;
      }
      if (engine === "cursor") results.push(sanitizeEngineQuota(await queryCursorQuota(binary)));
      else if (engine === "claude") results.push(sanitizeEngineQuota(await queryClaudeQuota(binary)));
      else if (engine === "grok") results.push(sanitizeEngineQuota(await queryGrokQuota(binary)));
    } catch (error) {
      results.push(sanitizeEngineQuota({
        engine,
        label: engine,
        detail: `查询失败：${error instanceof Error ? error.message : String(error)}`,
        checkedAt: nowIso()
      }));
    }
  }
  return results;
}
