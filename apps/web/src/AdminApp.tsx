import { useEffect, useState } from "react";
import { api } from "./api";

type SessionUser = { id: string; username: string; isAdmin: boolean };

type Overview = {
  stats: {
    users: number;
    activeUsers: number;
    disabledUsers: number;
    hosts: number;
    revokedHosts: number;
    onlineAgents: number;
    onlineClients: number;
    activeSessions: number;
    syncEvents: number;
    syncEvents24h: number;
    pushSubscriptions: number;
    pendingPairings: number;
  };
  policy: { registrationEnabled: boolean; maxUsers: number; source: { registration: string; maxUsers: string } };
  system: {
    publicOrigin: string;
    windowsClientUrl: string | null;
    macClientUrl: string | null;
    updateFeedUrl: string | null;
    vapidConfigured: boolean;
  };
};

type AdminUser = {
  id: string;
  username: string;
  isAdmin: boolean;
  disabledAt: string | null;
  note: string | null;
  createdAt: string;
  hostCount: number;
  sessionCount: number;
  lastLoginAt: string | null;
};

type AdminHost = {
  id: string;
  name: string;
  platform: string;
  codexVersion: string;
  agentVersion?: string | null;
  eventCount?: number;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  userId: string;
  username: string;
  online: boolean;
};

type AuditLog = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
  adminUsername: string | null;
};

type Tab = "overview" | "users" | "hosts" | "settings" | "audit";

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function ErrorBanner({ message, clear }: { message: string; clear(): void }) {
  return <button className="error-banner" onClick={clear}>{message}<span>关闭</span></button>;
}

export function AdminApp() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userQuery, setUserQuery] = useState("");
  const [userStatus, setUserStatus] = useState<"all" | "active" | "disabled">("all");
  const [hosts, setHosts] = useState<AdminHost[]>([]);
  const [hostTotal, setHostTotal] = useState(0);
  const [hostQuery, setHostQuery] = useState("");
  const [hostStatus, setHostStatus] = useState<"all" | "active" | "revoked" | "online" | "offline">("all");
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [settingsForm, setSettingsForm] = useState({ registrationEnabled: true, maxUsers: 100, useEnvRegistration: false, useEnvMaxUsers: false });
  const [busyId, setBusyId] = useState("");

  useEffect(() => {
    api<{ user: SessionUser }>("/api/auth/session")
      .then((session) => {
        if (!session.user.isAdmin) {
          setError("需要管理员权限");
          setLoading(false);
          return;
        }
        setUser(session.user);
        setLoading(false);
      })
      .catch(() => {
        setError("请先以管理员账号登录随码");
        setLoading(false);
      });
  }, []);

  async function loadOverview() {
    const data = await api<Overview>("/api/admin/overview");
    setOverview(data);
    setSettingsForm({
      registrationEnabled: data.policy.registrationEnabled,
      maxUsers: data.policy.maxUsers,
      useEnvRegistration: data.policy.source.registration === "env",
      useEnvMaxUsers: data.policy.source.maxUsers === "env"
    });
  }

  async function loadUsers() {
    const params = new URLSearchParams({
      page: "1",
      pageSize: "50",
      status: userStatus,
      ...(userQuery.trim() ? { q: userQuery.trim() } : {})
    });
    const data = await api<{ users: AdminUser[]; total: number }>(`/api/admin/users?${params}`);
    setUsers(data.users);
    setUserTotal(data.total);
  }

  async function loadHosts() {
    const params = new URLSearchParams({
      page: "1",
      pageSize: "50",
      status: hostStatus,
      ...(hostQuery.trim() ? { q: hostQuery.trim() } : {})
    });
    const data = await api<{ hosts: AdminHost[]; total: number }>(`/api/admin/hosts?${params}`);
    setHosts(data.hosts);
    setHostTotal(data.total);
  }

  async function loadAudit() {
    const data = await api<{ logs: AuditLog[] }>("/api/admin/audit?page=1&pageSize=50");
    setLogs(data.logs);
  }

  useEffect(() => {
    if (!user) return;
    const load = async () => {
      try {
        if (tab === "overview") await loadOverview();
        if (tab === "users") await loadUsers();
        if (tab === "hosts") await loadHosts();
        if (tab === "settings") {
          await loadOverview();
          const settings = await api<{
            policy: Overview["policy"];
            overrides: { registrationEnabled: boolean | null; maxUsers: number | null };
            env: { registrationEnabled: boolean; maxUsers: number };
          }>("/api/admin/settings");
          setSettingsForm({
            registrationEnabled: settings.policy.registrationEnabled,
            maxUsers: settings.policy.maxUsers,
            useEnvRegistration: settings.overrides.registrationEnabled === null,
            useEnvMaxUsers: settings.overrides.maxUsers === null
          });
        }
        if (tab === "audit") await loadAudit();
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "加载失败");
      }
    };
    void load();
  }, [user, tab, userStatus, hostStatus]);

  async function runAction(id: string, action: () => Promise<void>) {
    setBusyId(id);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "操作失败");
    } finally {
      setBusyId("");
    }
  }

  if (loading) {
    return <main className="loading-screen"><div className="pulse" /><p>正在打开管理后台…</p></main>;
  }

  if (!user) {
    return <main className="auth-shell admin-gate">
      {error && <ErrorBanner message={error} clear={() => setError("")} />}
      <section className="auth-card">
        <div className="mark" aria-hidden="true"><img src="/icon.svg" alt="" /></div>
        <h2>管理后台</h2>
        <p>请先使用管理员账号登录随码工作台，再访问此页面。</p>
        <a className="primary admin-link-btn" href="/">前往登录</a>
      </section>
    </main>;
  }

  return <div className="admin-shell">
    {error && <ErrorBanner message={error} clear={() => setError("")} />}
    <aside className="admin-rail">
      <div className="admin-brand">
        <img src="/icon.svg" alt="" />
        <div><strong>随码管理台</strong><small>{user.username}</small></div>
      </div>
      <nav className="admin-nav">
        {([
          ["overview", "总览"],
          ["users", "用户"],
          ["hosts", "主机"],
          ["settings", "策略"],
          ["audit", "审计"]
        ] as const).map(([id, label]) => (
          <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>
      <div className="admin-rail-foot">
        <a href="/">返回工作台</a>
      </div>
    </aside>

    <main className="admin-main">
      {tab === "overview" && overview && <>
        <header className="admin-header">
          <div><p className="eyebrow">DASHBOARD</p><h1>服务总览</h1></div>
          <button className="quiet" onClick={() => runAction("refresh", loadOverview)} disabled={busyId === "refresh"}>刷新</button>
        </header>
        <section className="admin-stat-grid">
          {[
            ["用户总数", overview.stats.users],
            ["活跃用户", overview.stats.activeUsers],
            ["停用用户", overview.stats.disabledUsers],
            ["主机总数", overview.stats.hosts],
            ["在线 Agent", overview.stats.onlineAgents],
            ["在线浏览器", overview.stats.onlineClients],
            ["有效会话", overview.stats.activeSessions],
            ["24h 密文事件", overview.stats.syncEvents24h],
            ["Push 订阅", overview.stats.pushSubscriptions],
            ["待确认配对", overview.stats.pendingPairings]
          ].map(([label, value]) => (
            <article key={String(label)} className="admin-stat-card">
              <span>{label}</span>
              <strong>{value}</strong>
            </article>
          ))}
        </section>
        <section className="admin-panel-grid">
          <article className="admin-panel">
            <h2>注册策略</h2>
            <p>开放注册：<b>{overview.policy.registrationEnabled ? "开启" : "关闭"}</b>（{overview.policy.source.registration === "env" ? "环境变量" : "后台覆盖"}）</p>
            <p>用户上限：<b>{overview.policy.maxUsers}</b>（{overview.policy.source.maxUsers === "env" ? "环境变量" : "后台覆盖"}）</p>
          </article>
          <article className="admin-panel">
            <h2>系统配置</h2>
            <p>公网地址：<code>{overview.system.publicOrigin}</code></p>
            <p>Web Push：<b>{overview.system.vapidConfigured ? "已配置" : "未配置"}</b></p>
            <p>更新源：<code>{overview.system.updateFeedUrl || "未配置"}</code></p>
            <p>Windows：<code>{overview.system.windowsClientUrl || "—"}</code></p>
            <p>macOS：<code>{overview.system.macClientUrl || "—"}</code></p>
          </article>
        </section>
      </>}

      {tab === "users" && <>
        <header className="admin-header">
          <div><p className="eyebrow">USERS</p><h1>用户管理</h1><small>共 {userTotal} 人</small></div>
          <div className="admin-toolbar">
            <input value={userQuery} onChange={(event) => setUserQuery(event.target.value)} placeholder="搜索用户名" />
            <select value={userStatus} onChange={(event) => setUserStatus(event.target.value as typeof userStatus)}>
              <option value="all">全部</option>
              <option value="active">活跃</option>
              <option value="disabled">已停用</option>
            </select>
            <button className="quiet" onClick={() => runAction("users", loadUsers)}>查询</button>
          </div>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>状态</th>
                <th>主机</th>
                <th>会话</th>
                <th>最近登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {users.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>{item.username}</strong>
                    {item.note && <small className="admin-note">{item.note}</small>}
                  </td>
                  <td>{item.isAdmin ? <span className="pill admin">管理员</span> : <span className="pill">用户</span>}</td>
                  <td>{item.disabledAt ? <span className="pill danger">已停用</span> : <span className="pill ok">正常</span>}</td>
                  <td>{item.hostCount}</td>
                  <td>{item.sessionCount}</td>
                  <td>{formatTime(item.lastLoginAt)}</td>
                  <td className="admin-actions">
                    <button disabled={busyId === item.id} onClick={() => runAction(item.id, async () => {
                      const note = window.prompt("备注（可空）", item.note ?? "") ?? undefined;
                      if (note === undefined) return;
                      await api(`/api/admin/users/${item.id}`, { method: "PATCH", body: JSON.stringify({ note: note || null }) });
                      await loadUsers();
                    })}>备注</button>
                    <button disabled={busyId === item.id} onClick={() => runAction(item.id, async () => {
                      await api(`/api/admin/users/${item.id}`, { method: "PATCH", body: JSON.stringify({ isAdmin: !item.isAdmin }) });
                      await loadUsers();
                    })}>{item.isAdmin ? "取消管理员" : "设为管理员"}</button>
                    <button disabled={busyId === item.id} onClick={() => runAction(item.id, async () => {
                      await api(`/api/admin/users/${item.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !item.disabledAt }) });
                      await loadUsers();
                    })}>{item.disabledAt ? "启用" : "停用"}</button>
                    <button disabled={busyId === item.id} onClick={() => runAction(item.id, async () => {
                      await api(`/api/admin/users/${item.id}/sessions/revoke`, { method: "POST" });
                      await loadUsers();
                    })}>强制下线</button>
                    <button disabled={busyId === item.id} onClick={() => runAction(item.id, async () => {
                      const password = window.prompt("输入新密码（至少 6 位）");
                      if (!password) return;
                      await api(`/api/admin/users/${item.id}`, { method: "PATCH", body: JSON.stringify({ password }) });
                      window.alert("密码已重置，该用户所有会话已失效");
                      await loadUsers();
                    })}>重置密码</button>
                    <button className="danger" disabled={busyId === item.id || item.id === user.id} onClick={() => runAction(item.id, async () => {
                      if (!window.confirm(`确定删除用户 ${item.username}？其主机与同步密文将一并删除。`)) return;
                      await api(`/api/admin/users/${item.id}`, { method: "DELETE" });
                      await loadUsers();
                    })}>删除</button>
                  </td>
                </tr>
              ))}
              {!users.length && <tr><td colSpan={7} className="admin-empty">没有匹配的用户</td></tr>}
            </tbody>
          </table>
        </div>
      </>}

      {tab === "hosts" && <>
        <header className="admin-header">
          <div><p className="eyebrow">HOSTS</p><h1>主机管理</h1><small>共 {hostTotal} 台</small></div>
          <div className="admin-toolbar">
            <input value={hostQuery} onChange={(event) => setHostQuery(event.target.value)} placeholder="搜索主机 / 用户 / 客户端版本" />
            <select value={hostStatus} onChange={(event) => setHostStatus(event.target.value as typeof hostStatus)}>
              <option value="all">全部</option>
              <option value="active">有效</option>
              <option value="online">在线</option>
              <option value="offline">离线</option>
              <option value="revoked">已撤销</option>
            </select>
            <button className="quiet" onClick={() => runAction("hosts", loadHosts)}>查询</button>
            <button className="quiet" disabled={busyId === "cleanup-pairings"} onClick={() => runAction("cleanup-pairings", async () => {
              if (!window.confirm("清理过期/失败的配对记录？")) return;
              const result = await api<{ deleted: number }>("/api/admin/pairings/cleanup", { method: "POST", body: "{}" });
              window.alert(`已清理 ${result.deleted} 条配对记录`);
            })}>清理配对垃圾</button>
            <button className="danger" disabled={busyId === "cleanup-revoked"} onClick={() => runAction("cleanup-revoked", async () => {
              if (!window.confirm("永久删除全部「已撤销」主机及其密文事件？此操作不可恢复。")) return;
              const result = await api<{ deleted: number }>("/api/admin/hosts/cleanup-revoked", {
                method: "POST",
                body: JSON.stringify({ olderThanDays: 0 })
              });
              window.alert(`已删除 ${result.deleted} 台已撤销主机`);
              await loadHosts();
            })}>清理已撤销主机</button>
          </div>
        </header>
        <p className="admin-hint" style={{ margin: "0 0 12px" }}>
          「客户端」列为桌面 Agent 上报的版本（上线后自动同步）。「撤销」仅禁用配对；「删除」永久移除主机与同步密文，用于清理错误/测试数据。
        </p>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>主机</th>
                <th>用户</th>
                <th>平台</th>
                <th>状态</th>
                <th>客户端</th>
                <th>Codex</th>
                <th>事件数</th>
                <th>最近在线</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {hosts.map((host) => (
                <tr key={host.id}>
                  <td><strong>{host.name}</strong><small className="admin-note">{host.id.slice(0, 8)}</small></td>
                  <td>{host.username}</td>
                  <td>{host.platform}</td>
                  <td>
                    {host.revokedAt
                      ? <span className="pill danger">已撤销</span>
                      : host.online
                        ? <span className="pill ok">在线</span>
                        : <span className="pill">离线</span>}
                  </td>
                  <td>
                    {host.agentVersion
                      ? <code>v{String(host.agentVersion).replace(/^v/i, "")}</code>
                      : <span className="admin-note">未上报</span>}
                  </td>
                  <td>{host.codexVersion || "—"}</td>
                  <td>{host.eventCount ?? 0}</td>
                  <td>{formatTime(host.lastSeenAt)}</td>
                  <td className="admin-actions">
                    <button disabled={Boolean(host.revokedAt) || busyId === host.id} onClick={() => runAction(host.id, async () => {
                      await api(`/api/admin/hosts/${host.id}/disconnect`, { method: "POST" });
                      await loadHosts();
                    })}>断开</button>
                    <button disabled={busyId === host.id} onClick={() => runAction(host.id, async () => {
                      if (!window.confirm(`清空主机「${host.name}」的全部同步密文事件？主机记录会保留。`)) return;
                      const result = await api<{ deleted: number }>(`/api/admin/hosts/${host.id}/purge-events`, { method: "POST" });
                      window.alert(`已删除 ${result.deleted} 条事件`);
                      await loadHosts();
                    })}>清空事件</button>
                    <button className="danger" disabled={Boolean(host.revokedAt) || busyId === host.id} onClick={() => runAction(host.id, async () => {
                      if (!window.confirm(`确定撤销主机「${host.name}」？用户将无法再连接该主机。`)) return;
                      await api(`/api/admin/hosts/${host.id}/revoke`, { method: "POST" });
                      await loadHosts();
                    })}>撤销</button>
                    <button className="danger" disabled={busyId === host.id} onClick={() => runAction(host.id, async () => {
                      if (!window.confirm(`永久删除主机「${host.name}」及其密文事件？此操作不可恢复。`)) return;
                      await api(`/api/admin/hosts/${host.id}`, { method: "DELETE" });
                      await loadHosts();
                    })}>删除</button>
                  </td>
                </tr>
              ))}
              {!hosts.length && <tr><td colSpan={9} className="admin-empty">没有匹配的主机</td></tr>}
            </tbody>
          </table>
        </div>
      </>}

      {tab === "settings" && <>
        <header className="admin-header">
          <div><p className="eyebrow">POLICY</p><h1>注册与容量策略</h1></div>
        </header>
        <section className="admin-panel settings-panel">
          <label className="admin-check">
            <input
              type="checkbox"
              checked={!settingsForm.useEnvRegistration}
              onChange={(event) => setSettingsForm((current) => ({ ...current, useEnvRegistration: !event.target.checked }))}
            />
            使用后台覆盖「开放注册」
          </label>
          <label className="admin-check">
            <input
              type="checkbox"
              disabled={settingsForm.useEnvRegistration}
              checked={settingsForm.registrationEnabled}
              onChange={(event) => setSettingsForm((current) => ({ ...current, registrationEnabled: event.target.checked }))}
            />
            允许新用户注册
          </label>
          <label className="admin-check">
            <input
              type="checkbox"
              checked={!settingsForm.useEnvMaxUsers}
              onChange={(event) => setSettingsForm((current) => ({ ...current, useEnvMaxUsers: !event.target.checked }))}
            />
            使用后台覆盖「用户上限」
          </label>
          <label>
            用户上限
            <input
              type="number"
              min={1}
              disabled={settingsForm.useEnvMaxUsers}
              value={settingsForm.maxUsers}
              onChange={(event) => setSettingsForm((current) => ({ ...current, maxUsers: Number(event.target.value) || 1 }))}
            />
          </label>
          <p className="admin-hint">取消覆盖后将回退到服务端环境变量 `REGISTRATION_ENABLED` / `MAX_USERS`。客户端下载地址与更新源仍由部署环境变量控制。</p>
          <button className="primary" disabled={busyId === "settings"} onClick={() => runAction("settings", async () => {
            await api("/api/admin/settings", {
              method: "PATCH",
              body: JSON.stringify({
                registrationEnabled: settingsForm.useEnvRegistration ? null : settingsForm.registrationEnabled,
                maxUsers: settingsForm.useEnvMaxUsers ? null : settingsForm.maxUsers
              })
            });
            await loadOverview();
            window.alert("策略已保存");
          })}>保存策略</button>
        </section>
      </>}

      {tab === "audit" && <>
        <header className="admin-header">
          <div><p className="eyebrow">AUDIT</p><h1>操作审计</h1></div>
          <button className="quiet" onClick={() => runAction("audit", loadAudit)}>刷新</button>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>管理员</th>
                <th>动作</th>
                <th>对象</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>{formatTime(log.createdAt)}</td>
                  <td>{log.adminUsername || "—"}</td>
                  <td><code>{log.action}</code></td>
                  <td>{log.targetType || "—"}{log.targetId ? ` · ${String(log.targetId).slice(0, 12)}` : ""}</td>
                  <td><code className="admin-json">{log.detail ? JSON.stringify(log.detail) : "—"}</code></td>
                </tr>
              ))}
              {!logs.length && <tr><td colSpan={5} className="admin-empty">暂无审计记录</td></tr>}
            </tbody>
          </table>
        </div>
      </>}
    </main>
  </div>;
}
