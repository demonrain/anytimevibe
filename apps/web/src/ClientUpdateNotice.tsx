import { compareSemver } from "@anytimevibe/protocol";

type ClientDownloads = { windows: string | null; mac: string | null };
type Locale = "en" | "zh-CN";
type DownloadLink = { platform: "windows" | "mac"; href: string; label: string };

const MANUAL_INSTALL_FIXED_VERSION = "0.5.26";

export function shouldRecommendManualClientInstall(clientVersion?: string | null, latestVersion?: string | null): boolean {
  return Boolean(clientVersion && latestVersion
    && compareSemver(clientVersion, MANUAL_INSTALL_FIXED_VERSION) < 0
    && compareSemver(latestVersion, MANUAL_INSTALL_FIXED_VERSION) >= 0);
}

export function clientUpdateAvailable(clientVersion?: string | null, latestVersion?: string | null): boolean {
  return Boolean(clientVersion && latestVersion && compareSemver(clientVersion, latestVersion) < 0);
}

export function getManualUpdateDownloadLinks(platform: string, downloads: ClientDownloads, locale: Locale): DownloadLink[] {
  const normalizedPlatform = platform.toLowerCase();
  const requestedPlatforms: DownloadLink["platform"][] = normalizedPlatform.includes("darwin") || normalizedPlatform.includes("mac")
    ? ["mac"]
    : normalizedPlatform.includes("win")
      ? ["windows"]
      : ["windows", "mac"];

  return requestedPlatforms.flatMap((target) => {
    const href = target === "windows" ? downloads.windows : downloads.mac;
    if (!href) return [];
    return [{
      platform: target,
      href,
      label: target === "windows"
        ? (locale === "en" ? "Download Windows installer" : "下载 Windows 安装包")
        : (locale === "en" ? "Download macOS installer" : "下载 macOS 安装包")
    }];
  });
}

export function clientUpdateButtonClassName(warn: boolean, outdated: boolean, panelOpen: boolean, updateActive: boolean): string {
  const classes = ["version-chip"];
  if (warn) classes.push("warn");
  if (outdated && !panelOpen && !updateActive) classes.push("update-attention");
  return classes.join(" ");
}

type ClientUpdateNoticeProps = {
  locale: Locale;
  clientVersion: string;
  latestVersion: string;
  platform: string;
  downloads: ClientDownloads;
  onDismiss(): void;
};

export function ClientUpdateNotice({
  locale, clientVersion, latestVersion, platform, downloads, onDismiss
}: ClientUpdateNoticeProps) {
  const en = locale === "en";
  const links = getManualUpdateDownloadLinks(platform, downloads, locale);

  return <div className="client-update-banner client-update-banner-manual" role="status" aria-live="polite">
    <div className="client-update-banner-copy">
      <strong>{en ? "One-time manual client update required" : "旧版客户端需要手动更新"}</strong>
      <span>{en
        ? `Client v${clientVersion} predates the v${MANUAL_INSTALL_FIXED_VERSION} installer fix and may fail to update in-app. Download and run the latest installer v${latestVersion}, then reconnect.`
        : `当前客户端 v${clientVersion} 早于 v${MANUAL_INSTALL_FIXED_VERSION} 安装修复版，内置升级可能失败。请下载并运行最新版 v${latestVersion} 安装包，然后重新连接。`}</span>
    </div>
    {links.length > 0
      ? <div className="client-update-banner-downloads">
        {links.map((link) => <a key={link.platform} href={link.href}>{link.label}</a>)}
      </div>
      : <span className="client-update-banner-unavailable">{en
        ? "No installer is currently available for this platform."
        : "当前平台的安装包暂不可用。"}</span>}
    <button
      type="button"
      className="client-update-banner-close"
      aria-label={en ? "Dismiss" : "关闭"}
      title={en ? "Dismiss" : "关闭"}
      onClick={onDismiss}
    >×</button>
  </div>;
}
