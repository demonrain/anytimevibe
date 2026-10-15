import { useEffect, useRef, useState } from "react";
import { randomUuid, type AgentEvent, type ClientCommand, type TaskDirectoryListing, type Workspace } from "@anytimevibe/protocol";
import { useI18n } from "./i18n/I18nProvider";

type DirectoryResult = Extract<AgentEvent, { type: "host.directory.listed" }>;
type PickResult = { commandId: string; path?: string; canceled?: boolean; error?: string };
type Pending = { commandId: string; type: "list" | "pick"; path?: string };

export function TaskDirectoryPicker({ value, onChange, online, supported, workspaces, listing, selection, onCommand }: {
  value: string;
  onChange(path: string): void;
  online: boolean | null;
  supported: boolean;
  workspaces: Workspace[];
  listing?: DirectoryResult;
  selection?: PickResult;
  onCommand(command: ClientCommand): Promise<void>;
}) {
  const { locale } = useI18n();
  const en = locale === "en";
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<TaskDirectoryListing>({ directories: [] });
  const [pending, setPending] = useState<Pending>();
  const pendingRef = useRef<Pending | undefined>(undefined);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const lastPath = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  function finishPending() {
    pendingRef.current = undefined;
    setPending(undefined);
  }

  async function request(type: Pending["type"], folderPath?: string) {
    if (online !== true) {
      setError(en ? "This computer is offline." : "电脑离线，连接后可浏览目录。");
      return;
    }
    const commandId = randomUuid();
    const next: Pending = { commandId, type, ...(folderPath ? { path: folderPath } : {}) };
    pendingRef.current = next;
    setPending(next);
    setError("");
    if (type === "list") lastPath.current = folderPath;
    try {
      await onCommand({ type: type === "list" ? "host.directory.list" : "host.directory.pick", commandId,
        ...(folderPath ? { path: folderPath } : {}) });
    } catch (failure) {
      if (!mounted.current || pendingRef.current?.commandId !== commandId) return;
      finishPending();
      setError(failure instanceof Error ? failure.message : (en ? "Unable to load folders." : "无法读取目录，请重试。"));
    }
  }

  useEffect(() => {
    if (!listing || pendingRef.current?.type !== "list" || listing.commandId !== pendingRef.current.commandId) return;
    setCurrent(listing);
    setFilter("");
    setError(listing.error || "");
    finishPending();
  }, [listing]);

  useEffect(() => {
    if (!selection || pendingRef.current?.type !== "pick" || selection.commandId !== pendingRef.current.commandId) return;
    finishPending();
    if (selection.path) void request("list", selection.path);
    else if (selection.error) setError(selection.error);
    // Cancelling a native OS grant leaves the web browser at the same directory.
  }, [selection]);

  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => {
      if (pendingRef.current?.commandId !== pending.commandId) return;
      finishPending();
      setError(en ? "The computer did not respond. Please retry." : "电脑暂未响应，请重试。");
    }, pending.type === "pick" ? 120_000 : 20_000);
    return () => clearTimeout(timer);
  }, [pending, en]);

  useEffect(() => {
    if (online === true || !pendingRef.current) return;
    finishPending();
    setError(en ? "This computer is offline." : "电脑已离线，连接后请重试。");
  }, [online, en]);

  if (!supported) return <label className="directory-picker-field">
    {en ? "Task directory" : "任务目录"}
    <select value={value} onChange={(event) => onChange(event.target.value)} required disabled={online !== true}>
      <option value="">{en ? "Choose a directory" : "选择目录"}</option>
      {workspaces.map((folder) => <option key={folder.id} value={folder.path}>{folder.path}</option>)}
    </select>
    <small>{en ? "Update the desktop client to browse any folder here." : "更新电脑客户端后，即可在这里浏览任意目录。"}</small>
  </label>;

  const canChoose = Boolean(current.path && !current.requiresAuthorization && !error && !pending && online === true);
  const matches = current.directories.filter((folder) => folder.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <section className="directory-picker-field" aria-label={en ? "Task directory" : "任务目录"}>
    <div className="directory-picker-head">
      <strong>{en ? "Task directory" : "任务目录"}</strong>
      <button type="button" className="secondary directory-picker-toggle" aria-expanded={open} disabled={online !== true} onClick={() => {
        if (open) setOpen(false);
        else { setOpen(true); void request("list", value || undefined); }
      }}>{open ? (en ? "Collapse" : "收起") : (en ? "Choose directory" : "选择目录")}</button>
    </div>
    <code className="directory-picker-value" dir="ltr" title={value}>{value || (en ? "No directory selected" : "尚未选择目录")}</code>
    {open && <div className="directory-browser">
      <div className="directory-browser-nav" role="toolbar" aria-label={en ? "Directory navigation" : "目录导航"}>
        <button type="button" className="secondary directory-nav-button" disabled={Boolean(pending) || online !== true} onClick={() => void request("list")}>
          {en ? "Computer" : "电脑目录"}
        </button>
        <button type="button" className="secondary directory-nav-button" disabled={!current.parentPath || Boolean(pending) || online !== true}
          onClick={() => void request("list", current.parentPath)}>{en ? "Up" : "上一级"}</button>
        <button type="button" className="secondary directory-nav-button" disabled={Boolean(pending) || online !== true}
          onClick={() => void request("list", lastPath.current)}>{en ? "Refresh" : "刷新"}</button>
      </div>
      <code className="directory-browser-path" dir="ltr">{current.path || (en ? "Recent folders and drives" : "最近目录与磁盘")}</code>
      {pending && <p role="status">{pending.type === "pick"
        ? (en ? "Approve folder access in the computer's dialog, then return here." : "请在电脑弹窗中授权目录访问，然后返回此页面。")
        : (en ? "Loading folders…" : "正在读取目录…")}</p>}
      {error && <div className="directory-browser-error" role="alert"><p>{error}</p>
        <button type="button" className="secondary" disabled={Boolean(pending) || online !== true}
          onClick={() => void request("list", lastPath.current)}>{en ? "Retry" : "重试"}</button>
      </div>}
      {!error && !pending && current.requiresAuthorization && <div className="directory-browser-grant">
        <p>{en ? "macOS requires folder access to be approved on this computer once." : "macOS 需要先在电脑上授权访问此目录，授权后可直接在网页选择。"}</p>
        <button type="button" className="secondary" disabled={online !== true}
          onClick={() => void request("pick", current.path)}>{en ? "Authorize on computer" : "在电脑上授权"}</button>
      </div>}
      {!error && !current.requiresAuthorization && <>
        {current.directories.length > 8 && <input aria-label={en ? "Filter folder names" : "筛选文件夹名称"}
          placeholder={en ? "Filter folder names" : "筛选文件夹名称"} value={filter}
          onChange={(event) => setFilter(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />}
        <div className="directory-browser-list" aria-busy={Boolean(pending)}>
          {matches.map((folder) => <button type="button" className="directory-browser-item" key={folder.path}
            disabled={Boolean(pending) || online !== true} onClick={() => void request("list", folder.path)}>
            <span className="directory-browser-icon" aria-hidden="true">▱</span>
            <span className="directory-browser-name"><strong>{folder.name}</strong>
              {!current.path && <code dir="ltr">{folder.path}</code>}</span>
            <span aria-hidden="true">›</span>
          </button>)}
          {!matches.length && !pending && <p className="directory-browser-empty">{en ? "No folders here. You can select this directory." : "没有子目录，可以选择当前目录。"}</p>}
        </div>
        {current.truncated && <small>{en ? "Showing the first 500 folders." : "显示前 500 个文件夹。"}</small>}
      </>}
      <button type="button" className="primary directory-browser-select" disabled={!canChoose} onClick={() => {
        onChange(current.path!); setOpen(false);
      }}>{en ? "Use this directory" : "选择当前目录"}</button>
    </div>}
  </section>;
}
