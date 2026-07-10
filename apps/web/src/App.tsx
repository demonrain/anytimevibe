import { useEffect, useEffectEvent, useState } from "react";
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
  type PairingPublicInfo,
  type Workspace
} from "@anytimevibe/protocol";
import { api, websocketUrl } from "./api";
import { getHostKey, saveHostKey } from "./key-store";

type Health = { ok: boolean; needsSetup: boolean; vapidPublicKey: string | null };
type User = { id: string; username: string };
type Host = {
  id: string;
  name: string;
  platform: string;
  codexVersion: string;
  lastSeenAt: string | null;
  online: boolean;
};
type Approval = Extract<AgentEvent, { type: "approval.requested" }>;
type Task = {
  threadId: string;
  title: string;
  cwd: string;
  status: string;
  updatedAt: number;
  activeTurnId?: string;
  diff: string;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string }>;
  approvals: Approval[];
};
type HostRuntime = {
  online: boolean;
  workspaces: Workspace[];
  tasks: Record<string, Task>;
};

function emptyRuntime(online = false): HostRuntime {
  return { online, workspaces: [], tasks: {} };
}

function reduceEvent(runtime: HostRuntime, event: AgentEvent): HostRuntime {
  const next = structuredClone(runtime);
  if (event.type === "host.status") {
    next.online = event.online;
    next.workspaces = event.workspaces;
    return next;
  }
  if (event.type === "thread.snapshot") {
    const existing = next.tasks[event.threadId];
    next.tasks[event.threadId] = {
      threadId: event.threadId,
      title: event.title || "未命名任务",
      cwd: event.cwd,
      status: event.status,
      updatedAt: event.updatedAt,
      diff: existing?.diff ?? "",
      messages: event.messages,
      approvals: existing?.approvals ?? [],
      ...(existing?.activeTurnId ? { activeTurnId: existing.activeTurnId } : {})
    };
    return next;
  }
  if (event.type === "error") return next;
  if (event.type === "request.resolved") {
    if (event.threadId) {
      const task = next.tasks[event.threadId];
      if (task) task.approvals = task.approvals.filter((approval: Approval) => approval.requestId !== event.requestId);
    } else {
      for (const task of Object.values(next.tasks)) {
        task.approvals = task.approvals.filter((approval: Approval) => approval.requestId !== event.requestId);
      }
    }
    return next;
  }
  const task = next.tasks[event.threadId] ?? {
    threadId: event.threadId,
    title: "进行中的任务",
    cwd: "",
    status: "active",
    updatedAt: Date.now() / 1000,
    diff: "",
    messages: [],
    approvals: []
  };
  next.tasks[event.threadId] = task;
  task.updatedAt = Date.now() / 1000;
  if (event.type === "turn.started") {
    task.status = "active";
    task.activeTurnId = event.turnId;
    if (event.prompt) task.messages.push({ id: event.eventId, role: "user", text: event.prompt });
  }
  if (event.type === "turn.delta") {
    const id = `assistant:${event.turnId}:${event.itemId}`;
    const message = task.messages.find((item: Task["messages"][number]) => item.id === id);
    if (message) message.text += event.delta;
    else task.messages.push({ id, role: "assistant", text: event.delta });
  }
  if (event.type === "turn.completed") {
    task.status = event.status;
    delete task.activeTurnId;
  }
  if (event.type === "diff.updated") task.diff = event.diff;
  if (event.type === "approval.requested") task.approvals.push(event);
  return next;
}

function ErrorBanner({ message, clear }: { message: string; clear(): void }) {
  return <button className="error-banner" onClick={clear}>{message}<span>关闭</span></button>;
}

function AuthScreen({ health, onAuthenticated }: { health: Health; onAuthenticated(user: User): void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await api<{ user: User }>(health.needsSetup ? "/api/setup" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify(health.needsSetup ? { username, password, setupToken } : { username, password })
      });
      onAuthenticated(response.user);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "登录失败");
    } finally {
      setLoading(false);
    }
  }

  return <main className="auth-shell">
    <section className="auth-story">
      <p className="eyebrow">YOUR CODE, STILL MOVING</p>
      <h1>离开电脑，<br />任务不用停。</h1>
      <p>连接自己的 Windows 主机，继续 Codex 对话、处理审批、查看代码 Diff。云端只负责转发密文。</p>
      <div className="signal-line"><span />端到端加密连接</div>
    </section>
    <form className="auth-card" onSubmit={submit}>
      <div className="mark">AV</div>
      <h2>{health.needsSetup ? "初始化个人空间" : "进入 AnytimeVibe"}</h2>
      <p>{health.needsSetup ? "设置完成后，一次性令牌将不再使用。" : "使用你的个人账号继续远程任务。"}</p>
      {health.needsSetup && <label>设置令牌<input value={setupToken} onChange={(event) => setSetupToken(event.target.value)} required /></label>}
      <label>用户名<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
      <label>密码<input type="password" autoComplete={health.needsSetup ? "new-password" : "current-password"} minLength={health.needsSetup ? 10 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary" disabled={loading}>{loading ? "处理中…" : health.needsSetup ? "创建空间" : "登录"}</button>
    </form>
  </main>;
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [runtime, setRuntime] = useState<Record<string, HostRuntime>>({});
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [error, setError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    api<Health>("/api/health").then(async (value) => {
      setHealth(value);
      if (!value.needsSetup) {
        const session = await api<{ user: User }>("/api/auth/session").catch(() => null);
        if (session) setUser(session.user);
      }
    }).catch((loadError) => setError(loadError.message));
  }, []);

  const handleEnvelope = useEffectEvent(async (envelope: EncryptedEnvelope) => {
    const key = await getHostKey(envelope.hostId);
    if (!key) return;
    const event = agentEventSchema.parse(await openEnvelope<AgentEvent>(key, envelope));
    setRuntime((current) => ({
      ...current,
      [envelope.hostId]: reduceEvent(current[envelope.hostId] ?? emptyRuntime(), event)
    }));
    if (envelope.persist) localStorage.setItem(`sync:${envelope.hostId}`, String(envelope.sequence));
  });

  const loadHosts = useEffectEvent(async () => {
    const response = await api<{ hosts: Host[] }>("/api/hosts");
    setHosts(response.hosts);
    setRuntime((current) => {
      const next = { ...current };
      for (const host of response.hosts) next[host.id] = { ...(next[host.id] ?? emptyRuntime()), online: host.online };
      return next;
    });
    setSelectedHostId((current) => current ?? response.hosts[0]?.id ?? null);
    for (const host of response.hosts) {
      const key = await getHostKey(host.id);
      if (!key) continue;
      const after = Number(localStorage.getItem(`sync:${host.id}`) ?? 0);
      const sync = await api<{ events: EncryptedEnvelope[]; nextSequence: number }>(`/api/sync/${host.id}?after=${after}`);
      for (const envelope of sync.events) await handleEnvelope(envelope);
    }
  });

  useEffect(() => {
    if (!user) return;
    loadHosts().catch((loadError) => setError(loadError.message));
    const connection = new WebSocket(websocketUrl("/ws/client"));
    connection.onmessage = (message) => {
      try {
        const parsed = JSON.parse(String(message.data));
        if (parsed.type === "relay.host_status") {
          setRuntime((current) => ({
            ...current,
            [parsed.hostId]: { ...(current[parsed.hostId] ?? emptyRuntime()), online: Boolean(parsed.online) }
          }));
          return;
        }
        if (parsed.type === "relay.error") {
          setError(parsed.error === "host_offline" ? "远程主机当前离线。" : "中继拒绝了这条消息。");
          return;
        }
        handleEnvelope(parsed as EncryptedEnvelope).catch((openError) => setError(`无法解密远程事件：${openError.message}`));
      } catch {
        setError("收到无法识别的中继消息。");
      }
    };
    connection.onclose = () => setSocket(null);
    connection.onerror = () => setError("实时连接已断开，正在等待页面重连。");
    setSocket(connection);
    return () => connection.close();
  }, [user]);

  async function sendCommand(hostId: string, command: ClientCommand) {
    const parsed = clientCommandSchema.parse(command);
    const key = await getHostKey(hostId);
    if (!key) throw new Error("此浏览器没有该主机的解密密钥，请重新配对。");
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("实时连接尚未建立。");
    const sequence = Number(localStorage.getItem(`command:${hostId}`) ?? 0) + 1;
    localStorage.setItem(`command:${hostId}`, String(sequence));
    socket.send(JSON.stringify(await createEnvelope(hostId, sequence, key, parsed)));
  }

  if (!health) return <main className="loading-screen"><div className="pulse" /><p>正在建立安全工作区…</p>{error && <ErrorBanner message={error} clear={() => setError("")} />}</main>;
  if (!user) return <AuthScreen health={health} onAuthenticated={setUser} />;

  const activeHost = hosts.find((host) => host.id === selectedHostId) ?? null;
  const activeRuntime = selectedHostId ? runtime[selectedHostId] ?? emptyRuntime() : emptyRuntime();
  const tasks = Object.values(activeRuntime.tasks).sort((left, right) => right.updatedAt - left.updatedAt);
  const activeTask = tasks.find((task) => task.threadId === selectedTaskId) ?? tasks[0] ?? null;

  return <div className="app-shell">
    {error && <ErrorBanner message={error} clear={() => setError("")} />}
    <header className="topbar">
      <div className="brand"><span>AV</span><div><strong>AnytimeVibe</strong><small>REMOTE CODE DESK</small></div></div>
      <div className="top-actions">
        <button className="quiet" onClick={() => subscribePush(health.vapidPublicKey).catch((pushError) => setError(pushError.message))}>开启通知</button>
        <button className="avatar" title={user.username} onClick={async () => { await api("/api/auth/logout", { method: "POST" }); location.reload(); }}>{user.username.slice(0, 1).toUpperCase()}</button>
      </div>
    </header>

    <aside className="rail">
      <div className="rail-heading"><span>远程主机</span><button onClick={() => setPairingOpen(true)}>＋</button></div>
      <div className="host-list">
        {hosts.map((host) => <button key={host.id} className={`host-pill ${host.id === selectedHostId ? "active" : ""}`} onClick={() => { setSelectedHostId(host.id); setSelectedTaskId(null); }}>
          <span className={`status-dot ${(runtime[host.id]?.online ?? host.online) ? "online" : ""}`} />
          <span><strong>{host.name}</strong><small>{host.codexVersion}</small></span>
        </button>)}
        {!hosts.length && <button className="empty-host" onClick={() => setPairingOpen(true)}>连接第一台电脑</button>}
      </div>
    </aside>

    <main className="workspace">
      <section className="task-column">
        <div className="section-title">
          <div><p className="eyebrow">TASK STREAM</p><h1>{activeHost?.name ?? "尚未连接主机"}</h1></div>
          <button className="new-task" disabled={!activeHost || !activeRuntime.online} onClick={() => setComposerOpen(true)}>新任务</button>
        </div>
        <div className="connection-note"><span className={`status-dot ${activeRuntime.online ? "online" : ""}`} />{activeRuntime.online ? "主机在线，命令将立即执行" : "主机离线，仅可查看已同步记录"}</div>
        <div className="task-list">
          {tasks.map((task) => <button key={task.threadId} className={`task-card ${activeTask?.threadId === task.threadId ? "active" : ""}`} onClick={() => setSelectedTaskId(task.threadId)}>
            <div className="task-meta"><span>{task.status}</span><time>{new Date(task.updatedAt * 1000).toLocaleString()}</time></div>
            <h3>{task.title}</h3>
            <p>{task.messages.at(-1)?.text || task.cwd}</p>
            <div className="task-foot"><code>{shortPath(task.cwd)}</code>{task.approvals.length > 0 && <b>{task.approvals.length} 个审批</b>}</div>
          </button>)}
          {!tasks.length && <div className="empty-state"><span>&gt;_</span><h3>等待第一条远程任务</h3><p>选择白名单工作区，向本机 Codex 下发任务。</p></div>}
        </div>
      </section>

      <section className="conversation-column">
        {activeTask ? <TaskConversation task={activeTask} online={activeRuntime.online} onCommand={(command) => sendCommand(activeHost!.id, command).catch((sendError) => setError(sendError.message))} /> : <div className="conversation-empty"><div className="orbit" /><h2>选择一个任务</h2><p>这里会显示对话、执行状态、审批和最新 Diff。</p></div>}
      </section>
    </main>

    {pairingOpen && <PairingDialog onClose={() => setPairingOpen(false)} onPaired={async () => { setPairingOpen(false); await loadHosts(); }} />}
    {composerOpen && activeHost && <NewTaskDialog host={activeHost} workspaces={activeRuntime.workspaces} onClose={() => setComposerOpen(false)} onCreate={async (cwd, prompt, title) => {
      await sendCommand(activeHost.id, { type: "task.create", commandId: crypto.randomUUID(), cwd, prompt, ...(title ? { title } : {}) });
      setComposerOpen(false);
    }} />}
  </div>;
}

function TaskConversation({ task, online, onCommand }: { task: Task; online: boolean; onCommand(command: ClientCommand): void }) {
  const [prompt, setPrompt] = useState("");
  const [tab, setTab] = useState<"chat" | "diff">("chat");
  const running = Boolean(task.activeTurnId);
  return <>
    <div className="conversation-head">
      <div><p className="eyebrow">THREAD</p><h2>{task.title}</h2><code>{task.cwd}</code></div>
      <div className="tabs"><button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>对话</button><button className={tab === "diff" ? "active" : ""} onClick={() => setTab("diff")}>Diff</button></div>
    </div>
    {tab === "chat" ? <div className="message-stream">
      {task.messages.map((message) => <article key={message.id} className={`message ${message.role}`}><span>{message.role === "user" ? "YOU" : message.role === "assistant" ? "CODEX" : "SYSTEM"}</span><pre>{message.text}</pre></article>)}
      {task.approvals.map((approval) => <article className="approval-card" key={String(approval.requestId)}>
        <div className="approval-label">ACTION REQUIRED</div><h3>{approval.title}</h3><pre>{approval.detail}</pre>
        <div className="approval-actions"><button onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "decline" })}>拒绝</button><button className="approve" onClick={() => onCommand({ type: "approval.resolve", commandId: crypto.randomUUID(), requestId: approval.requestId, decision: "accept" })}>允许一次</button></div>
      </article>)}
    </div> : <DiffView diff={task.diff} />}
    <form className="composer" onSubmit={(event) => {
      event.preventDefault();
      if (!prompt.trim() || !online) return;
      onCommand(running && task.activeTurnId ? { type: "turn.steer", commandId: crypto.randomUUID(), threadId: task.threadId, turnId: task.activeTurnId, prompt: prompt.trim() } : { type: "turn.start", commandId: crypto.randomUUID(), threadId: task.threadId, prompt: prompt.trim() });
      setPrompt("");
    }}>
      <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={online ? running ? "给当前任务追加方向…" : "继续这个任务…" : "主机离线"} disabled={!online} />
      <div><small>{running ? "任务运行中，可追加指令或停止" : "沿用本机 Codex 沙箱和审批策略"}</small>{running && task.activeTurnId && <button type="button" className="stop" onClick={() => onCommand({ type: "turn.interrupt", commandId: crypto.randomUUID(), threadId: task.threadId, turnId: task.activeTurnId! })}>停止</button>}<button className="send" disabled={!online || !prompt.trim()}>发送</button></div>
    </form>
  </>;
}

function DiffView({ diff }: { diff: string }) {
  if (!diff) return <div className="diff-empty">当前任务还没有产生代码变更。</div>;
  return <div className="diff-view">{diff.split("\n").map((line, index) => <div key={index} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "remove" : line.startsWith("@@") ? "hunk" : ""}>{line || " "}</div>)}</div>;
}

function PairingDialog({ onClose, onPaired }: { onClose(): void; onPaired(): void }) {
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<PairingPublicInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function inspect() {
    setLoading(true); setError("");
    try { setInfo(await api<PairingPublicInfo>(`/api/pairings/code/${code}`)); }
    catch (inspectError) { setError(inspectError instanceof Error ? inspectError.message : "配对码无效"); }
    finally { setLoading(false); }
  }

  async function claim() {
    if (!info) return;
    setLoading(true); setError("");
    try {
      const keyPair = await generatePairingKeyPair();
      const clientPublicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const pairingKey = await derivePairingKey(keyPair.privateKey, info.agentPublicKey, info.pairingId);
      const syncBytes = randomKeyBytes();
      const wrappedSyncKey = await encryptPayload(pairingKey, { syncKey: bytesToBase64(syncBytes) }, info.pairingId);
      const result = await api<{ host: Host }>(`/api/pairings/${info.pairingId}/claim`, {
        method: "POST",
        body: JSON.stringify({ clientPublicKey, wrappedSyncKey })
      });
      await saveHostKey(result.host.id, await importAesKey(syncBytes));
      onPaired();
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "配对失败");
    } finally { setLoading(false); }
  }

  return <div className="modal-backdrop"><section className="modal">
    <button className="modal-close" onClick={onClose}>×</button><p className="eyebrow">PAIR A HOST</p><h2>连接 Windows 代理</h2>
    {!info ? <><p>在电脑端 AnytimeVibe 托盘窗口生成六位配对码。</p><input className="pair-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} placeholder="000000" /><button className="primary" disabled={code.length !== 6 || loading} onClick={inspect}>{loading ? "查询中…" : "检查配对码"}</button></> : <div className="pair-preview"><span className="computer-icon">▣</span><h3>{info.agentName}</h3><p>{info.platform} · {info.codexVersion}</p><button className="primary" disabled={loading} onClick={claim}>{loading ? "正在交换密钥…" : "确认并连接"}</button></div>}
    {error && <p className="form-error">{error}</p>}
  </section></div>;
}

function NewTaskDialog({ host, workspaces, onClose, onCreate }: { host: Host; workspaces: Workspace[]; onClose(): void; onCreate(cwd: string, prompt: string, title: string): Promise<void> }) {
  const [cwd, setCwd] = useState(workspaces[0]?.path ?? "");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  return <div className="modal-backdrop"><form className="modal wide" onSubmit={async (event) => { event.preventDefault(); setLoading(true); setError(""); try { await onCreate(cwd, prompt, title); } catch (createError) { setError(createError instanceof Error ? createError.message : "任务创建失败"); setLoading(false); } }}>
    <button type="button" className="modal-close" onClick={onClose}>×</button><p className="eyebrow">NEW REMOTE TASK</p><h2>向 {host.name} 下发任务</h2>
    <label>工作区<select value={cwd} onChange={(event) => setCwd(event.target.value)} required><option value="" disabled>电脑端尚未添加白名单目录</option>{workspaces.map((workspace) => <option key={workspace.id} value={workspace.path}>{workspace.name} · {workspace.path}</option>)}</select></label>
    <label>任务标题<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可选，默认使用第一条指令" /></label>
    <label>给 Codex 的指令<textarea className="task-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述目标、约束和验收方式…" required /></label>
    {error && <p className="form-error">{error}</p>}<button className="primary" disabled={loading || !cwd || !prompt.trim()}>{loading ? "正在发送…" : "开始任务"}</button>
  </form></div>;
}

async function subscribePush(vapidPublicKey: string | null): Promise<void> {
  if (!vapidPublicKey) throw new Error("服务端尚未配置 Web Push 密钥。");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("当前浏览器不支持 Web Push。");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("通知权限未授予。");
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: (() => {
      const bytes = base64ToBytes(vapidPublicKey);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    })()
  });
  await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join("/") || path;
}
