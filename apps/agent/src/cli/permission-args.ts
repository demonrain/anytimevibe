import type { CliEngine, PermissionMode } from "@anytimevibe/protocol";
import { codexPermissionParams } from "../codex-adapter";

export function normalizePermissionMode(mode: PermissionMode | undefined | null): PermissionMode {
  if (
    mode === "read-only"
    || mode === "ask-for-approval"
    || mode === "approve-for-me"
    || mode === "full-access"
  ) {
    return mode;
  }
  if (mode === "workspace-write") return "ask-for-approval";
  return "ask-for-approval";
}

/** Flags for non-interactive / headless remote turns (must not block on TTY prompts). */
export function headlessPermissionArgs(engine: CliEngine, mode: PermissionMode): string[] {
  const normalized = normalizePermissionMode(mode);
  if (engine === "claude") {
    if (normalized === "full-access") {
      return ["--permission-mode", "bypassPermissions", "--dangerously-skip-permissions"];
    }
    if (normalized === "read-only") {
      return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    }
    return ["--permission-mode", "acceptEdits", "--dangerously-skip-permissions"];
  }
  if (engine === "cursor") {
    const common = ["--trust", "--approve-mcps"];
    if (normalized === "read-only") {
      return ["--mode", "ask", ...common];
    }
    if (normalized === "full-access" || normalized === "approve-for-me") {
      return ["--force", ...common, "--sandbox", "disabled"];
    }
    return ["--force", ...common];
  }
  if (engine === "antigravity") {
    // agy headless has no TTY — tool Ask prompts abort the -p run and the web
    // shows a premature "completed". Map UI modes to real CLI flags:
    //   --sandbox | --mode plan | --mode accept-edits | --dangerously-skip-permissions
    // Project / Shared / Global are /permissions config scopes, not session flags.
    if (normalized === "read-only") return ["--sandbox"];
    if (normalized === "ask-for-approval") return ["--mode", "plan"];
    // accept-edits alone still prompts on shell/MCP; skip so remote turns can finish.
    if (normalized === "approve-for-me") {
      return ["--mode", "accept-edits", "--dangerously-skip-permissions"];
    }
    return ["--dangerously-skip-permissions"];
  }
  if (engine === "codex") {
    // Codex remote path uses app-server RPC, not these CLI flags.
    return [];
  }
  // grok
  if (normalized === "read-only") {
    return ["--permission-mode", "dontAsk", "--tools", "read_file,grep,list_dir"];
  }
  return ["--always-approve"];
}

/**
 * Flags for interactive CLI handoff so the terminal reuses the web permission mode
 * instead of falling back to each engine's local defaults.
 */
export function handoffPermissionArgs(engine: CliEngine, mode: PermissionMode | undefined | null): string[] {
  const normalized = normalizePermissionMode(mode);
  if (engine === "codex") {
    const policy = codexPermissionParams(normalized);
    const args: string[] = [];
    if (policy.sandbox) args.push("--sandbox", policy.sandbox);
    if (policy.approvalPolicy) args.push("--ask-for-approval", policy.approvalPolicy);
    return args;
  }
  if (engine === "claude") {
    if (normalized === "full-access") {
      return ["--permission-mode", "bypassPermissions"];
    }
    if (normalized === "read-only") {
      return ["--permission-mode", "dontAsk", "--allowedTools", "Read,Glob,Grep"];
    }
    return ["--permission-mode", "acceptEdits"];
  }
  if (engine === "cursor") {
    const common = ["--trust"];
    if (normalized === "read-only") return ["--mode", "ask", ...common];
    if (normalized === "full-access" || normalized === "approve-for-me") {
      return ["--force", ...common, "--sandbox", "disabled"];
    }
    return ["--force", ...common];
  }
  if (engine === "antigravity") {
    if (normalized === "read-only") return ["--sandbox"];
    if (normalized === "ask-for-approval") return ["--mode", "plan"];
    if (normalized === "approve-for-me") return ["--mode", "accept-edits"];
    return ["--dangerously-skip-permissions"];
  }
  // grok
  if (normalized === "read-only") {
    return ["--permission-mode", "dontAsk", "--tools", "read_file,grep,list_dir"];
  }
  return ["--always-approve"];
}
