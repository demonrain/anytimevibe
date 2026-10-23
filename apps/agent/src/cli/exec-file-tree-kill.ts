import { spawn, type ChildProcess } from "node:child_process";
import { windowsCmdArguments, windowsNeedsCmdShim } from "../windows-command";

export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    try { child.kill(); } catch { /* ignore */ }
    return;
  }
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (fallback: boolean) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (fallback) try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      };
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        killer.once("error", () => done(true));
        killer.once("close", (code) => done(code !== 0));
        timer = setTimeout(() => {
          try { killer.kill(); } catch { /* ignore */ }
          done(true);
        }, 5_000);
      } catch {
        done(true);
      }
    });
  } else {
    // The child owns a detached Unix process group. Signal the entire group,
    // including descendants left behind after the parent accepts SIGTERM.
    try { process.kill(-pid, "SIGTERM"); } catch {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    // child.killed means a signal was sent, not that the process/group exited.
    try { process.kill(-pid, "SIGKILL"); } catch {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    void closed.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
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
    cwd?: string;
    onOutput?: (text: string) => void;
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
      detached: process.platform !== "win32",
      env: options.env || process.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
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
      const timeoutError = Object.assign(new Error(`Command timed out after ${options.timeoutMs}ms`), {
        killed: true,
        code: null,
        signal: "SIGTERM",
        stdout,
        stderr
      });
      // Do not release a maintenance lock until tree termination has completed.
      void killProcessTree(child).then(
        () => finish(timeoutError),
        () => finish(timeoutError)
      );
    }, Math.max(1_000, options.timeoutMs));

    const append = (bucket: "stdout" | "stderr", chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      options.onOutput?.(text);
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
      if (code !== 0 || signal) {
        finish(Object.assign(new Error(signal
          ? `Command terminated by signal ${signal}`
          : `Command failed with exit code ${code}`), {
          code: code ?? null,
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
