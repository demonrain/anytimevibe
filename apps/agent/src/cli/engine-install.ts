import type { CliEngine } from "@anytimevibe/protocol";
import type { EngineUpgradeStep } from "./engine-upgrade";

export type EngineInstallTarget = {
  engine: CliEngine;
  platform: NodeJS.Platform;
  npmCommand?: string;
  prefix?: string;
  registry?: string;
  nodeCommand?: string;
  repairScript?: string;
};

const NPM_PACKAGE_BY_ENGINE: Partial<Record<CliEngine, string>> = {
  codex: "@openai/codex",
  claude: "@anthropic-ai/claude-code",
  pi: "@earendil-works/pi-coding-agent"
};

const VENDOR_INSTALLERS: Record<"cursor" | "grok" | "antigravity", { win: string; mac: string }> = {
  cursor: { win: "https://cursor.com/install?win32=true", mac: "https://cursor.com/install" },
  grok: { win: "https://x.ai/cli/install.ps1", mac: "https://x.ai/cli/install.sh" },
  antigravity: { win: "https://antigravity.google/cli/install.ps1", mac: "https://antigravity.google/cli/install.sh" }
};

function npmSteps(target: EngineInstallTarget): EngineUpgradeStep[] {
  if (!target.npmCommand) throw new Error(`${target.engine} 远程安装需要先安装 Node.js 和 npm。`);
  const packageName = NPM_PACKAGE_BY_ENGINE[target.engine];
  if (!packageName) throw new Error(`${target.engine} 没有受支持的 npm 安装包。`);
  const registry = (target.registry || "https://registry.npmjs.org").replace(/\/+$/, "");
  const args = ["install", "-g", `--registry=${registry}/`];
  if (target.prefix?.trim()) args.push(`--prefix=${target.prefix.trim()}`);
  if (target.engine === "codex" && target.platform === "win32") args.push("--include=optional", "--bin-links=true");
  if (target.engine === "pi") args.push("--ignore-scripts");
  args.push(`${packageName}@latest`);
  const steps: EngineUpgradeStep[] = [{ command: target.npmCommand, args }];
  if (target.engine === "claude" && target.platform === "win32" && target.nodeCommand && target.repairScript) {
    steps.push({ command: target.nodeCommand, args: [target.repairScript] });
  }
  return steps;
}

function vendorSteps(engine: "cursor" | "grok" | "antigravity", platform: NodeJS.Platform): EngineUpgradeStep[] {
  const installer = VENDOR_INSTALLERS[engine];
  if (platform === "win32") {
    const url = installer.win;
    return [{
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ([scriptblock]::Create((Invoke-RestMethod -Uri '${url}'))) `]
    }];
  }
  if (platform === "darwin") {
    const url = installer.mac;
    return [{ command: "/bin/sh", args: ["-c", `curl -fsSL --connect-timeout 25 --max-time 300 '${url}' | bash`] }];
  }
  throw new Error(`${engine} 远程静默安装暂不支持 Linux，请在主机上使用官方安装方式。`);
}

export function buildEngineInstallSteps(target: EngineInstallTarget): EngineUpgradeStep[] {
  if (target.engine === "codex" || target.engine === "claude" || target.engine === "pi") return npmSteps(target);
  if (target.engine === "cursor" || target.engine === "grok" || target.engine === "antigravity") return vendorSteps(target.engine, target.platform);
  throw new Error(`${target.engine} 暂不支持远程安装。`);
}
