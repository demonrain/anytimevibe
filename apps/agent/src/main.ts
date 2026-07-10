import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  Tray
} from "electron";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  agentEventSchema,
  base64ToBytes,
  bytesToBase64,
  clientCommandSchema,
  createEnvelope,
  decryptPayload,
  derivePairingKey,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
  type AgentEvent,
  type ClientCommand,
  type EncryptedEnvelope,
  type Workspace
} from "@anytimevibe/protocol";
import { CodexAdapter, threadToSnapshot } from "./codex-adapter";
import { normalizeWindowsCommandPath, windowsCmdArguments } from "./windows-command";

const execFileAsync = promisify(execFile);

type StoredPairing = {
  id: string;
  code: string;
  secret: string;
  expiresAt: number;
};

type AgentConfig = {
  relayUrl: string;
  hostId?: string;
  encryptedAgentToken?: string;
  encryptedSyncKey?: string;
  encryptedPrivateKey?: string;
  publicKey?: JsonWebKey;
  pairing?: StoredPairing;
  workspaces: Workspace[];
  sequence: number;
};

type PublicState = {
  relayUrl: string;
  status: "unconfigured" | "pairing" | "connecting" | "online" | "offline" | "incompatible";
  detail: string;
  pairingCode?: string | undefined;
  pairingExpiresAt?: number | undefined;
  hostId?: string | undefined;
  codexVersion: string;
  workspaces: Workspace[];
};

let windowRef: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: AgentConfig;
let configPath = "";
let codexCommand = "codex.cmd";
let codexVersion = "unknown";
let publicState: PublicState = { relayUrl: "", status: "unconfigured", detail: "请先配置中继地址。", codexVersion, workspaces: [] };
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let codex: CodexAdapter | null = null;
let syncKey: CryptoKey | null = null;
let quitting = false;
const pendingPrompts = new Map<string, string>();
const pendingRequestTypes = new Map<string, "command" | "file" | "permission" | "input">();

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 安全存储当前不可用");
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value: string): string {
  return safeStorage.decryptString(Buffer.from(value, "base64"));
}

async function saveConfig(): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function updateState(patch: Partial<PublicState>): void {
  publicState = { ...publicState, ...patch, relayUrl: config.relayUrl, codexVersion, workspaces: config.workspaces };
  windowRef?.webContents.send("agent:state", publicState);
  rebuildTray();
}

function rebuildTray(): void {
  if (!tray) return;
  tray.setToolTip(`AnytimeVibe Agent · ${publicState.status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `状态：${publicState.status}`, enabled: false },
    { label: "打开控制面板", click: () => showWindow() },
    { label: "添加工作区", click: () => addWorkspace() },
    { label: "重新连接", click: () => connect().catch(handleError) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]));
}

function showWindow(): void {
  if (!windowRef) createWindow();
  windowRef?.show();
  windowRef?.focus();
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 620,
    height: 720,
    minWidth: 520,
    minHeight: 600,
    backgroundColor: "#f2eadb",
    title: "AnytimeVibe Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`);
  windowRef.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      windowRef?.hide();
    }
  });
}

function rendererHtml(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AnytimeVibe Agent</title><style>
  :root{font-family:"Bahnschrift","Aptos",sans-serif;color:#17211b;background:#f2eadb}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,rgba(226,88,50,.18),transparent 31%),#f2eadb}.shell{padding:30px}.head{display:flex;align-items:center;gap:13px;margin-bottom:28px}.mark{width:48px;height:48px;display:grid;place-items:center;background:#e25832;color:white;font-weight:900;border-radius:15px 15px 4px 15px}.head h1{font:700 24px Rockwell,serif;margin:0}.head p{margin:3px 0 0;color:#6b726b;font-size:11px;letter-spacing:.1em}.card{background:#fffaf0;border:1px solid rgba(23,33,27,.15);border-radius:20px;padding:21px;margin-bottom:15px;box-shadow:0 14px 35px rgba(34,39,31,.07)}.status{display:flex;align-items:center;justify-content:space-between}.status b{text-transform:uppercase;font-size:11px;letter-spacing:.12em}.dot{width:10px;height:10px;border-radius:50%;background:#999}.dot.online{background:#3bab70;box-shadow:0 0 0 6px rgba(59,171,112,.13)}.detail{color:#6b726b;font-size:13px;line-height:1.5}.pair{font:900 47px/1 monospace;letter-spacing:.2em;text-align:center;padding-left:.2em;color:#e25832;margin:18px 0}.row{display:flex;gap:9px}input{flex:1;border:1px solid rgba(23,33,27,.17);border-radius:10px;padding:12px;background:white}button{border:0;border-radius:10px;padding:11px 14px;background:#17211b;color:white;font-weight:800;cursor:pointer}button.secondary{background:#e7ddcd;color:#17211b}.workspaces{display:grid;gap:8px}.workspace{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;background:#eee6d8;border-radius:10px}.workspace div{min-width:0}.workspace strong,.workspace small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace small{color:#747a73;margin-top:3px}.workspace button{padding:5px 8px;background:transparent;color:#a43b25}.meta{font:11px/1.6 "Cascadia Code",monospace;color:#687068}.empty{text-align:center;color:#777;padding:14px}h2{font:700 17px Rockwell,serif;margin:0 0 13px}</style></head><body><main class="shell"><div class="head"><div class="mark">AV</div><div><h1>AnytimeVibe Agent</h1><p>WINDOWS REMOTE BRIDGE</p></div></div><section class="card"><div class="status"><b id="status">loading</b><span id="dot" class="dot"></span></div><p id="detail" class="detail">正在读取状态…</p><div class="meta" id="meta"></div></section><section class="card"><h2>中继服务器</h2><div class="row"><input id="relay" placeholder="https://vibe.example.com"><button id="saveRelay">保存</button></div><div id="pairBox"></div></section><section class="card"><div class="status"><h2>允许的工作区</h2><button id="addWorkspace" class="secondary">添加目录</button></div><div id="workspaces" class="workspaces"></div></section></main><script>
  const api=window.anytimeVibe;const status=document.querySelector('#status');const dot=document.querySelector('#dot');const detail=document.querySelector('#detail');const relay=document.querySelector('#relay');const pairBox=document.querySelector('#pairBox');const workspaces=document.querySelector('#workspaces');const meta=document.querySelector('#meta');
  function render(state){status.textContent=state.status;dot.className='dot '+(state.status==='online'?'online':'');detail.textContent=state.detail;relay.value=state.relayUrl||'';meta.textContent='Codex '+state.codexVersion+(state.hostId?' · Host '+state.hostId:'');pairBox.innerHTML=state.pairingCode?'<div class="pair">'+state.pairingCode+'</div><p class="detail">在移动端输入配对码。配对码约十分钟后失效。</p>':'<button id="startPair">生成配对码</button>';document.querySelector('#startPair')?.addEventListener('click',()=>api.startPairing());workspaces.innerHTML=state.workspaces.length?state.workspaces.map(w=>'<div class="workspace"><div><strong>'+escapeHtml(w.name)+'</strong><small>'+escapeHtml(w.path)+'</small></div><button data-id="'+w.id+'">移除</button></div>').join(''):'<div class="empty">尚未允许任何目录</div>';workspaces.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>api.removeWorkspace(button.dataset.id)));}
  function escapeHtml(value){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));}
  document.querySelector('#saveRelay').addEventListener('click',()=>api.setRelayUrl(relay.value));document.querySelector('#addWorkspace').addEventListener('click',()=>api.addWorkspace());api.onState(render);api.getState().then(render);
  </script></body></html>`;
}

async function loadConfig(): Promise<void> {
  configPath = path.join(app.getPath("userData"), "agent-config.json");
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as AgentConfig;
  } catch {
    config = { relayUrl: process.env.ANYTIMEVIBE_RELAY_URL ?? "", workspaces: [], sequence: 0 };
  }
  config.workspaces ??= [];
  config.sequence ??= 0;
  publicState = { ...publicState, relayUrl: config.relayUrl, workspaces: config.workspaces };
}

async function findCodex(): Promise<void> {
  if (process.env.CODEX_COMMAND) codexCommand = normalizeWindowsCommandPath(process.env.CODEX_COMMAND);
  else if (process.platform === "win32") {
    const result = await execFileAsync("where.exe", ["codex.cmd"]);
    codexCommand = normalizeWindowsCommandPath(result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? "codex.cmd");
  }
  let result: Awaited<ReturnType<typeof execFileAsync>>;
  try {
    result = process.platform === "win32"
      ? await execFileAsync(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(codexCommand, ["--version"]), {
          windowsHide: true,
          windowsVerbatimArguments: true
        })
      : await execFileAsync(codexCommand, ["--version"]);
  } catch {
    throw new Error(`无法运行 Codex CLI：${codexCommand}。请确认 Codex 已安装，并且 CODEX_COMMAND 配置正确。`);
  }
  const versionOutput = typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8");
  codexVersion = versionOutput.trim().replace(/^codex-cli\s+/, "");
  if (!/^0\.144\./.test(codexVersion)) {
    updateState({ status: "incompatible", detail: `当前仅支持 codex-cli 0.144.x，检测到 ${codexVersion}。` });
    throw new Error("Unsupported Codex version");
  }
}

async function ensurePairingKeys(): Promise<void> {
  if (config.encryptedPrivateKey && config.publicKey) return;
  const keyPair = await generatePairingKeyPair();
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  config.publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  config.encryptedPrivateKey = encryptSecret(JSON.stringify(privateJwk));
  await saveConfig();
}

async function startPairing(): Promise<PublicState> {
  if (!config.relayUrl) throw new Error("请先配置中继地址");
  await ensurePairingKeys();
  const secret = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const response = await fetch(`${config.relayUrl}/api/agent/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret,
      agentName: os.hostname(),
      platform: `${process.platform} ${os.release()}`,
      codexVersion,
      agentPublicKey: config.publicKey
    })
  });
  if (!response.ok) throw new Error(`中继返回 HTTP ${response.status}`);
  const result = await response.json() as { pairingId: string; code: string; expiresInSeconds: number };
  config.pairing = { id: result.pairingId, code: result.code, secret, expiresAt: Date.now() + result.expiresInSeconds * 1000 };
  await saveConfig();
  updateState({ status: "pairing", detail: "等待移动端确认并交换端到端加密密钥。", pairingCode: result.code, pairingExpiresAt: config.pairing.expiresAt });
  schedulePairingPoll();
  return publicState;
}

function schedulePairingPoll(): void {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => pollPairing().catch(handleError), 1800);
}

async function pollPairing(): Promise<void> {
  const pairing = config.pairing;
  if (!pairing) return;
  if (pairing.expiresAt <= Date.now()) {
    delete config.pairing;
    await saveConfig();
    updateState({ status: "offline", detail: "配对码已过期，请重新生成。", pairingCode: undefined, pairingExpiresAt: undefined });
    return;
  }
  const response = await fetch(`${config.relayUrl}/api/agent/pairings/${pairing.id}?secret=${encodeURIComponent(pairing.secret)}`);
  if (!response.ok) throw new Error(`配对状态查询失败：HTTP ${response.status}`);
  const result = await response.json() as Record<string, any>;
  if (result.status === "consumed") throw new Error("配对凭据已被读取但代理未完成保存，请重新生成配对码。");
  if (result.status !== "claimed") return schedulePairingPoll();
  const privateJwk = JSON.parse(decryptSecret(config.encryptedPrivateKey!)) as JsonWebKey;
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const pairingKey = await derivePairingKey(privateKey, result.clientPublicKey as JsonWebKey, pairing.id);
  const unwrapped = await decryptPayload<{ syncKey: string }>(pairingKey, result.wrappedSyncKey, pairing.id);
  config.hostId = String(result.hostId);
  config.encryptedAgentToken = encryptSecret(String(result.agentToken));
  config.encryptedSyncKey = encryptSecret(unwrapped.syncKey);
  delete config.pairing;
  await saveConfig();
  syncKey = await importAesKey(base64ToBytes(unwrapped.syncKey));
  updateState({ status: "connecting", detail: "配对完成，正在建立实时连接。", hostId: config.hostId, pairingCode: undefined, pairingExpiresAt: undefined });
  await connect();
}

function wsUrl(relayUrl: string): string {
  return relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

async function connect(force = false): Promise<void> {
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    if (config.pairing) schedulePairingPoll();
    return;
  }
  if (!/^0\.144\./.test(codexVersion)) return;
  if (!force && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const previousSocket = socket;
  socket = null;
  if (previousSocket) {
    previousSocket.removeAllListeners();
    previousSocket.close();
  }
  syncKey ??= await importAesKey(base64ToBytes(decryptSecret(config.encryptedSyncKey)));
  updateState({ status: "connecting", detail: "正在连接加密中继…", hostId: config.hostId });
  const token = decryptSecret(config.encryptedAgentToken);
  const connection = new WebSocket(`${wsUrl(config.relayUrl)}/ws/agent?hostId=${encodeURIComponent(config.hostId)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  socket = connection;
  connection.on("open", () => {
    if (socket !== connection) return connection.close();
    void (async () => {
      updateState({ status: "online", detail: "代理在线。Codex 凭据和项目文件均保留在本机。" });
      await ensureCodex();
      await publishHostStatus();
      await syncAllThreads();
    })().catch((error) => {
      handleError(error);
      connection.close();
    });
  });
  connection.on("message", (data) => handleRelayMessage(String(data)).catch(handleError));
  connection.on("close", () => {
    if (socket !== connection) return;
    socket = null;
    scheduleReconnect("中继连接已断开，正在重试。");
  });
  connection.on("error", () => {
    if (socket === connection) updateState({ status: "offline", detail: "无法连接中继，正在重试。" });
    connection.close();
  });
}

function scheduleReconnect(detail: string): void {
  if (publicState.status === "incompatible") return;
  updateState({ status: "offline", detail });
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(handleError);
  }, 1800 + Math.floor(Math.random() * 1200));
}

async function ensureCodex(): Promise<void> {
  if (codex) return;
  codex = new CodexAdapter(codexCommand, (message) => handleCodexMessage(message).catch(handleError), (detail) => {
    codex = null;
    updateState({ status: "offline", detail });
  });
  await codex.start();
}

async function handleRelayMessage(raw: string): Promise<void> {
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  if (!syncKey) throw new Error("Missing sync key");
  const command = clientCommandSchema.parse(await openEnvelope<ClientCommand>(syncKey, envelope));
  await handleCommand(command);
}

function isAllowedWorkspace(requestedPath: string): boolean {
  const requested = path.resolve(requestedPath).toLowerCase();
  return config.workspaces.some((workspace) => {
    const root = path.resolve(workspace.path).toLowerCase();
    const relative = path.relative(root, requested);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

async function handleCommand(command: ClientCommand): Promise<void> {
  await ensureCodex();
  try {
    if (command.type === "task.create") {
      if (!isAllowedWorkspace(command.cwd)) throw new Error("工作目录不在代理白名单中");
      const started = await codex!.request("thread/start", {
        cwd: command.cwd,
        approvalPolicy: "on-request",
        sandbox: "workspace-write"
      });
      const thread = started.thread;
      if (command.title) await codex!.request("thread/name/set", { threadId: thread.id, name: command.title });
      await publishThread(thread.id);
      const turn = await codex!.request("turn/start", {
        threadId: thread.id,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      });
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: thread.id, turnId: turn.turn.id, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "thread.resume") {
      await codex!.request("thread/resume", { threadId: command.threadId });
      await publishThread(command.threadId);
      return;
    }
    if (command.type === "turn.start") {
      const result = await codex!.request("turn/start", {
        threadId: command.threadId,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      });
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: result.turn.id, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "turn.steer") {
      pendingPrompts.set(command.threadId, command.prompt);
      await codex!.request("turn/steer", {
        threadId: command.threadId,
        expectedTurnId: command.turnId,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      });
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: command.turnId, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "turn.interrupt") {
      await codex!.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId });
      return;
    }
    if (command.type === "approval.resolve") {
      const requestType = pendingRequestTypes.get(String(command.requestId));
      pendingRequestTypes.delete(String(command.requestId));
      if (requestType === "input") codex!.respond(command.requestId, { answers: {} });
      else if (requestType === "permission") codex!.respondError(command.requestId, "Declined by remote user");
      else codex!.respond(command.requestId, { decision: command.decision });
      return;
    }
    if (command.type === "sync.request") {
      const threadCount = await syncAllThreads();
      await publish({
        type: "sync.completed",
        eventId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        threadCount
      }, false);
    }
  } catch (error) {
    await publish({
      type: "error",
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : "Command failed",
      commandId: command.commandId,
      ...("threadId" in command ? { threadId: command.threadId } : {})
    }, true);
  }
}

async function handleCodexMessage(message: Record<string, any>): Promise<void> {
  if (message.method === "item/agentMessage/delta") {
    const params = message.params;
    await publish({ type: "turn.delta", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta }, true);
  }
  if (message.method === "turn/diff/updated") {
    const params = message.params;
    await publish({ type: "diff.updated", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: params.threadId, turnId: params.turnId, diff: params.diff }, true);
  }
  if (message.method === "turn/completed") {
    const params = message.params;
    await publish({ type: "turn.completed", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: params.threadId, turnId: params.turn.id, status: String(params.turn.status) }, true, "completed");
    await publishThread(params.threadId);
  }
  if (message.method === "serverRequest/resolved") {
    pendingRequestTypes.delete(String(message.params.requestId));
    await publish({ type: "request.resolved", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.params.requestId, threadId: message.params.threadId }, true);
  }
  if (message.id !== undefined && message.method === "item/commandExecution/requestApproval") {
    pendingRequestTypes.set(String(message.id), "command");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "command",
      title: "允许 Codex 执行命令？", detail: [params.command, params.cwd, params.reason].filter(Boolean).join("\n"),
      availableDecisions: ["accept", "decline", "cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/fileChange/requestApproval") {
    pendingRequestTypes.set(String(message.id), "file");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "file",
      title: "允许 Codex 修改文件？", detail: params.reason || params.grantRoot || "Codex 请求写入工作区。",
      availableDecisions: ["accept", "decline", "cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/tool/requestUserInput") {
    pendingRequestTypes.set(String(message.id), "input");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "input",
      title: "Codex 需要补充信息", detail: JSON.stringify(params.questions, null, 2), availableDecisions: ["cancel"]
    }, true, "approval");
  }
  if (message.id !== undefined && message.method === "item/permissions/requestApproval") {
    pendingRequestTypes.set(String(message.id), "permission");
    const params = message.params;
    await publish({
      type: "approval.requested", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), requestId: message.id,
      threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, approvalType: "permission",
      title: "Codex 请求额外权限", detail: JSON.stringify({ reason: params.reason, permissions: params.permissions }, null, 2), availableDecisions: ["cancel"]
    }, true, "approval");
  }
}

async function publishHostStatus(): Promise<void> {
  await publish({
    type: "host.status", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), online: true,
    name: os.hostname(), platform: `${process.platform} ${os.release()}`, codexVersion,
    workspaces: config.workspaces
  }, true);
}

async function publishThread(threadId: string): Promise<void> {
  const result = await codex!.request("thread/read", { threadId, includeTurns: true });
  const snapshot = threadToSnapshot(result.thread);
  await publish({ type: "thread.snapshot", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), ...snapshot }, true);
}

async function syncAllThreads(): Promise<number> {
  await ensureCodex();
  const response = await codex!.request("thread/list", { limit: 100, sortDirection: "desc" });
  const threads = response.data ?? [];
  for (const thread of threads) {
    try { await publishThread(thread.id); } catch (error) { handleError(error); }
  }
  return threads.length;
}

async function publish(event: AgentEvent, persist: boolean, hint?: "approval" | "completed"): Promise<void> {
  agentEventSchema.parse(event);
  if (!socket || socket.readyState !== WebSocket.OPEN || !config.hostId || !syncKey) return;
  config.sequence += 1;
  await saveConfig();
  const envelope = await createEnvelope(config.hostId, config.sequence, syncKey, event, { persist, ...(hint ? { hint } : {}) });
  socket.send(JSON.stringify(envelope));
}

async function addWorkspace(): Promise<PublicState> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  const selected = result.filePaths[0];
  if (!selected) return publicState;
  const resolved = path.resolve(selected);
  if (!config.workspaces.some((workspace) => path.resolve(workspace.path).toLowerCase() === resolved.toLowerCase())) {
    config.workspaces.push({ id: crypto.randomUUID(), name: path.basename(resolved), path: resolved });
    await saveConfig();
    updateState({ workspaces: config.workspaces });
    await publishHostStatus();
  }
  return publicState;
}

function handleError(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(error);
  updateState({ status: publicState.status === "incompatible" ? "incompatible" : "offline", detail });
}

function registerIpc(): void {
  ipcMain.handle("agent:get-state", () => publicState);
  ipcMain.handle("agent:set-relay-url", async (_event, relayUrl: string) => {
    const normalized = relayUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(normalized)) throw new Error("中继地址必须以 http:// 或 https:// 开头");
    config.relayUrl = normalized;
    await saveConfig();
    updateState({ relayUrl: normalized, status: config.hostId ? "offline" : "unconfigured", detail: config.hostId ? "中继地址已更新，请重新连接。" : "中继地址已保存，请生成配对码。" });
    return publicState;
  });
  ipcMain.handle("agent:start-pairing", () => startPairing());
  ipcMain.handle("agent:add-workspace", () => addWorkspace());
  ipcMain.handle("agent:remove-workspace", async (_event, id: string) => {
    config.workspaces = config.workspaces.filter((workspace) => workspace.id !== id);
    await saveConfig();
    updateState({ workspaces: config.workspaces });
    await publishHostStatus();
    return publicState;
  });
  ipcMain.handle("agent:reconnect", async () => { await connect(true); return publicState; });
}

app.whenReady().then(async () => {
  await loadConfig();
  registerIpc();
  app.setLoginItemSettings({ openAtLogin: true });
  const trayImage = nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#17211b"/><path d="M13 20h38v25H13z" fill="#f2eadb"/><path d="m19 27 7 5-7 6" fill="none" stroke="#e25832" stroke-width="5"/><path d="M31 39h14" stroke="#2d7653" stroke-width="5"/></svg>').toString("base64"));
  tray = new Tray(trayImage.resize({ width: 18, height: 18 }));
  tray.on("double-click", showWindow);
  createWindow();
  try {
    await findCodex();
    updateState({ codexVersion, detail: config.relayUrl ? "Codex 已就绪。" : "请先配置中继地址。" });
    if (config.pairing) schedulePairingPoll();
    if (config.hostId) await connect();
  } catch (error) {
    handleError(error);
  }
});

app.on("window-all-closed", () => undefined);
app.on("before-quit", () => {
  quitting = true;
  reconnectTimer && clearTimeout(reconnectTimer);
  pairingTimer && clearTimeout(pairingTimer);
  socket?.close();
  codex?.stop();
});
