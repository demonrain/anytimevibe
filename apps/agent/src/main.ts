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
import { promises as fs, readFileSync } from "node:fs";
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
import { CodexAdapter, codexPermissionParams, threadStartParams, threadToSnapshot } from "./codex-adapter";
import { normalizeWindowsCommandPath, windowsCmdArguments } from "./windows-command";

const execFileAsync = promisify(execFile);
const DEFAULT_RELAY_URL = "https://vibe.demonrain.top";

type StoredPairing = {
  id: string;
  code: string;
  secret: string;
  expiresAt: number;
};

type AgentConfig = {
  relayUrl: string;
  agentId: string;
  displayName: string;
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
  displayName: string;
  status: "unconfigured" | "waiting_pairing" | "pairing" | "connecting" | "online" | "offline" | "incompatible";
  detail: string;
  pairingCode?: string | undefined;
  pairingExpiresAt?: number | undefined;
  hostId?: string | undefined;
  codexVersion: string;
  workspaces: Workspace[];
  environment: EnvironmentState;
  update: UpdateState;
  tasks: AgentTask[];
  activity?: ActivityState;
};

type AgentTask = {
  threadId: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
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
let publicState: PublicState = { relayUrl: DEFAULT_RELAY_URL, displayName: "", status: "unconfigured", detail: "请先配置中继地址。", codexVersion, workspaces: [], environment: initialEnvironment, update: { status: "idle" }, tasks: [] };

function productIconPath(): string {
  const candidates = [
    path.join(__dirname, "..", "assets", "icon.ico"),
    path.join(__dirname, "..", "assets", "icon.png"),
    path.join(process.resourcesPath, "assets", "icon.ico"),
    path.join(process.resourcesPath, "assets", "icon.png")
  ];
  for (const candidate of candidates) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return path.join(__dirname, "..", "assets", "icon.png");
}

function loadProductIcon() {
  const fromFile = nativeImage.createFromPath(productIconPath());
  if (!fromFile.isEmpty()) return fromFile;
  return nativeImage.createFromDataURL(
    "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="15" fill="#17211b"/><path d="M13 20h38v25H13z" fill="#f2eadb"/><path d="m19 27 7 5-7 6" fill="none" stroke="#e25832" stroke-width="5"/><path d="M31 39h14" stroke="#2d7653" stroke-width="5"/><circle cx="46" cy="24" r="3" fill="#3bab70"/></svg>'
      ).toString("base64")
  );
}

function resolvedDisplayName(): string {
  const name = config?.displayName?.trim();
  return name || os.hostname();
}
let socket: WebSocket | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let codex: CodexAdapter | null = null;
let syncKey: CryptoKey | null = null;
let quitting = false;
/** True while quitAndInstall is in progress — suppress all UI/side-effect callbacks. */
let installingUpdate = false;
/** Bumped on every intentional connect(); stale socket handlers ignore events. */
let connectGeneration = 0;
let reconnectAttempt = 0;
/** Permanent auth failures must not flap reconnect forever. */
let reconnectBlockedReason: string | null = null;
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

function isWindowAlive(): boolean {
  return Boolean(windowRef && !windowRef.isDestroyed() && !windowRef.webContents.isDestroyed());
}

function updateState(patch: Partial<PublicState>): void {
  publicState = {
    ...publicState,
    ...patch,
    relayUrl: config?.relayUrl ?? publicState.relayUrl,
    displayName: config ? resolvedDisplayName() : publicState.displayName,
    codexVersion,
    workspaces: config?.workspaces ?? publicState.workspaces
  };
  // During quit/update the BrowserWindow/Tray may already be destroyed; never touch them.
  if (quitting || installingUpdate) return;
  try {
    if (isWindowAlive()) {
      windowRef!.webContents.send("agent:state", publicState);
    }
  } catch {
    // Window can race-destroy between isDestroyed checks and send.
  }
  try {
    rebuildTray();
  } catch {
    // Tray may already be destroyed during shutdown.
  }
}

function rebuildTray(): void {
  if (!tray || quitting || installingUpdate) return;
  if (typeof (tray as Tray & { isDestroyed?: () => boolean }).isDestroyed === "function"
    && (tray as Tray & { isDestroyed: () => boolean }).isDestroyed()) {
    return;
  }
  tray.setToolTip(`${resolvedDisplayName()} · ${publicState.status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `状态：${publicState.status}`, enabled: false },
    { label: `名称：${resolvedDisplayName()}`, enabled: false },
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
  const icon = loadProductIcon();
  windowRef = new BrowserWindow({
    width: 460,
    height: 640,
    minWidth: 400,
    minHeight: 480,
    resizable: true,
    maximizable: false,
    backgroundColor: "#f2eadb",
    title: "随码",
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.platform === "win32") windowRef.setIcon(icon);
  windowRef.setMenuBarVisibility(false);
  windowRef.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(rendererHtml())}`);
  windowRef.on("close", (event) => {
    // When quitting for update/install, allow the window to close so quitAndInstall can proceed.
    if (!quitting) {
      event.preventDefault();
      windowRef?.hide();
    }
  });
}

function rendererHtml(): string {
  const platformLabel = process.platform === "darwin" ? "MACOS" : "WINDOWS";
  const iconDataUrl = (() => {
    try {
      return `data:image/png;base64,${readFileSync(productIconPath()).toString("base64")}`;
    } catch {
      return "";
    }
  })();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>随码</title><style>
  :root{font-family:"Bahnschrift","Aptos","Segoe UI",sans-serif;color:#17211b;background:#f2eadb}
  *{box-sizing:border-box}html,body{margin:0;min-height:100%}
  body{overflow-x:hidden;overflow-y:auto;background:radial-gradient(circle at 92% 0,rgba(226,88,50,.16),transparent 34%),#f2eadb}
  .shell{padding:14px 14px 16px;display:flex;flex-direction:column;gap:8px}
  .head{display:flex;align-items:center;gap:10px}
  .mark{width:34px;height:34px;border-radius:10px;overflow:hidden;background:#17211b;flex:0 0 auto;box-shadow:0 6px 14px rgba(23,33,27,.16)}
  .mark img{width:100%;height:100%;display:block;object-fit:cover}
  .head h1{font:700 16px Rockwell,serif;margin:0;line-height:1.1}
  .head p{margin:2px 0 0;color:#6b726b;font-size:9px;letter-spacing:.12em}
  .card{background:#fffaf0;border:1px solid rgba(23,33,27,.12);border-radius:12px;padding:10px 11px;box-shadow:0 8px 18px rgba(34,39,31,.05)}
  .card.grow{display:flex;flex-direction:column}
  .status{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
  .status b{text-transform:uppercase;font-size:10px;letter-spacing:.1em}
  .dot{width:8px;height:8px;border-radius:50%;background:#999;flex:0 0 auto}
  .dot.online{background:#3bab70;box-shadow:0 0 0 4px rgba(59,171,112,.14)}
  .detail{color:#6b726b;font-size:11px;line-height:1.4;margin:6px 0 0}
  .meta{font:10px/1.4 "Cascadia Code",monospace;color:#687068;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  h2{font:700 12px Rockwell,serif;margin:0}
  .row{display:flex;gap:6px;align-items:center;min-width:0}
  .row.wrap{flex-wrap:wrap}
  input{flex:1 1 auto;min-width:0;border:1px solid rgba(23,33,27,.15);border-radius:8px;padding:7px 9px;background:white;font-size:12px}
  button{border:0;border-radius:8px;padding:7px 10px;background:#17211b;color:white;font-weight:800;font-size:11px;cursor:pointer;white-space:nowrap;flex:0 0 auto}
  button:disabled{opacity:.4;cursor:not-allowed}
  button.secondary{background:#e7ddcd;color:#17211b}
  button.ghost{background:transparent;color:#a43b25;padding:4px 6px}
  .checks{display:grid;gap:5px;margin-top:7px}
  .check{display:flex;align-items:center;gap:7px;padding:6px 8px;background:#eee6d8;border-radius:8px;font-size:11px;min-width:0}
  .check:before{content:"";width:7px;height:7px;border-radius:50%;background:#d35a3b;flex:0 0 auto}
  .check.ok:before{background:#3bab70}
  .check b{font-weight:800;flex:0 0 auto}
  .check span{margin-left:auto;color:#687068;font:10px "Cascadia Code",monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;max-width:48%}
  .check button{flex:0 0 auto;padding:5px 8px;font-size:10px}
  .update-row{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0}
  .update-row .check{flex:1 1 auto;margin:0}
  .pair{font:900 28px/1 monospace;letter-spacing:.18em;text-align:center;color:#e25832;margin:8px 0 4px;padding-left:.18em}
  .workspaces{display:grid;gap:5px;margin-top:7px}
  .workspace{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;background:#eee6d8;border-radius:8px;min-width:0}
  .workspace div{flex:1 1 auto;min-width:0;overflow:hidden}
  .workspace strong,.workspace small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .workspace small{color:#747a73;margin-top:1px;font-size:10px}
  .empty{text-align:center;color:#888;padding:8px;font-size:11px}
  .stack{display:grid;gap:6px;margin-top:6px}
  .label{font-size:10px;font-weight:800;color:#6b726b;letter-spacing:.04em}
  pre.activity{margin:6px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#17211b;color:#e8eee8;border-radius:8px;padding:8px;font:10px/1.45 Cascadia Code,monospace}
  </style></head><body><main class="shell">
  <div class="head">${iconDataUrl ? `<div class="mark"><img src="${iconDataUrl}" alt=""></div>` : `<div class="mark"></div>`}<div><h1>随码</h1><p>随时续上你的代码 · ${platformLabel}</p></div></div>
  <section class="card"><div class="status"><b id="status">loading</b><span id="dot" class="dot"></span></div><p id="detail" class="detail">正在读取状态…</p><div class="meta" id="meta"></div></section>
  <section class="card"><div class="status"><h2>本机环境</h2><button id="recheck" class="secondary">重新检测</button></div><div id="environment" class="checks"></div><div id="updateBox" class="update-row"></div></section>
  <section class="card"><h2>中继与配对</h2><div class="stack"><div class="label">中继服务器</div><div class="row"><input id="relay" placeholder="https://vibe.demonrain.top"><button id="startPair" class="secondary">生成配对码</button><button id="saveRelay">保存</button></div><div id="pairBox"></div><div class="label">客户端名称</div><div class="row"><input id="displayName" placeholder="例如：公司电脑" maxlength="64"><button id="saveName" class="secondary">保存名称</button></div></div></section>
  <section class="card grow"><div class="status"><h2>允许的工作区</h2><button id="addWorkspace" class="secondary">添加目录</button></div><div id="workspaces" class="workspaces"></div></section>
  <section class="card" id="activityBox" style="display:none"></section>
  <section class="card" id="taskBox"></section>
  </main><script>
  const api=window.anytimeVibe;
  const status=document.querySelector('#status');
  const dot=document.querySelector('#dot');
  const detail=document.querySelector('#detail');
  const relay=document.querySelector('#relay');
  const displayName=document.querySelector('#displayName');
  const pairBox=document.querySelector('#pairBox');
  const startPair=document.querySelector('#startPair');
  const workspaces=document.querySelector('#workspaces');
  const meta=document.querySelector('#meta');
  const environment=document.querySelector('#environment');
  const updateBox=document.querySelector('#updateBox');
  const activityBox=document.querySelector('#activityBox');
  const taskBox=document.querySelector('#taskBox');
  let tasksOpen=false;
  let lastTasks=[];
  function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));}
  function render(state){
    status.textContent=state.status;
    dot.className='dot '+(state.status==='online'?'online':'');
    detail.textContent=state.detail;
    if(document.activeElement!==relay) relay.value=state.relayUrl||'';
    if(document.activeElement!==displayName) displayName.value=state.displayName||'';
    meta.textContent='Codex '+state.codexVersion+(state.hostId?' · '+String(state.hostId).slice(0,8):'');
    const env=state.environment;
    const nodeAction=!env.nodeInstalled?'<button data-install="node" class="secondary">安装 Node.js</button>':'';
    const codexAction=env.nodeInstalled&&!env.codexCompatible?'<button data-install="codex" class="secondary">安装兼容版 Codex</button>':'';
    environment.innerHTML='<div class="check '+(env.nodeInstalled?'ok':'')+'"><b>Node.js</b><span>'+escapeHtml(env.nodeVersion||'未安装')+'</span>'+nodeAction+'</div><div class="check '+(env.codexCompatible?'ok':'')+'"><b>Codex CLI</b><span>'+escapeHtml(env.codexVersion||(env.codexInstalled?'版本不兼容':'未安装'))+'</span>'+codexAction+'</div>';
    environment.querySelectorAll('button[data-install]').forEach(button=>button.addEventListener('click',()=>{
      const target=button.dataset.install;
      button.disabled=true;
      api.installEnvironment(target).catch((error)=>alert(error&&error.message?error.message:String(error))).finally(()=>{try{button.disabled=false}catch{}});
    }));
    startPair.disabled=!env.codexCompatible||!state.relayUrl;
    pairBox.innerHTML=state.pairingCode?'<div class="pair">'+escapeHtml(state.pairingCode)+'</div><p class="detail">在 Web 端输入配对码，约 10 分钟后失效。</p>':'';
    workspaces.innerHTML=state.workspaces.length?state.workspaces.map(w=>'<div class="workspace"><div><strong>'+escapeHtml(w.name)+'</strong><small>'+escapeHtml(w.path)+'</small></div><button class="ghost" data-id="'+escapeHtml(w.id)+'">移除</button></div>').join(''):'<div class="empty">尚未允许任何目录</div>';
    workspaces.querySelectorAll('button[data-id]').forEach(button=>button.addEventListener('click',()=>api.removeWorkspace(button.dataset.id)));
  }
  function renderUpdate(update){
    const labels={idle:'自动更新',checking:'检查中',available:'发现新版本',downloading:'下载中',ready:'更新就绪',error:'更新失败'};
    const text=update.version||update.message||(update.progress!==undefined?update.progress+'%':'后台自动检查');
    updateBox.innerHTML='<div class="check '+(update.status==='ready'?'ok':'')+'"><b>'+labels[update.status]+'</b><span>'+escapeHtml(text)+'</span></div><button id="checkUpdate" class="secondary">检查更新</button>'+(update.status==='ready'?'<button id="installUpdate">重启并更新</button>':'');
    document.querySelector('#checkUpdate')?.addEventListener('click',()=>api.checkUpdate());
    document.querySelector('#installUpdate')?.addEventListener('click',()=>api.installUpdate());
  }
  function renderActivity(activity){
    if(!activity){activityBox.style.display='none';activityBox.innerHTML='';return}
    activityBox.style.display='block';
    const labels={processing:'处理中',completed:'已完成',failed:'失败',interrupted:'已停止'};
    activityBox.innerHTML='<div class="status"><h2>当前远程任务</h2><b>'+labels[activity.status]+'</b></div><p class="detail"><strong>'+escapeHtml(activity.title)+'</strong> · '+escapeHtml(activity.prompt)+'</p><pre class="activity">'+escapeHtml(activity.output||'等待 Codex 输出…')+'</pre>';
    const output=activityBox.querySelector('pre');
    output.scrollTop=output.scrollHeight;
  }
  function renderTasks(tasks){
    lastTasks=tasks||[];
    taskBox.innerHTML='<div class="status"><h2>任务接力</h2><button id="toggleTasks" class="secondary">'+(tasksOpen?'收起':'展开')+' · '+lastTasks.length+'</button></div>'+(tasksOpen?(lastTasks.length?'<div class="workspaces" style="margin-top:7px">'+lastTasks.map(task=>'<div class="workspace"><div><strong>'+escapeHtml(task.title)+'</strong><small>'+escapeHtml(task.cwd)+' · '+escapeHtml(task.status)+'</small></div><button data-relay="'+escapeHtml(task.threadId)+'">接力</button></div>').join('')+'</div>':'<div class="empty">暂无可接力任务</div>'):'');
    document.querySelector('#toggleTasks')?.addEventListener('click',()=>{tasksOpen=!tasksOpen;renderTasks(lastTasks)});
    taskBox.querySelectorAll('[data-relay]').forEach(button=>button.addEventListener('click',()=>api.relayTask(button.dataset.relay)));
  }
  document.querySelector('#saveRelay').addEventListener('click',()=>api.setRelayUrl(relay.value));
  document.querySelector('#saveName').addEventListener('click',()=>api.setDisplayName(displayName.value));
  startPair.addEventListener('click',()=>api.startPairing());
  document.querySelector('#addWorkspace').addEventListener('click',()=>api.addWorkspace());
  document.querySelector('#recheck').addEventListener('click',()=>api.checkEnvironment());
  api.onState(state=>{render(state);renderUpdate(state.update);renderActivity(state.activity);renderTasks(state.tasks||[])});
  api.getState().then(state=>{render(state);renderUpdate(state.update);renderActivity(state.activity);renderTasks(state.tasks||[])});
  </script></body></html>`;
}


async function loadConfig(): Promise<void> {
  configPath = path.join(app.getPath("userData"), "agent-config.json");
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8")) as AgentConfig;
  } catch {
    config = {
      relayUrl: process.env.ANYTIMEVIBE_RELAY_URL ?? DEFAULT_RELAY_URL,
      agentId: crypto.randomUUID(),
      displayName: os.hostname(),
      workspaces: [],
      sequence: 0
    };
  }
  let dirty = false;
  if (!config.agentId) {
    config.agentId = crypto.randomUUID();
    dirty = true;
  }
  if (!config.relayUrl) {
    config.relayUrl = process.env.ANYTIMEVIBE_RELAY_URL ?? DEFAULT_RELAY_URL;
    dirty = true;
  }
  if (!config.displayName?.trim()) {
    config.displayName = os.hostname();
    dirty = true;
  }
  config.workspaces ??= [];
  config.sequence ??= 0;
  if (dirty) await saveConfig();
  publicState = {
    ...publicState,
    relayUrl: config.relayUrl,
    displayName: resolvedDisplayName(),
    workspaces: config.workspaces
  };
}

// ---------------------------------------------------------------------------
// Toolchain discovery / install — platform implementations are deliberately
// separate so Windows fixes never change macOS behavior (and vice versa).
// ---------------------------------------------------------------------------

let cachedMacLoginPath: string | null = null;
let cachedWindowsPath: string | null = null;

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ---- macOS PATH (login shell + Homebrew/nvm) ----

/** GUI apps on macOS often miss Homebrew/nvm PATH; rebuild from login shell + common locations. */
async function resolveMacLoginPath(): Promise<string> {
  if (cachedMacLoginPath) return cachedMacLoginPath;
  const parts = new Set((process.env.PATH ?? "").split(":").filter(Boolean));
  const home = os.homedir();
  for (const dir of [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(home, ".local", "bin"),
    path.join(home, ".nvm", "current", "bin"),
    path.join(home, ".fnm", "current", "bin"),
    path.join(home, ".volta", "bin"),
    path.join(home, ".asdf", "shims"),
    path.join(home, "Library", "Application Support", "fnm", "aliases", "default")
  ]) {
    parts.add(dir);
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const result = await execFileAsync(shell, ["-ilc", "printf %s \"$PATH\""], {
        env: process.env,
        timeout: 8_000,
        maxBuffer: 1024 * 1024
      });
      for (const segment of String(result.stdout).trim().split(":")) {
        if (segment) parts.add(segment);
      }
      break;
    } catch {
      // try next shell
    }
  }
  cachedMacLoginPath = [...parts].join(":");
  return cachedMacLoginPath;
}

async function applyMacLoginPathToProcess(): Promise<void> {
  if (process.platform !== "darwin") return;
  cachedMacLoginPath = null;
  process.env.PATH = await resolveMacLoginPath();
}

async function findOnMacPath(command: string): Promise<string | null> {
  const loginPath = await resolveMacLoginPath();
  const candidates: string[] = [];
  for (const dir of loginPath.split(":")) {
    if (dir) candidates.push(path.join(dir, command));
  }
  candidates.unshift(
    path.join("/opt/homebrew/bin", command),
    path.join("/usr/local/bin", command),
    path.join("/usr/bin", command)
  );
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await pathExists(candidate)) return candidate;
  }
  for (const shell of ["/bin/zsh", "/bin/bash"]) {
    try {
      const result = await execFileAsync(shell, ["-ilc", `command -v ${command}`], {
        env: { ...process.env, PATH: loginPath },
        timeout: 8_000
      });
      const found = String(result.stdout).trim().split(/\r?\n/).find(Boolean);
      if (found && !found.includes("not found") && await pathExists(found)) return found;
    } catch {
      // try next shell
    }
  }
  return null;
}

async function macCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const loginPath = await resolveMacLoginPath();
    const result = await execFileAsync(command, args, {
      env: { ...process.env, PATH: loginPath },
      timeout: 8_000
    });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---- Windows PATH (registry + common Node/npm dirs) ----

function expandWindowsEnvVars(value: string): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? process.env[name.toUpperCase()] ?? "");
}

async function readWindowsRegistryPath(rootKey: string): Promise<string[]> {
  try {
    const result = await execFileAsync("reg.exe", ["query", rootKey, "/v", "Path"], {
      windowsHide: true,
      timeout: 5_000
    });
    const line = String(result.stdout)
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => /^Path\s+REG_/i.test(item));
    if (!line) return [];
    const value = line.replace(/^Path\s+REG_\w+\s+/i, "").trim();
    return expandWindowsEnvVars(value).split(";").map((part) => part.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** GUI apps on Windows often inherit a stripped PATH; rebuild from registry + Node install dirs. */
async function resolveWindowsPath(): Promise<string> {
  if (cachedWindowsPath) return cachedWindowsPath;
  const parts = new Set((process.env.PATH ?? "").split(";").filter(Boolean));
  const home = os.homedir();
  for (const dir of await readWindowsRegistryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")) parts.add(dir);
  for (const dir of await readWindowsRegistryPath("HKCU\\Environment")) parts.add(dir);
  for (const dir of [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs"),
    path.join(process.env.APPDATA || "", "npm"),
    path.join(home, "AppData", "Roaming", "npm"),
    path.join(home, "AppData", "Local", "fnm"),
    path.join(home, ".fnm"),
    path.join(home, "scoop", "shims"),
    path.join(home, "AppData", "Local", "Programs", "fnm")
  ]) {
    if (dir) parts.add(dir);
  }
  cachedWindowsPath = [...parts].join(";");
  return cachedWindowsPath;
}

async function applyWindowsPathToProcess(): Promise<void> {
  if (process.platform !== "win32") return;
  cachedWindowsPath = null;
  process.env.PATH = await resolveWindowsPath();
}

async function findOnWindowsPath(command: string): Promise<string | null> {
  const winPath = await resolveWindowsPath();
  try {
    const result = await execFileAsync("where.exe", [command], {
      env: { ...process.env, PATH: winPath },
      windowsHide: true,
      timeout: 8_000
    });
    const found = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) return found;
  } catch {
    // fall through
  }
  const names = /\.(cmd|exe|bat)$/i.test(command)
    ? [command]
    : [command, `${command}.cmd`, `${command}.exe`, `${command}.bat`];
  for (const dir of winPath.split(";")) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await pathExists(candidate)) return candidate;
    }
  }
  return null;
}

async function windowsCommandVersion(command: string, args: string[]): Promise<string | null> {
  try {
    const winPath = await resolveWindowsPath();
    const result = await execFileAsync(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(command, args), {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, PATH: winPath },
      timeout: 15_000
    });
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    return text || null;
  } catch {
    return null;
  }
}

// ---- Shared thin dispatchers (no platform-specific logic inside) ----

/** Apply platform tool PATH for child processes. Windows and macOS implementations are independent. */
async function applyLoginPathToProcess(): Promise<void> {
  if (process.platform === "win32") {
    await applyWindowsPathToProcess();
    return;
  }
  if (process.platform === "darwin") {
    await applyMacLoginPathToProcess();
  }
}

async function findOnPath(command: string): Promise<string | null> {
  if (process.platform === "win32") return findOnWindowsPath(command);
  if (process.platform === "darwin") return findOnMacPath(command);
  return null;
}

async function commandVersion(command: string, args: string[]): Promise<string | null> {
  if (process.platform === "win32") return windowsCommandVersion(command, args);
  if (process.platform === "darwin") return macCommandVersion(command, args);
  return null;
}

async function detectEnvironment(): Promise<EnvironmentState> {
  await applyLoginPathToProcess();
  const nodeCommand = process.platform === "win32"
    ? await findOnWindowsPath("node.exe")
    : await findOnMacPath("node");
  const nodeOutput = nodeCommand ? await commandVersion(nodeCommand, ["--version"]) : null;
  const configuredCodex = process.env.CODEX_COMMAND
    ? (process.platform === "win32" ? normalizeWindowsCommandPath(process.env.CODEX_COMMAND) : process.env.CODEX_COMMAND)
    : null;
  const discoveredCodex = configuredCodex
    ?? (process.platform === "win32" ? await findOnWindowsPath("codex.cmd") : await findOnMacPath("codex"));
  if (discoveredCodex) {
    codexCommand = process.platform === "win32" ? normalizeWindowsCommandPath(discoveredCodex) : discoveredCodex;
  }
  const codexOutput = discoveredCodex ? await commandVersion(codexCommand, ["--version"]) : null;
  const detectedVersion = codexOutput?.replace(/^codex-cli\s+/i, "").trim();
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

// ---- Windows-only Codex install (in-process npm; console only for login) ----

async function runWindowsCommand(
  command: string,
  args: string[],
  onChunk?: (text: string) => void
): Promise<void> {
  if (process.platform !== "win32") throw new Error("runWindowsCommand is Windows-only");
  await applyWindowsPathToProcess();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(command, args), {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: process.env,
      cwd: os.homedir()
    });
    let combined = "";
    const handleChunk = (buf: Buffer) => {
      const text = buf.toString("utf8");
      combined = `${combined}${text}`.slice(-4_000);
      onChunk?.(combined);
    };
    child.stdout?.on("data", handleChunk);
    child.stderr?.on("data", handleChunk);
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(combined.trim() || `命令失败，退出码 ${code ?? "unknown"}`));
    });
  });
}

/** Visible console from Electron GUI on Windows (WScript is more reliable than cmd start). */
async function openWindowsVisibleConsole(lines: string[]): Promise<void> {
  if (process.platform !== "win32") throw new Error("openWindowsVisibleConsole is Windows-only");
  const stamp = Date.now();
  const scriptPath = path.join(app.getPath("temp"), `anytimevibe-console-${stamp}.cmd`);
  const vbsPath = path.join(app.getPath("temp"), `anytimevibe-console-${stamp}.vbs`);
  const script = [
    "@echo off",
    "setlocal EnableExtensions",
    "chcp 65001 >nul",
    "title AnytimeVibe",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\" /v Path 2^>nul') do set \"SYSPATH=%%B\"",
    "for /f \"tokens=2*\" %%A in ('reg query \"HKCU\\Environment\" /v Path 2^>nul') do set \"USERPATH=%%B\"",
    "set \"PATH=%SYSPATH%;%USERPATH%;%ProgramFiles%\\nodejs;%APPDATA%\\npm;%PATH%\"",
    ...lines,
    "echo.",
    "pause",
    "endlocal",
    ""
  ].join("\r\n");
  await fs.writeFile(scriptPath, script, "utf8");
  const quoted = scriptPath.replace(/"/g, '""');
  const vbs = `CreateObject("WScript.Shell").Run "cmd /k ""${quoted}""", 1, False`;
  await fs.writeFile(vbsPath, vbs, "utf8");
  const wscript = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe");
  const child = spawn(wscript, [vbsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: os.homedir()
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`无法打开控制台：${error.message}`)));
    child.once("spawn", () => resolve());
    setTimeout(() => resolve(), 800);
  });
  child.unref();
}

async function installCodexOnWindows(): Promise<void> {
  if (process.platform !== "win32") throw new Error("installCodexOnWindows is Windows-only");
  await applyWindowsPathToProcess();
  updateState({ detail: "正在查找 npm…" });
  const npm = (await findOnWindowsPath("npm.cmd")) ?? (await findOnWindowsPath("npm"));
  if (!npm) {
    throw new Error("未找到 npm。请确认 Node.js 安装时包含 npm，然后重启随码客户端再试。");
  }

  updateState({ detail: `正在安装 @openai/codex@0.144.0…\nnpm: ${npm}` });
  await runWindowsCommand(npm, ["install", "-g", "@openai/codex@0.144.0"], (log) => {
    const tail = log.replace(/\r/g, "").split("\n").filter(Boolean).slice(-4).join(" | ");
    updateState({ detail: `正在安装 Codex CLI… ${tail}` });
  });

  cachedWindowsPath = null;
  await applyWindowsPathToProcess();
  const environment = await detectEnvironment();
  updateState({ environment });

  if (!environment.codexCompatible) {
    throw new Error(
      environment.codexInstalled
        ? `已安装但版本不兼容（当前 ${environment.codexVersion}，需要 0.144.x）。`
        : "npm 安装已结束，但仍未检测到 codex 命令。请重启客户端后再点「重新检测」。"
    );
  }

  updateState({ environment, detail: "Codex 安装成功，正在打开登录窗口…" });
  try {
    await openWindowsVisibleConsole([
      "echo ============================================",
      "echo   AnytimeVibe - codex login",
      "echo ============================================",
      "echo.",
      "where codex",
      "echo.",
      "call codex login",
      "echo.",
      "echo Login finished. Close this window and return to AnytimeVibe."
    ]);
    updateState({
      environment,
      detail: "Codex 已安装。请在弹出的登录窗口完成 codex login，然后点击「重新检测」。"
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateState({
      environment,
      detail: `Codex 已安装，但无法自动打开登录窗口（${message}）。请手动打开终端运行：codex login`
    });
  }
}

// ---- macOS-only Codex install (Terminal.app; unchanged from prior mac behavior) ----

async function installCodexOnMac(): Promise<void> {
  if (process.platform !== "darwin") throw new Error("installCodexOnMac is macOS-only");
  await applyMacLoginPathToProcess();
  const installCommand = "npm install -g @openai/codex@0.144.0 && codex login; echo ''; echo '完成。可关闭此窗口，回到随码客户端点击重新检测。'";
  await execFileAsync("osascript", ["-e", `tell application \"Terminal\" to do script \"${installCommand}\"`]);
  await execFileAsync("osascript", ["-e", "tell application \"Terminal\" to activate"]);
  updateState({ detail: "已打开 Terminal 安装窗口。完成后请点击「重新检测」。" });
}

async function installEnvironment(target: "node" | "codex"): Promise<void> {
  if (target === "node") {
    await shell.openExternal("https://nodejs.org/en/download");
    updateState({ detail: "已打开 Node.js 下载页。安装完成后请重启随码并点击「重新检测」。" });
    return;
  }
  // Strict platform split: do not share install implementation across OS.
  if (process.platform === "win32") {
    await installCodexOnWindows();
    return;
  }
  if (process.platform === "darwin") {
    await installCodexOnMac();
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
      agentName: resolvedDisplayName(),
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

let pairingPollInFlight = false;

function schedulePairingPoll(): void {
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(() => pollPairing().catch(handleError), 1800);
}

async function pollPairing(): Promise<void> {
  if (pairingPollInFlight) return;
  const pairing = config.pairing;
  if (!pairing) return;
  pairingPollInFlight = true;
  try {
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
    if (result.status !== "claimed") {
      schedulePairingPoll();
      return;
    }
    // Claim ownership of this pairing immediately to prevent concurrent poll races.
    delete config.pairing;
    await saveConfig();
    updateState({ pairingCode: undefined, pairingExpiresAt: undefined });

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
    await saveConfig();
    syncKey = await importAesKey(base64ToBytes(syncKeyValue));
    updateState({ status: "connecting", detail: "新浏览器已获得主机密钥授权，正在建立连接。", hostId: config.hostId });
    await connect(true);
  } finally {
    pairingPollInFlight = false;
  }
}

function wsUrl(relayUrl: string): string {
  return relayUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

let connecting = false;

const FATAL_WS_CODES = new Set([
  4001, // missing_credentials
  4003 // unauthorized / revoked
]);

async function connect(force = false): Promise<void> {
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    if (config.pairing) schedulePairingPoll();
    else updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
    return;
  }
  if (reconnectBlockedReason && !force) {
    updateState({ status: "offline", detail: reconnectBlockedReason });
    return;
  }
  // Refresh toolchain paths before deciding compatibility (important on macOS GUI launches).
  await applyLoginPathToProcess();
  if (!/^0\.144\./.test(codexVersion)) {
    const environment = await detectEnvironment();
    updateState({ environment });
    if (!environment.codexCompatible) {
      updateState({
        status: "incompatible",
        detail: environment.codexInstalled
          ? `当前仅支持 codex-cli 0.144.x，检测到 ${environment.codexVersion}。`
          : "未检测到兼容的 Codex CLI，中继将暂不连接。"
      });
      return;
    }
  }
  if (!force && socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (connecting && !force) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connecting = true;
  if (force) {
    reconnectBlockedReason = null;
    reconnectAttempt = 0;
  }
  const generation = ++connectGeneration;
  const previousSocket = socket;
  socket = null;
  if (previousSocket) {
    previousSocket.removeAllListeners();
    try {
      previousSocket.close();
    } catch {
      // ignore
    }
  }
  try {
    syncKey ??= await importAesKey(base64ToBytes(decryptSecret(config.encryptedSyncKey)));
  } catch (error) {
    connecting = false;
    handleError(error);
    return;
  }
  updateState({ status: "connecting", detail: "正在连接加密中继…", hostId: config.hostId });
  let token: string;
  try {
    token = decryptSecret(config.encryptedAgentToken);
  } catch (error) {
    connecting = false;
    handleError(error);
    return;
  }
  const connection = new WebSocket(`${wsUrl(config.relayUrl)}/ws/agent?hostId=${encodeURIComponent(config.hostId)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  socket = connection;
  connection.on("open", () => {
    if (generation !== connectGeneration || socket !== connection) {
      try {
        connection.close();
      } catch {
        // ignore
      }
      return;
    }
    connecting = false;
    reconnectAttempt = 0;
    reconnectBlockedReason = null;
    // Keep the relay socket online even if Codex bootstrap fails, otherwise macOS
    // (missing GUI PATH / codex shebang) will flap between offline and reconnect.
    void (async () => {
      updateState({ status: "online", detail: "代理在线。Codex 凭据和项目文件均保留在本机。" });
      try {
        await ensureCodex();
        if (generation !== connectGeneration || socket !== connection) return;
        await publishHostStatus();
        await syncAllThreads();
      } catch (error) {
        if (generation !== connectGeneration || socket !== connection) return;
        const message = error instanceof Error ? error.message : String(error);
        updateState({
          status: "online",
          detail: `中继已连接，但 Codex 尚未就绪：${message}`
        });
      }
    })();
  });
  connection.on("message", (data) => {
    if (generation !== connectGeneration || socket !== connection) return;
    handleRelayMessage(String(data)).catch(handleError);
  });
  connection.on("close", (code, reason) => {
    if (generation !== connectGeneration) return;
    connecting = false;
    if (socket === connection) socket = null;
    const why = reason?.toString?.() || `code ${code}`;
    // 4002 = replaced by a newer agent socket for the same host — do not fight it.
    if (code === 4002) {
      updateState({ status: "offline", detail: "连接已被新的代理实例替换。" });
      return;
    }
    if (FATAL_WS_CODES.has(code) || /unauthorized|revoked|missing_credentials|user_deleted/i.test(why)) {
      reconnectBlockedReason = `中继拒绝连接（${why}）。请重新配对。`;
      updateState({ status: "offline", detail: reconnectBlockedReason });
      return;
    }
    scheduleReconnect(`中继连接已断开（${why}），正在重试。`);
  });
  connection.on("error", (error) => {
    if (generation !== connectGeneration) return;
    connecting = false;
    if (socket === connection) {
      updateState({ status: "offline", detail: `无法连接中继：${error.message || "网络错误"}，正在重试。` });
    }
    // Let the close handler own reconnect scheduling to avoid double timers.
    try {
      connection.close();
    } catch {
      // ignore
    }
  });
}

function scheduleReconnect(detail: string): void {
  if (quitting) return;
  if (publicState.status === "incompatible") return;
  if (reconnectBlockedReason) {
    updateState({ status: "offline", detail: reconnectBlockedReason });
    return;
  }
  if (!config.hostId || !config.encryptedAgentToken || !config.encryptedSyncKey) {
    updateState({ status: "waiting_pairing", detail: "等待配对连接，请生成配对码并在 Web 端完成授权。" });
    return;
  }
  updateState({ status: "offline", detail });
  if (reconnectTimer) return;
  reconnectAttempt += 1;
  // Exponential backoff with jitter: ~2s, 3s, 5s … capped at 30s.
  const base = Math.min(30_000, 1500 * 2 ** Math.min(reconnectAttempt - 1, 4));
  const delay = base + Math.floor(Math.random() * 800);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(handleError);
  }, delay);
}

async function ensureCodex(): Promise<void> {
  if (codex) return;
  await applyLoginPathToProcess();
  if (!/^0\.144\./.test(codexVersion)) {
    const environment = await detectEnvironment();
    updateState({ environment });
    if (!environment.codexCompatible) {
      throw new Error(environment.codexInstalled
        ? `Codex 版本不兼容（需要 0.144.x，当前 ${environment.codexVersion}）`
        : "未检测到 Codex CLI");
    }
  }
  codex = new CodexAdapter(codexCommand, (message) => {
    if (quitting || installingUpdate) return;
    handleCodexMessage(message).catch(handleError);
  }, (detail) => {
    codex = null;
    // Ignore exit noise while shutting down for update/quit — UI may already be destroyed.
    if (quitting || installingUpdate) return;
    // Do not tear down the relay socket when Codex exits; keep online for reconnect of Codex only.
    updateState({
      status: socket?.readyState === WebSocket.OPEN ? "online" : publicState.status,
      detail: `Codex 已停止：${detail}`
    });
  });
  await codex.start();
}

async function handleRelayMessage(raw: string): Promise<void> {
  const parsed = JSON.parse(raw) as Record<string, any>;
  if (parsed.type === "relay.key_authorization") {
    if (!config.encryptedSyncKey) throw new Error("Missing encrypted sync key");
    await ensurePairingKeys();
    const pairingId = String(parsed.pairingId);
    const privateJwk = JSON.parse(decryptSecret(config.encryptedPrivateKey!)) as JsonWebKey;
    const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const pairingKey = await derivePairingKey(privateKey, parsed.clientPublicKey as JsonWebKey, pairingId);
    const wrappedSyncKey = await encryptPayload(pairingKey, { syncKey: decryptSecret(config.encryptedSyncKey) }, pairingId);
    socket?.send(JSON.stringify({ type: "agent.key_authorization", pairingId, wrappedSyncKey }));
    return;
  }
  const envelope = parsed as EncryptedEnvelope;
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
      const started = await codex!.request("thread/start", threadStartParams(command.cwd, command.permissionMode));
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
      await codex!.request("thread/resume", { threadId: command.threadId, ...codexPermissionParams(command.permissionMode) });
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
      await Promise.race([
        codex!.request("turn/interrupt", { threadId: command.threadId, turnId: command.turnId }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      finishLocalActivity(command.threadId, "interrupted");
      await publish({ type: "turn.completed", eventId: crypto.randomUUID(), occurredAt: new Date().toISOString(), threadId: command.threadId, turnId: command.turnId, status: "interrupted" }, true, "completed");
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
    name: resolvedDisplayName(), platform: `${process.platform} ${os.release()}`, codexVersion,
    workspaces: config.workspaces
  }, true);
}

async function publishThread(threadId: string): Promise<void> {
  const result = await codex!.request("thread/read", { threadId, includeTurns: true });
  const snapshot = threadToSnapshot(result.thread);
  const task: AgentTask = { threadId: snapshot.threadId, title: snapshot.title, cwd: snapshot.cwd, status: snapshot.status, updatedAt: snapshot.updatedAt };
  updateState({ tasks: [task, ...publicState.tasks.filter((item) => item.threadId !== task.threadId)].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 100) });
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function relayTaskToCli(threadId: string): Promise<void> {
  const task = publicState.tasks.find((item) => item.threadId === threadId);
  if (!task) throw new Error("任务不存在，请先同步任务列表。");
  if (process.platform === "win32") {
    const child = spawn(process.env.ComSpec ?? "cmd.exe", windowsCmdArguments(codexCommand, ["resume", threadId]), {
      cwd: task.cwd || undefined,
      detached: true,
      windowsHide: false,
      windowsVerbatimArguments: true,
      stdio: "ignore"
    });
    child.unref();
    return;
  }
  if (process.platform === "darwin") {
    const command = `cd ${shellQuote(task.cwd || os.homedir())} && ${shellQuote(codexCommand)} resume ${shellQuote(threadId)}`;
    await execFileAsync("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(command)}`]);
    await execFileAsync("osascript", ["-e", "tell application \"Terminal\" to activate"]);
    return;
  }
  throw new Error("当前系统暂不支持启动接力终端。");
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
  if (quitting || installingUpdate) return;
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
  autoUpdater.on("error", (error) => {
    // Do not clear flags mid-install; that re-enables tray-hide and races with quit.
    if (installingUpdate) {
      console.error("update install error:", error);
      return;
    }
    if (quitting) quitting = false;
    updateState({ update: { status: "error", message: error.message } });
  });
  // Required so window close handlers do not cancel quitAndInstall by hide-to-tray.
  // electron-updater emits this event; typings may lag behind runtime.
  (autoUpdater as NodeJS.EventEmitter).on("before-quit-for-update", () => {
    quitting = true;
    installingUpdate = true;
    prepareForUpdateQuit();
  });
}

/** Tear down sockets/codex/UI before the updater replaces the app bundle. */
function prepareForUpdateQuit(): void {
  quitting = true;
  installingUpdate = true;
  reconnectBlockedReason = "updating";
  connectGeneration += 1;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (pairingTimer) {
    clearTimeout(pairingTimer);
    pairingTimer = null;
  }
  if (activityFlushTimer) {
    clearTimeout(activityFlushTimer);
    activityFlushTimer = null;
  }
  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  try {
    codex?.stop();
  } catch {
    // ignore
  }
  codex = null;
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch {
    // ignore
  }
  try {
    if (windowRef && !windowRef.isDestroyed()) {
      windowRef.removeAllListeners("close");
      windowRef.destroy();
    }
  } catch {
    // ignore
  }
  windowRef = null;
}

function installDownloadedUpdate(): void {
  if (installingUpdate) return;
  if (publicState.update.status !== "ready") {
    updateState({ update: { status: "error", message: "更新包尚未下载完成，请先等待下载或点击检查更新。" } });
    return;
  }
  // 1) Mark quit + tear down runtime so no callback touches destroyed UI.
  // 2) Only then ask electron-updater to install (after the process is idle).
  prepareForUpdateQuit();
  // Drain pending child-process exit / IPC events before replacing the app.
  setTimeout(() => {
    try {
      // isSilent=false so the installer UI can run; isForceRunAfter=true restarts the app.
      autoUpdater.quitAndInstall(false, true);
      // Fallback: if quitAndInstall is a no-op (e.g. app still running from DMG), force quit
      // so autoInstallOnAppQuit can apply the already-downloaded update on next launch.
      setTimeout(() => {
        if (!installingUpdate) return;
        try {
          app.quit();
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (installingUpdate) app.exit(0);
        }, 1500);
      }, 2000);
    } catch (error) {
      installingUpdate = false;
      quitting = false;
      const message = error instanceof Error ? error.message : String(error);
      updateState({ update: { status: "error", message: `无法启动安装：${message}` } });
    }
  }, 150);
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
  ipcMain.handle("agent:set-display-name", async (_event, displayName: string) => {
    const normalized = String(displayName ?? "").trim().slice(0, 64);
    if (!normalized) throw new Error("客户端名称不能为空");
    config.displayName = normalized;
    await saveConfig();
    updateState({ displayName: normalized, detail: `客户端名称已更新为“${normalized}”。` });
    if (socket?.readyState === WebSocket.OPEN) await publishHostStatus();
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
    try {
      await installEnvironment(target);
    } catch (error) {
      handleError(error);
      throw error;
    }
    return publicState;
  });
  ipcMain.handle("agent:check-update", async () => { await checkForAgentUpdate(); return publicState; });
  ipcMain.handle("agent:install-update", () => {
    try {
      installDownloadedUpdate();
    } catch (error) {
      installingUpdate = false;
      quitting = false;
      const message = error instanceof Error ? error.message : String(error);
      updateState({ update: { status: "error", message: `安装更新失败：${message}` } });
    }
    return publicState;
  });
  ipcMain.handle("agent:relay-task", async (_event, threadId: string) => {
    await relayTaskToCli(threadId);
    return publicState;
  });
}

// Windows taskbar title/icon rely on AppUserModelID + embedded exe resources.
if (process.platform === "win32") {
  app.setAppUserModelId("com.anytimevibe.agent");
}

app.whenReady().then(async () => {
  await loadConfig();
  registerIpc();
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }]));
  } else {
    Menu.setApplicationMenu(null);
  }
  app.setLoginItemSettings({ openAtLogin: true });
  const traySource = loadProductIcon();
  const trayIcon = traySource.resize({ width: 16, height: 16 });
  if (process.platform === "darwin") trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip("随码");
  tray.on("double-click", showWindow);
  tray.on("click", () => {
    if (process.platform === "win32") showWindow();
  });
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
  if (installingUpdate) {
    // prepareForUpdateQuit already cleaned resources; avoid double-kill races.
    return;
  }
  reconnectTimer && clearTimeout(reconnectTimer);
  pairingTimer && clearTimeout(pairingTimer);
  try {
    socket?.removeAllListeners();
    socket?.close();
  } catch {
    // ignore
  }
  socket = null;
  try {
    codex?.stop();
  } catch {
    // ignore
  }
  codex = null;
});
