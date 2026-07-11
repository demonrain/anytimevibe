import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray
} from "electron";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { autoUpdater } from "electron-updater";
import {
  agentEventSchema,
  base64ToBytes,
  bytesToBase64,
  clientCommandSchema,
  createEnvelope,
  derivePairingKey,
  encryptPayload,
  generatePairingKeyPair,
  importAesKey,
  openEnvelope,
  randomKeyBytes,
  type AgentEvent,
  type ClientCommand,
  type EncryptedEnvelope,
  type Workspace
} from "@anytimevibe/protocol";
import { CodexAdapter, threadStartParams, threadToSnapshot } from "./codex-adapter";
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
  agentId: string;
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
  status: "unconfigured" | "waiting_pairing" | "pairing" | "connecting" | "online" | "offline" | "incompatible";
  detail: string;
  pairingCode?: string | undefined;
  pairingExpiresAt?: number | undefined;
  hostId?: string | undefined;
  codexVersion: string;
  workspaces: Workspace[];
  environment: EnvironmentState;
  update: UpdateState;
  activity?: ActivityState;
};

type ActivityState = {
  threadId: string;
  title: string;
  prompt: string;
  status: "processing" | "completed" | "failed" | "interrupted";
  output: string;
};

type EnvironmentState = {
  platform: "windows" | "macos" | "other";
  nodeInstalled: boolean;
  nodeVersion?: string;
  codexInstalled: boolean;
  codexVersion?: string;
  codexCompatible: boolean;
};

type UpdateState = {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  progress?: number;
  message?: string;
};

let windowRef: BrowserWindow | null = null;
let tray: Tray | null = null;
let config: AgentConfig;
let configPath = "";
let codexCommand = "codex.cmd";
let codexVersion = "unknown";
const initialEnvironment: EnvironmentState = { platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "other", nodeInstalled: false, codexInstalled: false, codexCompatible: false };
let publicState: PublicState = { relayUrl: "", status: "unconfigured", detail: "请先配置中继地址。", codexVersion, workspaces: [], environment: initialEnvironment, update: { status: "idle" } };
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let codex: CodexAdapter | null = null;
let syncKey: CryptoKey | null = null;
let quitting = false;
const pendingPrompts = new Map<string, string>();
const pendingRequestTypes = new Map<string, "command" | "file" | "permission" | "input">();
let activityOutputBuffer = "";
let activityFlushTimer: NodeJS.Timeout | null = null;
const activityItems = new Map<string, string>();

function startLocalActivity(threadId: string, prompt: string, title = "远程任务"): void {
  activityOutputBuffer = "";
  activityItems.clear();
  if (activityFlushTimer) clearTimeout(activityFlushTimer);
  activityFlushTimer = null;
  updateState({ activity: { threadId, title, prompt, status: "processing", output: "" } });
}

function appendLocalActivityStage(threadId: string, text: string): void {
  if (!text.trim()) return;
  appendLocalActivity(threadId, `${activityOutputBuffer || publicState.activity?.output ? "\n\n" : ""}${text.trim()}`);
}

function activityItemKey(params: Record<string, any>): string {
  return String(params.item?.id ?? params.itemId ?? "");
}

function activityItemLabel(item: Record<string, any>): string | null {
  if (item.type === "agentMessage") return "Codex 回复";
  if (item.type === "commandExecution") return `执行命令\n${String(item.command ?? "").trim()}`;
  if (item.type === "fileChange") {
    const paths = (item.changes ?? []).map((change: Record<string, any>) => change.path).filter(Boolean).join("\n");
    return `修改文件${paths ? `\n${paths}` : ""}`;
  }
  if (item.type === "mcpToolCall") return `调用工具\n${String(item.tool ?? item.name ?? "")}`;
  if (item.type === "webSearch") return `搜索资料\n${String(item.query ?? "")}`;
  return null;
}

function activityItemResult(item: Record<string, any>): string {
  if (item.type === "agentMessage") return "";
  if (item.type === "commandExecution") {
    const output = String(item.aggregatedOutput ?? item.output ?? "").trim();
    return output ? `命令输出\n${output}` : `命令${item.status ? ` ${item.status}` : "已完成"}`;
  }
  if (item.type === "fileChange") return `文件修改${item.status ? ` ${item.status}` : "已完成"}`;
  if (item.type === "mcpToolCall") return `工具调用${item.status ? ` ${item.status}` : "已完成"}`;
  if (item.type === "webSearch") return "搜索完成";
  return "";
}

function appendLocalActivity(threadId: string, delta: string): void {
  if (publicState.activity?.threadId !== threadId) return;
  activityOutputBuffer += delta;
  if (activityFlushTimer) return;
  activityFlushTimer = setTimeout(() => {
    activityFlushTimer = null;
    const activity = publicState.activity;
    if (!activity || activity.threadId !== threadId) return;
    const output = (activity.output + activityOutputBuffer).slice(-100_000);
    activityOutputBuffer = "";
    updateState({ activity: { ...activity, output } });
  }, 80);
}

function finishLocalActivity(threadId: string, status: string): void {
  const activity = publicState.activity;
  if (!activity || activity.threadId !== threadId) return;
  const output = (activity.output + activityOutputBuffer).slice(-100_000);
  activityOutputBuffer = "";
  if (activityFlushTimer) clearTimeout(activityFlushTimer);
  activityFlushTimer = null;
  const normalized = status.toLowerCase();
  const finalStatus: ActivityState["status"] = normalized.includes("interrupt") ? "interrupted" : normalized.includes("fail") ? "failed" : "completed";
  updateState({ activity: { ...activity, output, status: finalStatus } });
}

function encryptSecret(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("系统安全存储当前不可用");
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
  :root{font-family:"Bahnschrift","Aptos",sans-serif;color:#17211b;background:#f2eadb}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 90% 0,rgba(226,88,50,.18),transparent 31%),#f2eadb}.shell{padding:30px}.head{display:flex;align-items:center;gap:13px;margin-bottom:28px}.mark{width:48px;height:48px;display:grid;place-items:center;background:#e25832;color:white;font-weight:900;border-radius:15px 15px 4px 15px}.head h1{font:700 24px Rockwell,serif;margin:0}.head p{margin:3px 0 0;color:#6b726b;font-size:11px;letter-spacing:.1em}.card{background:#fffaf0;border:1px solid rgba(23,33,27,.15);border-radius:20px;padding:21px;margin-bottom:15px;box-shadow:0 14px 35px rgba(34,39,31,.07)}.status{display:flex;align-items:center;justify-content:space-between}.status b{text-transform:uppercase;font-size:11px;letter-spacing:.12em}.dot{width:10px;height:10px;border-radius:50%;background:#999}.dot.online,.check.ok:before{background:#3bab70;box-shadow:0 0 0 6px rgba(59,171,112,.13)}.detail{color:#6b726b;font-size:13px;line-height:1.5}.pair{font:900 47px/1 monospace;letter-spacing:.2em;text-align:center;padding-left:.2em;color:#e25832;margin:18px 0}.row{display:flex;gap:9px;flex-wrap:wrap}input{flex:1;border:1px solid rgba(23,33,27,.17);border-radius:10px;padding:12px;background:white}button{border:0;border-radius:10px;padding:11px 14px;background:#17211b;color:white;font-weight:800;cursor:pointer}button.secondary{background:#e7ddcd;color:#17211b}.checks{display:grid;gap:10px;margin:12px 0}.check{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#eee6d8;border-radius:10px}.check:before{content:"";width:9px;height:9px;border-radius:50%;background:#d35a3b}.check span{margin-left:auto;color:#687068;font:11px "Cascadia Code",monospace}.workspaces{display:grid;gap:8px}.workspace{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;background:#eee6d8;border-radius:10px}.workspace div{min-width:0}.workspace strong,.workspace small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace small{color:#747a73;margin-top:3px}.workspace button{padding:5px 8px;background:transparent;color:#a43b25}.meta{font:11px/1.6 "Cascadia Code",monospace;color:#687068}.empty{text-align:center;color:#777;padding:14px}h2{font:700 17px Rockwell,serif;margin:0 0 13px}</style></head><body><main class="shell"><div class="head"><div class="mark">AV</div><div><h1>AnytimeVibe Agent</h1><p>${process.platform === "darwin" ? "MACOS" : "WINDOWS"} REMOTE BRIDGE</p></div></div><section class="card"><div class="status"><b id="status">loading</b><span id="dot" class="dot"></span></div><p id="detail" class="detail">正在读取状态…</p><div class="meta" id="meta"></div></section><section class="card"><div class="status"><h2>本机环境</h2><button id="recheck" class="secondary">重新检测</button></div><div id="environment" class="checks"></div><div id="environmentActions" class="row"></div></section><section class="card"><h2>中继服务器</h2><div class="row"><input id="relay" placeholder="https://vibe.example.com"><button id="saveRelay">保存</button></div><div id="pairBox"></div></section><section class="card"><div class="status"><h2>允许的工作区</h2><button id="addWorkspace" class="secondary">添加目录</button></div><div id="workspaces" class="workspaces"></div></section></main><script>
  const api=window.anytimeVibe;const status=document.querySelector('#status');const dot=document.querySelector('#dot');const detail=document.querySelector('#detail');const relay=document.querySelector('#relay');const pairBox=document.querySelector('#pairBox');const workspaces=document.querySelector('#workspaces');const meta=document.querySelector('#meta');const environment=document.querySelector('#environment');const environmentActions=document.querySelector('#environmentActions');const updateBox=document.createElement('div');environmentActions.after(updateBox);const activityBox=document.createElement('section');activityBox.className='card';meta.closest('.card').after(activityBox);
  function render(state){status.textContent=state.status;dot.className='dot '+(state.status==='online'?'online':'');detail.textContent=state.detail;relay.value=state.relayUrl||'';meta.textContent='Codex '+state.codexVersion+(state.hostId?' · Host '+state.hostId:'');const env=state.environment;environment.innerHTML='<div class="check '+(env.nodeInstalled?'ok':'')+'"><b>Node.js</b><span>'+(env.nodeVersion||'未安装')+'</span></div><div class="check '+(env.codexCompatible?'ok':'')+'"><b>Codex CLI</b><span>'+(env.codexVersion||(env.codexInstalled?'版本不兼容':'未安装'))+'</span></div>';environmentActions.innerHTML=(!env.nodeInstalled?'<button data-install="node">安装 Node.js</button>':'')+(env.nodeInstalled&&!env.codexCompatible?'<button data-install="codex">一键安装兼容版 Codex</button>':'');environmentActions.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>api.installEnvironment(button.dataset.install)));pairBox.innerHTML=state.pairingCode?'<div class="pair">'+state.pairingCode+'</div><p class="detail">在移动端输入配对码。配对码约十分钟后失效。</p>':'<button id="startPair" '+(!env.codexCompatible?'disabled':'')+'>生成配对码</button>';document.querySelector('#startPair')?.addEventListener('click',()=>api.startPairing());workspaces.innerHTML=state.workspaces.length?state.workspaces.map(w=>'<div class="workspace"><div><strong>'+escapeHtml(w.name)+'</strong><small>'+escapeHtml(w.path)+'</small></div><button data-id="'+w.id+'">移除</button></div>').join(''):'<div class="empty">尚未允许任何目录</div>';workspaces.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>api.removeWorkspace(button.dataset.id)));}
  function escapeHtml(value){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));}
  function renderUpdate(update){const labels={idle:'自动更新',checking:'正在检查更新',available:'发现新版本',downloading:'后台下载更新',ready:'更新已就绪',error:'更新检查失败'};updateBox.innerHTML='<div class="check '+(update.status==='ready'?'ok':'')+'"><b>'+labels[update.status]+'</b><span>'+(update.version||update.message||(update.progress!==undefined?update.progress+'%':''))+'</span></div><div class="row"><button id="checkUpdate" class="secondary">检查更新</button>'+(update.status==='ready'?'<button id="installUpdate">重启并更新</button>':'')+'</div>';document.querySelector('#checkUpdate')?.addEventListener('click',()=>api.checkUpdate());document.querySelector('#installUpdate')?.addEventListener('click',()=>api.installUpdate());}
  function renderActivity(activity){if(!activity){activityBox.style.display='none';return}activityBox.style.display='block';const labels={processing:'处理中',completed:'已完成',failed:'失败',interrupted:'已停止'};activityBox.innerHTML='<div class="status"><h2>当前远程任务</h2><b>'+labels[activity.status]+'</b></div><p class="detail"><strong>'+escapeHtml(activity.title)+'</strong><br>'+escapeHtml(activity.prompt)+'</p><pre style="max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#17211b;color:#e8eee8;border-radius:12px;padding:14px;font:12px/1.55 Cascadia Code,monospace">'+escapeHtml(activity.output||'等待 Codex 输出…')+'</pre>';const output=activityBox.querySelector('pre');output.scrollTop=output.scrollHeight;}
  document.querySelector('#saveRelay').addEventListener('click',()=>api.setRelayUrl(relay.value));document.querySelector('#addWorkspace').addEventListener('click',()=>api.addWorkspace());document.querySelector('#recheck').addEventListener('click',()=>api.checkEnvironment());api.onState(state=>{render(state);renderUpdate(state.update);renderActivity(state.activity)});api.getState().then(state=>{render(state);renderUpdate(state.update);renderActivity(state.activity)});
  </script></body></html>`;
}

async function loadConfig(): Promise<void> {
  configPath = path.join(app.getPath("userData"), "agent-config.json");
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as AgentConfig;
  } catch {
    config = { relayUrl: process.env.ANYTIMEVIBE_RELAY_URL ?? "", agentId: crypto.randomUUID(), workspaces: [], sequence: 0 };
  }
  if (!config.agentId) {
    config.agentId = crypto.randomUUID();
    await saveConfig();
  }
  config.workspaces ??= [];
  config.sequence ??= 0;
  publicState = { ...publicState, relayUrl: config.relayUrl, workspaces: config.workspaces };
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const result = process.platform === "win32"
      ? await execFileAsync(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(command, args), { windowsHide: true, windowsVerbatimArguments: true })
      : await execFileAsync(command, args);
    return String(result.stdout).trim();
  } catch {
    return null;
  }
}

async function findOnPath(command: string): Promise<string | null> {
  if (process.platform === "win32") {
    try {
      const result = await execFileAsync("where.exe", [command]);
      return result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null;
    } catch { return null; }
  }
  try {
    const result = await execFileAsync("/bin/zsh", ["-lc", `command -v ${command}`]);
    return result.stdout.trim() || null;
  } catch { return null; }
}

async function detectEnvironment(): Promise<EnvironmentState> {
  const nodeCommand = await findOnPath(process.platform === "win32" ? "node.exe" : "node");
  const nodeOutput = nodeCommand ? await commandVersion(nodeCommand, ["--version"]) : null;
  const configuredCodex = process.env.CODEX_COMMAND ? normalizeWindowsCommandPath(process.env.CODEX_COMMAND) : null;
  const discoveredCodex = configuredCodex ?? await findOnPath(process.platform === "win32" ? "codex.cmd" : "codex");
  if (discoveredCodex) codexCommand = normalizeWindowsCommandPath(discoveredCodex);
  const codexOutput = discoveredCodex ? await commandVersion(codexCommand, ["--version"]) : null;
  const detectedVersion = codexOutput?.replace(/^codex-cli\s+/, "");
  if (detectedVersion) codexVersion = detectedVersion;
  return {
    platform: initialEnvironment.platform,
    nodeInstalled: Boolean(nodeOutput),
    ...(nodeOutput ? { nodeVersion: nodeOutput } : {}),
    codexInstalled: Boolean(detectedVersion),
    ...(detectedVersion ? { codexVersion: detectedVersion } : {}),
    codexCompatible: Boolean(detectedVersion && /^0\.144\./.test(detectedVersion))
  };
}

async function findCodex(): Promise<void> {
  const environment = await detectEnvironment();
  updateState({ environment });
  if (!environment.nodeInstalled) throw new Error("未检测到 Node.js，请先完成环境安装。");
  if (!environment.codexInstalled) throw new Error("未检测到 Codex CLI，请点击环境检测区域的一键安装。");
  if (!environment.codexCompatible) {
    updateState({ status: "incompatible", detail: `当前仅支持 codex-cli 0.144.x，检测到 ${environment.codexVersion}。`, environment });
    throw new Error("Unsupported Codex version");
  }
}

async function installEnvironment(target: "node" | "codex"): Promise<void> {
  if (target === "node") {
    await shell.openExternal("https://nodejs.org/en/download");
    return;
  }
  if (process.platform === "win32") {
    const installCommand = "npm install -g @openai/codex@0.144; if ($LASTEXITCODE -eq 0) { codex login }";
    spawn("powershell.exe", ["-NoExit", "-Command", installCommand], { detached: true, windowsHide: false, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "darwin") {
    const installCommand = "npm install -g @openai/codex@0.144 && codex login";
    await execFileAsync("osascript", ["-e", `tell application \"Terminal\" to do script \"${installCommand}\"`]);
    await execFileAsync("osascript", ["-e", "tell application \"Terminal\" to activate"]);
    return;
  }
  throw new Error("当前系统暂不支持一键打开安装终端。");
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
      agentId: config.agentId,
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
    updateState({ status: "waiting_pairing", detail: "配对码已过期，请重新生成配对码。", pairingCode: undefined, pairingExpiresAt: undefined });
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
  const syncKeyValue = config.encryptedSyncKey
    ? decryptSecret(config.encryptedSyncKey)
    : bytesToBase64(randomKeyBytes());
  const wrappedSyncKey = await encryptPayload(pairingKey, { syncKey: syncKeyValue }, pairing.id);
  const authorization = await fetch(`${config.relayUrl}/api/agent/pairings/${pairing.id}/authorize?secret=${encodeURIComponent(pairing.secret)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wrappedSyncKey })
  });
  if (!authorization.ok) throw new Error(`浏览器密钥授权失败：HTTP ${authorization.status}`);
  config.hostId = String(result.hostId);
  config.encryptedAgentToken = encryptSecret(String(result.agentToken));
  config.encryptedSyncKey = encryptSecret(syncKeyValue);
  delete config.pairing;
  await saveConfig();
  syncKey = await importAesKey(base64ToBytes(syncKeyValue));
  updateState({ status: "connecting", detail: "新浏览器已获得主机密钥授权，正在建立连接。", hostId: config.hostId, pairingCode: undefined, pairingExpiresAt: undefined });
  await connect();
}

function wsUrl(relayUrl: string): string {
  return relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

async function connect(force = false): Promise<void> {
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    if (config.pairing) schedulePairingPoll();
    else updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
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
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
    return;
  }
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
  let localThreadId = "threadId" in command ? command.threadId : undefined;
  try {
    await ensureCodex();
    if (command.type === "task.create") {
      if (!isAllowedWorkspace(command.cwd)) throw new Error("工作目录不在代理白名单中");
      const started = await codex!.request("thread/start", threadStartParams(command.cwd));
      const thread = started.thread;
      localThreadId = thread.id;
      if (command.title) await codex!.request("thread/name/set", { threadId: thread.id, name: command.title });
      await publishThread(thread.id);
      startLocalActivity(thread.id, command.prompt, command.title || command.prompt.slice(0, 80));
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
      await codex!.request("thread/resume", { threadId: command.threadId });
      startLocalActivity(command.threadId, command.prompt, "继续远程任务");
      const result = await codex!.request("turn/start", {
        threadId: command.threadId,
        clientUserMessageId: command.commandId,
        input: [{ type: "text", text: command.prompt, text_elements: [] }]
      });
      await publish({ type: "turn.started", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: result.turn.id, prompt: command.prompt }, true);
      return;
    }
    if (command.type === "turn.steer") {
      await codex!.request("thread/resume", { threadId: command.threadId });
      if (publicState.activity?.threadId !== command.threadId) startLocalActivity(command.threadId, command.prompt, "追加远程指令");
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
    if (localThreadId) finishLocalActivity(localThreadId, "failed");
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
  if (message.method === "item/started") {
    const params = message.params ?? {};
    const item = params.item ?? {};
    const label = activityItemLabel(item);
    const key = activityItemKey(params);
    if (label && key && !activityItems.has(key)) {
      activityItems.set(key, item.type);
      appendLocalActivityStage(String(params.threadId), `▶ ${label}`);
    }
  }
  if (message.method === "item/completed") {
    const params = message.params ?? {};
    const item = params.item ?? {};
    const key = activityItemKey(params);
    if (key && activityItems.has(key)) {
      activityItems.delete(key);
      const result = activityItemResult(item);
      if (result) appendLocalActivityStage(String(params.threadId), `✓ ${result}`);
    }
  }
  if (message.method === "item/agentMessage/delta") {
    appendLocalActivity(String(message.params.threadId), String(message.params.delta ?? ""));
  }
  if (message.method === "turn/completed") {
    const params = message.params;
    finishLocalActivity(String(params.threadId), String(params.turn.status));
    await publish({ type: "turn.completed", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: params.threadId, turnId: params.turn.id, status: String(params.turn.status) }, true, "completed");
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
  const connected = socket?.readyState === WebSocket.OPEN;
  updateState({
    status: publicState.status === "incompatible" ? "incompatible" : connected ? "online" : "offline",
    detail: connected ? `代理在线，但有一项操作失败：${detail}` : detail
  });
}

let updateListenersRegistered = false;

function registerUpdateListeners(): void {
  if (updateListenersRegistered) return;
  updateListenersRegistered = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("checking-for-update", () => updateState({ update: { status: "checking" } }));
  autoUpdater.on("update-available", (info) => updateState({ update: { status: "available", version: info.version } }));
  autoUpdater.on("update-not-available", () => updateState({ update: { status: "idle", message: "当前已是最新版本" } }));
  autoUpdater.on("download-progress", (progress) => updateState({ update: { status: "downloading", progress: Math.round(progress.percent) } }));
  autoUpdater.on("update-downloaded", (info) => {
    updateState({ update: { status: "ready", version: info.version, message: "更新已在后台下载完成" } });
    showWindow();
  });
  autoUpdater.on("error", (error) => updateState({ update: { status: "error", message: error.message } }));
}

async function checkForAgentUpdate(): Promise<void> {
  if (!app.isPackaged) {
    updateState({ update: { status: "idle", message: "开发模式不检查更新" } });
    return;
  }
  if (!config.relayUrl) return;
  registerUpdateListeners();
  const response = await fetch(`${config.relayUrl}/api/agent/config`);
  if (!response.ok) throw new Error(`无法读取更新配置：HTTP ${response.status}`);
  const remoteConfig = await response.json() as { updateFeedUrl: string | null };
  if (!remoteConfig.updateFeedUrl) {
    updateState({ update: { status: "idle", message: "服务端未配置更新源" } });
    return;
  }
  autoUpdater.setFeedURL({ provider: "generic", url: remoteConfig.updateFeedUrl });
  await autoUpdater.checkForUpdates();
}

function registerIpc(): void {
  ipcMain.handle("agent:get-state", () => publicState);
  ipcMain.handle("agent:set-relay-url", async (_event, relayUrl: string) => {
    const normalized = relayUrl.trim().replace(/\/$/, "");
    if (!/^https?:\/\//.test(normalized)) throw new Error("中继地址必须以 http:// 或 https:// 开头");
    config.relayUrl = normalized;
    await saveConfig();
    const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
    updateState({ relayUrl: normalized, status: paired ? "offline" : "waiting_pairing", detail: paired ? "中继地址已更新，请重新连接。" : "中继地址已保存，正在等待配对连接。" });
    void checkForAgentUpdate().catch((error) => updateState({ update: { status: "error", message: error.message } }));
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
  ipcMain.handle("agent:check-environment", async () => {
    const environment = await detectEnvironment();
    const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
    updateState({
      environment,
      status: environment.codexCompatible ? (paired ? "offline" : config.relayUrl ? "waiting_pairing" : "unconfigured") : "incompatible",
      detail: environment.codexCompatible ? (paired ? "Codex 环境检测通过。" : "Codex 环境已就绪，正在等待配对连接。") : "环境尚未就绪，请按提示完成安装。"
    });
    return publicState;
  });
  ipcMain.handle("agent:install-environment", async (_event, target: "node" | "codex") => {
    if (target !== "node" && target !== "codex") throw new Error("未知的安装目标");
    await installEnvironment(target);
    return publicState;
  });
  ipcMain.handle("agent:check-update", async () => { await checkForAgentUpdate(); return publicState; });
  ipcMain.handle("agent:install-update", () => autoUpdater.quitAndInstall(false, true));
}

app.whenReady().then(async () => {
  await loadConfig();
  registerIpc();
  app.setLoginItemSettings({ openAtLogin: true });
  const trayImage = nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#17211b"/><path d="M13 20h38v25H13z" fill="#f2eadb"/><path d="m19 27 7 5-7 6" fill="none" stroke="#e25832" stroke-width="5"/><path d="M31 39h14" stroke="#2d7653" stroke-width="5"/></svg>').toString("base64"));
  const trayIcon = trayImage.resize({ width: 18, height: 18 });
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.on("double-click", showWindow);
  createWindow();
  void checkForAgentUpdate().catch((error) => updateState({ update: { status: "error", message: error.message } }));
  setInterval(() => void checkForAgentUpdate().catch(() => undefined), 6 * 60 * 60 * 1000).unref();
  try {
    await findCodex();
    const paired = Boolean(config.hostId && config.encryptedAgentToken && config.encryptedSyncKey);
    updateState({
      codexVersion,
      status: !config.relayUrl ? "unconfigured" : config.pairing ? "pairing" : paired ? "offline" : "waiting_pairing",
      detail: !config.relayUrl ? "请先配置中继地址。" : config.pairing ? "等待 Web 端确认配对。" : paired ? "Codex 已就绪，正在连接中继。" : "Codex 已就绪，等待配对连接。"
    });
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
