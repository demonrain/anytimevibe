import React, { useEffect, useRef } from "react";
import { compareSemver, type ClientCommand, type ClientUpdateState } from "@anytimevibe/protocol";

const CONFIRMATION_TIMEOUT_MS = 30_000;
const RECONNECT_TIMEOUT_MS = 5 * 60_000;

export type ClientUpdateAction = Extract<ClientCommand, { type: "host.client.update" }>["action"];
export type ClientUpdateRequest = {
  commandId: string;
  action: ClientUpdateAction;
  state: "sending" | "waiting" | "confirmed" | "unconfirmed" | "failed";
  sentAt: number;
  error?: string;
};

export function clientUpdateCommandCanSend(
  commandId: string,
  request: ClientUpdateRequest | undefined,
  online: boolean,
  now: number
): boolean {
  return online && request?.commandId === commandId && request.state === "sending"
    && now - request.sentAt < CONFIRMATION_TIMEOUT_MS;
}

export function reconcileClientUpdateRequest(
  request: ClientUpdateRequest,
  update: ClientUpdateState | undefined,
  commandError: string | undefined,
  now: number
): ClientUpdateRequest {
  if (update?.commandId === request.commandId) {
    const state = update.status === "error" ? "failed" : "confirmed";
    const error = state === "failed" ? (update.message || commandError) : undefined;
    if (request.state === state && request.error === error) return request;
    const next: ClientUpdateRequest = { ...request, state };
    if (error) next.error = error;
    else delete next.error;
    return next;
  }
  if (commandError) {
    return request.state === "failed" && request.error === commandError
      ? request
      : { ...request, state: "failed", error: commandError };
  }
  if ((request.state === "sending" || request.state === "waiting") && now - request.sentAt >= CONFIRMATION_TIMEOUT_MS) {
    return { ...request, state: "unconfirmed" };
  }
  return request;
}

export function clientUpdateIsActive(update: ClientUpdateState | undefined): boolean {
  return Boolean(update && (
    ["checking", "downloading", "waiting", "installing"].includes(update.status)
    || (update.status === "ready" && update.installWhenIdle)
  ));
}

function clientUpdateCompleted(update: ClientUpdateState, agentVersion: string | undefined): boolean {
  const actualVersion = agentVersion || update.currentVersion;
  return update.status === "completed" && Boolean(update.version && actualVersion)
    && compareSemver(actualVersion, update.version!) >= 0;
}

export function clientUpdateStatusLabel(
  update: ClientUpdateState | undefined,
  locale: "en" | "zh-CN",
  agentVersion?: string
): string {
  const en = locale === "en";
  if (!update?.supported) return en ? "Remote updates unavailable" : "尚不支持远程升级";
  switch (update.status) {
    case "idle": return en ? "No update pending" : "暂无待安装更新";
    case "checking": return en ? "Checking for updates…" : "正在检查更新…";
    case "available": return en ? "Update available" : "发现新版本";
    case "downloading": return en ? "Downloading in the background" : "正在后台下载";
    case "ready": return en ? "Download ready" : "更新已下载";
    case "waiting": return en ? "Waiting to install" : "等待任务结束后安装";
    case "installing": return en ? "Restarting client and reconnecting…" : "正在重启客户端并重新连接…";
    case "completed": return clientUpdateCompleted(update, agentVersion)
      ? (en ? "Update completed" : "升级完成")
      : (en ? "Confirming the running client version" : "正在确认客户端实际版本");
    case "error": return en ? "Update failed" : "升级失败";
  }
}

export function clientUpdateActions(
  update: ClientUpdateState | undefined,
  online: boolean,
  request: ClientUpdateRequest | undefined,
  now: number
): Record<ClientUpdateAction, boolean> {
  const currentRequest = request && reconcileClientUpdateRequest(request, update, undefined, now);
  const pending = currentRequest?.state === "sending" || currentRequest?.state === "waiting";
  const enabled = online && update?.supported === true && !pending;
  return {
    check: enabled && !clientUpdateIsActive(update),
    upgrade: enabled && Boolean(update?.version) && update?.installWhenIdle !== true
      && ["available", "ready", "downloading", "error"].includes(update?.status || ""),
    cancel: enabled && update?.installWhenIdle === true
      && ["available", "downloading", "ready", "waiting"].includes(update?.status || "")
  };
}

type ClientUpdatePanelProps = {
  hostName: string;
  locale: "en" | "zh-CN";
  online: boolean;
  update?: ClientUpdateState | undefined;
  agentVersion?: string | undefined;
  latestVersion?: string | null | undefined;
  downloads?: { windows: string | null; mac: string | null } | undefined;
  request?: ClientUpdateRequest | undefined;
  offlineAt?: number | undefined;
  now?: number;
  onAction(action: ClientUpdateAction): void | Promise<void>;
  onClose(): void;
};

export function ClientUpdatePanel({
  hostName, locale, online, update, agentVersion, latestVersion, downloads, request, offlineAt,
  now = Date.now(), onAction, onClose
}: ClientUpdatePanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    panel?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !panel) return;
      const controls = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const en = locale === "en";
  const supported = update?.supported === true;
  const currentRequest = request && reconcileClientUpdateRequest(request, update, undefined, now);
  const pending = currentRequest?.state === "sending" || currentRequest?.state === "waiting";
  const actions = clientUpdateActions(update, online, request, now);
  const actualVersion = agentVersion || update?.currentVersion;
  const offlineSince = offlineAt ?? (Date.parse(update?.updatedAt || "") || now);
  const reconnectTimedOut = !online && clientUpdateIsActive(update) && now - offlineSince >= RECONNECT_TIMEOUT_MS;
  const statusError = update?.status === "error";
  const progress = update?.progress == null ? undefined : Math.round(Math.max(0, Math.min(100, update.progress)));

  return <div className="modal-backdrop client-update-backdrop" role="presentation">
    <section ref={panelRef} tabIndex={-1} className="modal client-update-panel" role="dialog" aria-modal="true" aria-labelledby="client-update-title">
      <button type="button" className="modal-close" onClick={onClose} aria-label={en ? "Close" : "关闭"}>×</button>
      <p className="eyebrow">{en ? "DESKTOP CLIENT" : "桌面客户端"}</p>
      <h2 id="client-update-title">{en ? "Client updates" : "客户端升级"}</h2>
      <p className="client-update-host">{hostName}</p>
      <dl className="client-update-versions">
        <div><dt>{online ? (en ? "Running version" : "当前运行版本") : (en ? "Last reported version" : "最后上报版本")}</dt><dd>{actualVersion ? `v${actualVersion.replace(/^v/i, "")}` : (en ? "Unknown" : "未知")}</dd></div>
        <div><dt>{en ? "Target version" : "目标版本"}</dt><dd>{update?.version ? `v${update.version.replace(/^v/i, "")}` : (latestVersion ? `v${latestVersion.replace(/^v/i, "")}` : "—")}</dd></div>
      </dl>
      {!supported && <div className="client-update-notice warning" role="status">
        {en ? "Upgrade the desktop client manually to a version that supports remote updates first." : "请先在电脑上手动升级到支持远程更新的客户端版本。"}
      </div>}
      {supported && <div className={`client-update-state ${statusError ? "error" : ""}`} role={statusError ? "alert" : "status"} aria-live="polite">
        <strong>{reconnectTimedOut ? (en ? "Update result could not be confirmed" : "未能确认升级结果") : clientUpdateStatusLabel(update, locale, agentVersion)}</strong>
        {update?.message && <p>{reconnectTimedOut ? `${en ? "Last reported state" : "最后上报状态"}：${update.message}` : update.message}</p>}
        {update?.status === "waiting" && <p>{en
          ? "Waiting for running tasks, approvals, queued tasks and engine maintenance to finish."
          : "等待正在运行的任务、待审批操作、排队任务和编码引擎维护全部结束后安装。"}</p>}
        {update?.status === "installing" && !reconnectTimedOut && <p>{en ? "This page reconnects automatically after the client restarts." : "客户端重启后，网页会自动重新连接。"}</p>}
        {update?.status === "downloading" && <div className="client-update-download">
          <span>{progress == null ? (en ? "Downloading…" : "下载中…") : `${progress}%`}</span>
          <div className={`client-update-progress${progress == null && online ? " indeterminate" : ""}`} role="progressbar" aria-label={en ? "Client download progress" : "客户端更新下载进度"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: progress == null ? "35%" : `${progress}%` }} />
          </div>
          {!update.installWhenIdle && <p>{en ? "Automatic installation is canceled. The download can stay cached." : "已取消自动安装；下载可继续留作缓存。"}</p>}
        </div>}
        {statusError && <p>{en ? "The running version above is the version currently reported by the client. Check the details before retrying." : "上方运行版本为客户端当前上报的实际版本，请确认失败或旧版本恢复详情后重试。"}</p>}
      </div>}
      {!online && <div className={`client-update-notice ${reconnectTimedOut ? "error" : "warning"}`} role={reconnectTimedOut ? "alert" : "status"}>
        {reconnectTimedOut
          ? (en ? "The client has not reconnected after 5 minutes. Open the desktop client on the computer and check whether the previous version was restored; reconnect to confirm the result." : "客户端已超过 5 分钟未重新连接。请在电脑上打开客户端，检查是否已恢复旧版本，重新连接后确认升级结果。")
          : (en ? "Connection lost. Update state is retained; commands are disabled until the client is online." : "连接已断开，升级状态已保留；客户端重新上线后才能发送命令。")}
      </div>}
      {pending && <div className="client-update-notice" role="status">{currentRequest?.state === "sending"
        ? (en ? "Sending update request…" : "正在发送更新请求…")
        : (en ? "Waiting for client confirmation…" : "等待客户端确认…")}</div>}
      {currentRequest?.state === "unconfirmed" && <div className="client-update-notice warning" role="alert">{en
        ? "No matching client confirmation after 30 seconds. The command may still be running; check the client status before retrying."
        : "30 秒内未收到对应命令的客户端确认。命令可能仍在执行，请先检查客户端状态，再决定是否重试。"}</div>}
      {currentRequest?.state === "failed" && currentRequest.error && currentRequest.error !== update?.message && <div className="client-update-notice error" role="alert">{currentRequest.error}</div>}
      <div className="client-update-actions">
        <button type="button" disabled={!actions.check} onClick={() => void onAction("check")}>{en ? "Check for updates" : "检查更新"}</button>
        <button type="button" className="primary" disabled={!actions.upgrade} onClick={() => void onAction("upgrade")}>{en ? "Download and install when idle" : "后台下载并在空闲时安装"}</button>
        {update?.installWhenIdle && update.status !== "installing" && <button type="button" className="client-update-cancel" disabled={!actions.cancel} onClick={() => void onAction("cancel")}>{en ? "Cancel deferred install" : "取消延后安装"}</button>}
      </div>
      <p className="client-update-hint">{en
        ? "Downloads run in the background. Installation waits until all tasks and engine maintenance are finished. Canceling only removes the deferred installation intent. Downloaded files may remain cached."
        : "更新在后台下载，任务和编码引擎维护全部结束后才会安装。取消只撤销延后安装意图，已下载文件可以保留缓存。"}</p>
      {downloads && (downloads.windows || downloads.mac) && <div className="client-update-manual">
        <span>{en ? "Manual download" : "手动下载安装包"}</span>
        {downloads.windows && <a href={downloads.windows}>Windows</a>}
        {downloads.mac && <a href={downloads.mac}>macOS</a>}
      </div>}
    </section>
  </div>;
}
