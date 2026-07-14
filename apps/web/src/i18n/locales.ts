export type Locale = "zh-CN" | "en";

export const LOCALE_STORAGE_KEY = "anytimevibe-locale";

export const messages = {
  "zh-CN": {
    brand: "随码",
    brandTag: "随时续上你的代码",
    notify: "开启通知",
    logout: "退出登录",
    admin: "管理后台",
    remoteHosts: "远程主机",
    addComputer: "＋ 添加电脑",
    connectFirst: "连接第一台电脑",
    clients: "‹ 客户端",
    taskStream: "任务流",
    noHost: "尚未连接主机",
    syncTasks: "同步任务",
    syncing: "同步中…",
    newTask: "新任务",
    hostOnline: "主机在线，命令将立即执行",
    hostOffline: "主机离线，仅可查看已同步记录",
    hostChecking: "正在确认主机状态…",
    searchTasks: "搜索任务标题 / 内容 / 路径",
    noTasks: "等待第一条远程任务",
    noTasksHint: "选择白名单工作区，向本机 Codex 下发任务。",
    noMatch: "没有匹配任务",
    noMatchHint: "换个关键词试试标题、路径或对话内容。",
    pickTask: "选择一个任务",
    pickTaskHint: "这里会显示对话、执行状态、审批和最新 Diff。",
    codexPermission: "Codex 权限",
    permReadOnly: "Read Only",
    permAsk: "Ask for approval",
    permApprove: "Approve for me",
    permFull: "Full Access",
    chat: "对话",
    diff: "Diff",
    send: "发送",
    stop: "结束等待",
    currentPermission: "当前权限",
    sendShortcut: "发送",
    processing: "远程主机正在处理",
    processingHint: "Codex 正在电脑端执行；阶段日志与回复会实时流式同步。",
    queue: "等待队列",
    actionRequired: "需要操作",
    allowOnce: "允许一次",
    decline: "拒绝",
    lang: "语言",
    renameHost: "重命名",
    deleteHost: "删除",
    desktopClients: "桌面客户端",
    personalSpace: "个人空间",
    administrator: "管理员"
  },
  en: {
    brand: "AnytimeVibe",
    brandTag: "Pick up your code anytime",
    notify: "Enable notifications",
    logout: "Log out",
    admin: "Admin",
    remoteHosts: "Remote hosts",
    addComputer: "+ Add computer",
    connectFirst: "Connect your first computer",
    clients: "‹ Clients",
    taskStream: "Task stream",
    noHost: "No host connected",
    syncTasks: "Sync tasks",
    syncing: "Syncing…",
    newTask: "New task",
    hostOnline: "Host online — commands run immediately",
    hostOffline: "Host offline — synced history only",
    hostChecking: "Checking host status…",
    searchTasks: "Search title / content / path",
    noTasks: "Waiting for the first remote task",
    noTasksHint: "Pick a allowlisted workspace and send a task to local Codex.",
    noMatch: "No matching tasks",
    noMatchHint: "Try another keyword in title, path, or messages.",
    pickTask: "Select a task",
    pickTaskHint: "Conversation, status, approvals, and diffs appear here.",
    codexPermission: "Codex permission",
    permReadOnly: "Read Only",
    permAsk: "Ask for approval",
    permApprove: "Approve for me",
    permFull: "Full Access",
    chat: "Chat",
    diff: "Diff",
    send: "Send",
    stop: "Stop",
    currentPermission: "Permission",
    sendShortcut: "Send",
    processing: "Remote host is working",
    processingHint: "Stage logs and replies stream live while Codex runs.",
    queue: "Queue",
    actionRequired: "Action required",
    allowOnce: "Allow once",
    decline: "Decline",
    lang: "Language",
    renameHost: "Rename",
    deleteHost: "Delete",
    desktopClients: "Desktop clients",
    personalSpace: "Personal space",
    administrator: "Administrator"
  }
} as const;

export type MessageKey = keyof (typeof messages)["zh-CN"];

export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en") return stored;
  } catch {
    // ignore
  }
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function normalizePermissionMode(value: string | null | undefined): "read-only" | "ask-for-approval" | "approve-for-me" | "full-access" {
  if (value === "read-only" || value === "ask-for-approval" || value === "approve-for-me" || value === "full-access") return value;
  if (value === "workspace-write") return "ask-for-approval";
  if (value === "inherit") return "ask-for-approval";
  return "ask-for-approval";
}
