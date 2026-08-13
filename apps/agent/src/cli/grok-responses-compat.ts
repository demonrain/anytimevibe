import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

export type GrokCompatSession = {
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ensureUsage(usage: Record<string, any>): void {
  usage.input_tokens = Number(usage.input_tokens ?? 0) || 0;
  usage.output_tokens = Number(usage.output_tokens ?? 0) || 0;
  usage.total_tokens = Number(usage.total_tokens ?? usage.input_tokens + usage.output_tokens) || 0;
  if (!usage.input_tokens_details || typeof usage.input_tokens_details !== "object") {
    usage.input_tokens_details = { cached_tokens: 0 };
  } else {
    usage.input_tokens_details.cached_tokens = Number(usage.input_tokens_details.cached_tokens ?? 0) || 0;
  }
  if (!usage.output_tokens_details || typeof usage.output_tokens_details !== "object") {
    usage.output_tokens_details = { reasoning_tokens: 0 };
  } else {
    usage.output_tokens_details.reasoning_tokens = Number(usage.output_tokens_details.reasoning_tokens ?? 0) || 0;
  }
}

function ensureTextPart(part: Record<string, any>): void {
  if (part.type && part.type !== "output_text") return;
  if (!("text" in part) && part.type !== "output_text") return;
  part.type = "output_text";
  if (!Array.isArray(part.annotations)) part.annotations = [];
  if (!Array.isArray(part.logprobs)) part.logprobs = [];
  if (typeof part.text !== "string") part.text = String(part.text ?? "");
}

function ensureItem(item: Record<string, any>): void {
  if (item.type === "message" || item.role === "assistant") {
    item.type = item.type || "message";
    item.role = item.role || "assistant";
    item.status = item.status || "completed";
    if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && typeof part === "object") ensureTextPart(part as Record<string, any>);
      }
    }
  }
}

function ensureResponse(response: Record<string, any>): void {
  if (typeof response.created_at !== "number") response.created_at = nowSeconds();
  if (!response.object) response.object = "response";
  if (!response.status) response.status = "completed";
  if (!Array.isArray(response.output)) response.output = [];
  if (response.usage && typeof response.usage === "object") ensureUsage(response.usage);
  for (const item of response.output) {
    if (item && typeof item === "object") ensureItem(item as Record<string, any>);
  }
}

function walkPatch(node: unknown): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkPatch(item);
    return;
  }
  const obj = node as Record<string, any>;
  if (obj.object === "response" || (obj.id && obj.model && Array.isArray(obj.output))) {
    ensureResponse(obj);
  }
  if (obj.type === "output_text") ensureTextPart(obj);
  if (obj.response && typeof obj.response === "object") ensureResponse(obj.response);
  if (obj.item && typeof obj.item === "object") ensureItem(obj.item);
  if (obj.part && typeof obj.part === "object") ensureTextPart(obj.part);
  if (obj.usage && typeof obj.usage === "object") ensureUsage(obj.usage);
  for (const value of Object.values(obj)) walkPatch(value);
}

function patchSseOrJson(body: string, contentType: string): string {
  const isSse = /text\/event-stream/i.test(contentType)
    || body.startsWith("event:")
    || body.includes("\ndata: {");
  if (isSse) {
    let nextSeq = 0;
    return body.split(/(?<=\n)/).map((line) => {
      if (!line.startsWith("data: ")) return line;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const obj = JSON.parse(payload) as Record<string, any>;
        if (typeof obj.sequence_number !== "number") obj.sequence_number = nextSeq;
        nextSeq = Number(obj.sequence_number) + 1;
        walkPatch(obj);
        const ending = line.endsWith("\n") ? "\n" : "";
        return `data: ${JSON.stringify(obj)}${ending}`;
      } catch {
        return line;
      }
    }).join("");
  }
  const trimmed = body.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body;
  try {
    const obj = JSON.parse(body) as unknown;
    walkPatch(obj);
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

function parseTomlString(content: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "mi");
  return content.match(re)?.[1]?.trim() || undefined;
}

function resolveGrokCustomResponsesUpstream(configText: string): {
  modelId: string;
  upstream: string;
} | null {
  const modelsSection = configText.match(/\[models\]([\s\S]*?)(?=\n\[|$)/i)?.[1] ?? "";
  const defaultModel = parseTomlString(modelsSection, "default") || parseTomlString(configText, "model");
  const blockRe = /\[model\."([^"]+)"\]([\s\S]*?)(?=\n\[|$)/gi;
  let match: RegExpExecArray | null;
  const blocks: Array<{ id: string; body: string }> = [];
  while ((match = blockRe.exec(configText))) {
    blocks.push({ id: match[1], body: match[2] });
  }
  const preferred = (defaultModel
    ? blocks.find((block) => block.id === defaultModel)
    : undefined) || blocks[0];
  if (!preferred) return null;
  const baseUrl = parseTomlString(preferred.body, "base_url");
  const backend = (parseTomlString(preferred.body, "api_backend") || "responses").toLowerCase();
  if (!baseUrl) return null;
  if (!/responses/.test(backend)) return null;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  // Official Grok proxy already returns a complete schema — only patch third-party gateways.
  if (/(^|\.)grok\.com$/i.test(url.hostname) || /cli-chat-proxy\.grok\.com$/i.test(url.hostname)) {
    return null;
  }
  return { modelId: preferred.id, upstream: baseUrl.replace(/\/+$/, "") };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyFileIfExists(src: string, dest: string): Promise<void> {
  if (!(await pathExists(src))) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

/**
 * Third-party Responses gateways (e.g. store.demonrain.top) often omit fields that
 * Grok Build CLI requires (`created_at`, `sequence_number`, `annotations`,
 * `output_tokens_details`). Run a local reverse proxy that fills those defaults
 * and point a temporary GROK_HOME model base_url at it for headless turns.
 */
export async function prepareGrokResponsesCompat(baseEnv: NodeJS.ProcessEnv = process.env): Promise<GrokCompatSession | null> {
  const realHome = baseEnv.GROK_HOME?.trim() || path.join(os.homedir(), ".grok");
  const configPath = path.join(realHome, "config.toml");
  let configText = "";
  try {
    configText = await fs.readFile(configPath, "utf8");
  } catch {
    return null;
  }
  const target = resolveGrokCustomResponsesUpstream(configText);
  if (!target) return null;

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target.upstream.includes("://") ? target.upstream : `https://${target.upstream}`);
  } catch {
    return null;
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const incomingPath = req.url || "/";
      const forwardUrl = new URL(incomingPath, upstreamUrl);
      const headers: Record<string, string | number | string[] | undefined> = { ...req.headers, host: upstreamUrl.host };
      delete headers["content-length"];
      const transport = forwardUrl.protocol === "http:" ? httpRequest : httpsRequest;
      const upstreamReq = transport(
        {
          protocol: forwardUrl.protocol,
          hostname: forwardUrl.hostname,
          port: forwardUrl.port || (forwardUrl.protocol === "https:" ? 443 : 80),
          path: forwardUrl.pathname + forwardUrl.search,
          method: req.method,
          headers,
          timeout: 120_000
        },
        (upstreamRes) => {
          const responseChunks: Buffer[] = [];
          upstreamRes.on("data", (chunk) => responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          upstreamRes.on("end", () => {
            const raw = Buffer.concat(responseChunks).toString("utf8");
            const contentType = String(upstreamRes.headers["content-type"] || "application/json");
            const patched = patchSseOrJson(raw, contentType);
            const out = Buffer.from(patched, "utf8");
            const outHeaders = { ...upstreamRes.headers, "content-length": String(out.length) };
            res.writeHead(upstreamRes.statusCode || 502, outHeaders);
            res.end(out);
          });
        }
      );
      upstreamReq.on("error", (error) => {
        const message = JSON.stringify({ error: { message: String(error.message || error), type: "proxy_error" } });
        res.writeHead(502, { "content-type": "application/json", "content-length": Buffer.byteLength(message) });
        res.end(message);
      });
      upstreamReq.write(body);
      upstreamReq.end();
    });
  });

  const listenPort = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Grok compat proxy failed to bind"));
        return;
      }
      resolve(address.port);
    });
  });

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "anytimevibe-grok-"));
  const proxyBase = `http://127.0.0.1:${listenPort}/`;
  const escapedModel = target.modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patchedConfig = configText.replace(
    new RegExp(
      `(\\[model\\."${escapedModel}"\\][\\s\\S]*?base_url\\s*=\\s*")[^"]+(")`,
      "i"
    ),
    `$1${proxyBase}$2`
  );
  await fs.writeFile(path.join(tempHome, "config.toml"), patchedConfig, "utf8");
  await copyFileIfExists(path.join(realHome, "models_cache.json"), path.join(tempHome, "models_cache.json"));
  await copyFileIfExists(path.join(realHome, "auth.json"), path.join(tempHome, "auth.json"));
  await copyFileIfExists(path.join(realHome, "agent_id"), path.join(tempHome, "agent_id"));
  // Reuse real sessions so --resume keeps working.
  try {
    await fs.symlink(path.join(realHome, "sessions"), path.join(tempHome, "sessions"), "junction");
  } catch {
    // Fallback: leave empty sessions dir.
    await fs.mkdir(path.join(tempHome, "sessions"), { recursive: true });
  }

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    GROK_HOME: tempHome
  };

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { env, cleanup };
}

/** Enrich Grok CLI serialization errors so the web UI points at the real cause. */
export function explainGrokSerializationError(message: string): string {
  const raw = String(message || "").trim();
  if (!/missing field\s*`?(created_at|sequence_number|annotations|output_tokens_details)`?/i.test(raw)) {
    return raw;
  }
  return [
    raw,
    "",
    "说明：Grok Build 的 Responses 后端要求完整 SSE 字段；第三方网关常缺少 created_at / sequence_number / annotations 等。",
    "随码会在 headless 运行时自动经本机兼容代理补齐这些字段。若仍失败，请检查 ~/.grok/config.toml 中自定义 base_url / api_backend，或改回官方 Grok 登录。"
  ].join("\n");
}
