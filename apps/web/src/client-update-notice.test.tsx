import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ClientUpdateNotice,
  clientUpdateAvailable,
  clientUpdateButtonClassName,
  getManualUpdateDownloadLinks,
  shouldRecommendManualClientInstall
} from "./ClientUpdateNotice";

const downloads = {
  windows: "https://downloads.example.test/client.exe",
  mac: "https://downloads.example.test/client.dmg"
};

describe("manual client update notice", () => {
  it("requests a full installer only for clients older than the fixed installer baseline", () => {
    expect(shouldRecommendManualClientInstall("0.5.25", "0.5.26")).toBe(true);
    expect(shouldRecommendManualClientInstall("0.5.26", "0.5.27")).toBe(false);
    expect(shouldRecommendManualClientInstall("0.5.25", "0.5.25")).toBe(false);
    expect(shouldRecommendManualClientInstall(undefined, "0.5.27")).toBe(false);
    expect(clientUpdateAvailable("0.5.25", "0.5.26")).toBe(true);
    expect(clientUpdateAvailable("0.5.26", "0.5.26")).toBe(false);
    expect(clientUpdateAvailable(undefined, "0.5.27")).toBe(false);
  });

  it("selects only the installer matching the connected host platform", () => {
    expect(getManualUpdateDownloadLinks("win32", downloads, "zh-CN")).toEqual([
      { platform: "windows", href: downloads.windows, label: "下载 Windows 安装包" }
    ]);
    expect(getManualUpdateDownloadLinks("darwin", downloads, "zh-CN")).toEqual([
      { platform: "mac", href: downloads.mac, label: "下载 macOS 安装包" }
    ]);
    expect(getManualUpdateDownloadLinks("unknown", downloads, "zh-CN")).toHaveLength(2);
  });

  it("renders the manual-install announcement with the latest installer link", () => {
    const markup = renderToStaticMarkup(createElement(ClientUpdateNotice, {
      locale: "zh-CN",
      clientVersion: "0.5.25",
      latestVersion: "0.5.27",
      platform: "win32",
      downloads,
      onDismiss: () => undefined
    }));

    expect(markup).toContain('role="status"');
    expect(markup).toContain("v0.5.25");
    expect(markup).toContain("v0.5.27");
    expect(markup).toContain('href="https://downloads.example.test/client.exe"');
    expect(markup).not.toContain("client.dmg");
  });

  it("blinks the update button only while a new version needs attention", () => {
    expect(clientUpdateButtonClassName(true, true, false, false)).toBe("version-chip warn update-attention");
    expect(clientUpdateButtonClassName(true, true, true, false)).toBe("version-chip warn");
    expect(clientUpdateButtonClassName(true, true, false, true)).toBe("version-chip warn");
    expect(clientUpdateButtonClassName(true, false, false, false)).toBe("version-chip warn");
    expect(clientUpdateButtonClassName(false, false, false, false)).toBe("version-chip");
  });
});
