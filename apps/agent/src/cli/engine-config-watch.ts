import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

export type EngineConfigWatchHandlers = {
  /**
   * Codex credential files changed — long-lived app-server must reload.
   * (Codex is the only engine that caches config.toml/auth.json in-process.)
   */
  onCodexCredentialChanged: (reason: string) => void;
  /**
   * Headless engines (Claude / Grok / Cursor / Antigravity) credential files changed.
   * No process restart needed: the next turn re-spawns and re-reads disk.
   * Caller should refresh UI capabilities / host status.
   */
  onHeadlessCredentialChanged: (reason: string) => void;
  /** Model catalogs / settings changed — refresh UI capabilities. */
  onCapabilitySourcesChanged: (reason: string) => void;
};

/**
 * Watch CLI config/auth files written by Cockpit / CCSwitch / Grok Build etc.
 * Debounced so atomic rewrite (write tmp + rename) collapses to one callback.
 */
export function startEngineConfigWatch(handlers: EngineConfigWatchHandlers): () => void {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(home, ".codex");
  const grokHome = process.env.GROK_HOME?.trim() || path.join(home, ".grok");
  const claudeHome = path.join(home, ".claude");
  const cursorHome = path.join(home, ".cursor");
  const antigravityHome = path.join(home, ".gemini", "antigravity-cli");

  const codexCredentialFiles = new Set([
    path.join(codexHome, "auth.json"),
    path.join(codexHome, "config.toml"),
    path.join(codexHome, ".cockpit_codex_auth.json")
  ].map((p) => path.normalize(p).toLowerCase()));

  // Headless CLIs re-read these on every turn spawn — still watch so UI + logs stay in sync.
  const headlessCredentialFiles = new Set([
    path.join(claudeHome, "settings.json"),
    path.join(grokHome, "auth.json"),
    path.join(grokHome, "config.toml"),
    path.join(cursorHome, "cli-config.json"),
    path.join(antigravityHome, "settings.json"),
    // Antigravity OAuth / session blob (CCSwitch / interactive login may rewrite).
    path.join(antigravityHome, "jetski_state.pbtxt")
  ].map((p) => path.normalize(p).toLowerCase()));

  const capabilityFiles = new Set([
    path.join(codexHome, "models_cache.json"),
    path.join(codexHome, "cockpit-local-access-model-catalog.json"),
    path.join(codexHome, "cc-switch-model-catalog.json"),
    path.join(codexHome, "config.toml"),
    path.join(grokHome, "models_cache.json"),
    path.join(grokHome, "config.toml"),
    path.join(grokHome, "auth.json"),
    path.join(claudeHome, "settings.json"),
    path.join(cursorHome, "cli-config.json"),
    path.join(antigravityHome, "settings.json")
  ].map((p) => path.normalize(p).toLowerCase()));

  const watchDirs = [codexHome, grokHome, claudeHome, cursorHome, antigravityHome];
  const watchers: FSWatcher[] = [];
  let codexCredentialTimer: ReturnType<typeof setTimeout> | null = null;
  let headlessCredentialTimer: ReturnType<typeof setTimeout> | null = null;
  let capabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCodexCredentialReason = "";
  let lastHeadlessCredentialReason = "";
  let lastCapabilityReason = "";
  let stopped = false;

  const scheduleCodexCredential = (reason: string) => {
    lastCodexCredentialReason = reason;
    if (codexCredentialTimer) clearTimeout(codexCredentialTimer);
    codexCredentialTimer = setTimeout(() => {
      codexCredentialTimer = null;
      if (stopped) return;
      handlers.onCodexCredentialChanged(lastCodexCredentialReason);
    }, 800);
    codexCredentialTimer.unref?.();
  };

  const scheduleHeadlessCredential = (reason: string) => {
    lastHeadlessCredentialReason = reason;
    if (headlessCredentialTimer) clearTimeout(headlessCredentialTimer);
    headlessCredentialTimer = setTimeout(() => {
      headlessCredentialTimer = null;
      if (stopped) return;
      handlers.onHeadlessCredentialChanged(lastHeadlessCredentialReason);
    }, 800);
    headlessCredentialTimer.unref?.();
  };

  const scheduleCapability = (reason: string) => {
    lastCapabilityReason = reason;
    if (capabilityTimer) clearTimeout(capabilityTimer);
    capabilityTimer = setTimeout(() => {
      capabilityTimer = null;
      if (stopped) return;
      handlers.onCapabilitySourcesChanged(lastCapabilityReason);
    }, 1_200);
    capabilityTimer.unref?.();
  };

  for (const dir of watchDirs) {
    try {
      const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (!filename) return;
        const full = path.normalize(path.join(dir, filename.toString())).toLowerCase();
        const base = path.basename(full);
        // Ignore noisy sqlite / tmp / bak churn.
        if (/\.(sqlite|sqlite-wal|sqlite-shm|tmp|bak|log)$/i.test(base)) return;
        if (base.startsWith("..") || base.endsWith(".bak")) return;

        const label = `${path.basename(dir)}/${base}`;
        if (codexCredentialFiles.has(full)) {
          scheduleCodexCredential(label);
        }
        if (headlessCredentialFiles.has(full)) {
          scheduleHeadlessCredential(label);
        }
        if (capabilityFiles.has(full)) {
          scheduleCapability(label);
        }
      });
      watcher.on("error", () => undefined);
      watchers.push(watcher);
    } catch {
      // Directory may not exist yet (engine not installed).
    }
  }

  return () => {
    stopped = true;
    if (codexCredentialTimer) clearTimeout(codexCredentialTimer);
    if (headlessCredentialTimer) clearTimeout(headlessCredentialTimer);
    if (capabilityTimer) clearTimeout(capabilityTimer);
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
  };
}
