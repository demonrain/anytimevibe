import { spawn, type ChildProcess } from "node:child_process";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";

function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore"
      }).on("error", () => {
        try { child.kill(); } catch { /* ignore */ }
      });
      return;
    } catch {
      // fall through
    }
  }
  try { child.kill("SIGTERM"); } catch { /* ignore */ }
  setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }, 1_000);
}

/**
 * Run a CLI with timeout. On Windows:
 * - Prefer spawning `.exe` directly so Node's timeout targets the real process
 * - If cmd shim is required, taskkill /T on timeout so orphans (e.g. `agy models`) cannot linger
 */
export function execFileWithTreeKill(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
  }
): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = options.maxBuffer ?? 512_000;
  const useCmd = windowsNeedsCmdShim(command);
  const executable = useCmd ? (process.env.ComSpec ?? "cmd.exe") : command;
  const finalArgs = useCmd ? windowsCmdArguments(command, args) : args;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, finalArgs, {
      windowsHide: true,
      windowsVerbatimArguments: useCmd,
      env: options.env || process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ stdout, stderr });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      finish(Object.assign(new Error(`Command timed out after ${options.timeoutMs}ms`), {
        killed: true,
        code: null,
        signal: "SIGTERM",
        stdout,
        stderr
      }));
    }, Math.max(1_000, options.timeoutMs));

    const append = (bucket: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (bucket === "stdout") {
        stdout += text;
        if (stdout.length > maxBuffer) stdout = stdout.slice(0, maxBuffer);
      } else {
        stderr += text;
        if (stderr.length > maxBuffer) stderr = stderr.slice(0, maxBuffer);
      }
    };

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (timedOut) return;
      if (code && code !== 0) {
        finish(Object.assign(new Error(`Command failed with exit code ${code}`), {
          code,
          signal,
          stdout,
          stderr,
          killed: false
        }));
        return;
      }
      finish();
    });
  });
}
