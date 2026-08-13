import { watch, type FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";

export type EngineConfigWatchHandlers = {
  /** auth.json / config.toml changed — Codex app-server must reload to pick up new account. */
  onCodexCredentialChanged: (reason: string) => void;
  /** Model catalogs / Claude settings / Grok cache changed — refresh UI capabilities. */
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

  const credentialFiles = new Set([
    path.join(codexHome, "auth.json"),
    path.join(codexHome, "config.toml"),
    path.join(codexHome, ".cockpit_codex_auth.json")
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
    path.join(cursorHome, "cli-config.json")
  ].map((p) => path.normalize(p).toLowerCase()));

  const watchDirs = [codexHome, grokHome, claudeHome, cursorHome];
  const watchers: FSWatcher[] = [];
  let credentialTimer: ReturnType<typeof setTimeout> | null = null;
  let capabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let lastCredentialReason = "";
  let lastCapabilityReason = "";
  let stopped = false;

  const scheduleCredential = (reason: string) => {
    lastCredentialReason = reason;
    if (credentialTimer) clearTimeout(credentialTimer);
    credentialTimer = setTimeout(() => {
      credentialTimer = null;
      if (stopped) return;
      handlers.onCodexCredentialChanged(lastCredentialReason);
    }, 800);
    credentialTimer.unref?.();
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

        if (credentialFiles.has(full)) {
          scheduleCredential(`${path.basename(dir)}/${base}`);
        }
        if (capabilityFiles.has(full)) {
          scheduleCapability(`${path.basename(dir)}/${base}`);
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
    if (credentialTimer) clearTimeout(credentialTimer);
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
