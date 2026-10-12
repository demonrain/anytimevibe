import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareSilentClientUpdate, type SilentClientUpdateOptions } from "./client-update-installer";

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const children: ChildProcess[] = [];
let fixtureExe: string;
let administratorExe: string;

// This executable is confined to .local: it records real argv, starts a small
// heartbeat writer, or simulates an installer failure. No Electron app is touched.
const fakeInstallerSource = String.raw`
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Web.Script.Serialization;
class FakeUpdater {
  static int Main(string[] args) {
    var own = Process.GetCurrentProcess().MainModule.FileName;
    var data = File.ReadAllLines(own + ".settings");
    var app = data[0]; var userData = data[1]; var mode = data[2];
    var serializer = new JavaScriptSerializer();
    if (args.Length > 0 && args[0] == "--owned-child") {
      File.WriteAllText(Path.Combine(userData, "second-stage-pid.txt"), Process.GetCurrentProcess().Id.ToString());
      Thread.Sleep(60000); return 0;
    }
    if (Path.GetFileName(own).StartsWith("installer")) {
      // NSIS treats /D specially: everything after the last /D= is literal,
      // including spaces, and it must not be surrounded by command-line quotes.
      var recorded = new[] { args[0], args[1], args[2], Environment.CommandLine.Substring(Environment.CommandLine.IndexOf("/D=")) };
      File.WriteAllText(Path.Combine(userData, "argv.json"), serializer.Serialize(recorded));
      File.WriteAllText(Path.Combine(userData, "installer-pid.txt"), Process.GetCurrentProcess().Id.ToString());
      if (mode == "hang") { Thread.Sleep(60000); return 0; }
      if (mode == "hang-child") {
        var childInfo = new ProcessStartInfo(own, "--owned-child");
        childInfo.UseShellExecute = false; childInfo.CreateNoWindow = true;
        Process.Start(childInfo); Thread.Sleep(60000); return 0;
      }
      if (mode == "error") return 23;
      File.WriteAllText(Path.Combine(app, "version.txt"), "2.0.0");
      if (mode == "corrupt" || mode == "success-corrupt") {
        File.WriteAllText(Path.Combine(app, "client.exe"), "corrupt executable");
        File.WriteAllText(Path.Combine(app, "resources", "app.asar"), "corrupt application");
        return mode == "corrupt" ? 23 : 0;
      }
      if (mode == "no-start") return 0;
      if (Array.IndexOf(args, "--force-run") < 0) return 0;
      var info = new ProcessStartInfo(Path.Combine(app, "client.exe"), "--updated");
      info.UseShellExecute = false; info.CreateNoWindow = true;
      Process.Start(info);
      return 0;
    }
    if (mode == "no-start" && File.ReadAllText(Path.Combine(app, "version.txt")) == "2.0.0") return 17;
    File.AppendAllText(Path.Combine(userData, "starts.txt"), "started\n");
    File.WriteAllText(Path.Combine(userData, "client-pid.txt"), Process.GetCurrentProcess().Id.ToString());
    var version = File.ReadAllText(Path.Combine(app, "version.txt"));
    var until = DateTime.UtcNow.AddSeconds(8);
    while (DateTime.UtcNow < until) {
      File.WriteAllText(Path.Combine(userData, "client-update-health.json"), serializer.Serialize(new {
        version = mode == "wrong-health" ? "1.0.0" : version, pid = Process.GetCurrentProcess().Id,
        updatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
      }));
      Thread.Sleep(50);
      if (mode == "one-heartbeat") Thread.Sleep(8000);
    }
    return 0;
  }
}
`;

async function makeFixture(mode = "error") {
  const local = path.resolve(".local");
  await fs.mkdir(local, { recursive: true });
  const directory = await fs.mkdtemp(path.join(local, "client-update-test-"));
  fixtures.push(directory);
  const appPath = path.join(directory, "app ' $ & [测试].app");
  const userDataPath = path.join(directory, "data ' $ & [测试]");
  await fs.mkdir(appPath);
  await fs.mkdir(userDataPath);
  const installerPath = path.join(directory, "installer ' $ & [测试].exe");
  const executablePath = path.join(appPath, "client.exe");
  if (fixtureExe) {
    await fs.copyFile(fixtureExe, installerPath);
    await fs.copyFile(fixtureExe, executablePath);
  } else {
    await fs.writeFile(installerPath, "not an executable");
    await fs.writeFile(executablePath, "not an executable");
  }
  const settings = [appPath, userDataPath, mode].join("\n");
  await fs.writeFile(`${installerPath}.settings`, settings);
  await fs.writeFile(`${executablePath}.settings`, settings);
  await fs.writeFile(path.join(appPath, "version.txt"), "1.0.0");
  await fs.mkdir(path.join(appPath, "resources"));
  await fs.writeFile(path.join(appPath, "resources", "app.asar"), "old application");
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(parent);
  await new Promise<void>((resolve, reject) => { parent.once("spawn", resolve); parent.once("error", reject); });
  const options: SilentClientUpdateOptions = {
    platform: process.platform === "darwin" ? "darwin" : "win32",
    installerPath, appPath, executablePath, userDataPath, currentPid: parent.pid!,
    currentVersion: "1.0.0", targetVersion: "2.0.0", operationId: "update-test-operation",
  };
  return { options, parent, directory };
}

async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 12_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < until) {
    try { const value = await read(); if (accept(value)) return value; } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for fixture: ${String(lastError)}`);
}

async function tuneHelper(userDataPath: string) {
  const name = (await fs.readdir(userDataPath)).find((item) => item.startsWith("client-update-"));
  if (!name) throw new Error("Prepared update did not create a helper directory");
  const configPath = path.join(userDataPath, name, "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.writeFile(configPath, JSON.stringify({
    ...config, parentTimeoutMs: 2000, installTimeoutMs: 800, healthTimeoutMs: 1500,
    stabilityMs: 200, pollMs: 40,
  }));
  return path.join(userDataPath, name);
}

function zipFixture(entries: Array<{ name: string; localName?: string; symlink?: string }>) {
  const locals: Buffer[] = [];
  const directories: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const localName = Buffer.from(entry.localName ?? entry.name);
    const data = Buffer.from(entry.symlink ?? "payload");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directories.push(central, name);
    offset += local.length + localName.length + data.length;
  }
  const directory = Buffer.concat(directories);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("macOS ZIP preparation bounds (native extraction requires macOS)", () => {
  it.each([
    { name: "path traversal", entries: [{ name: "bundle.app/../../../escaped" }] },
    { name: "external symlink", entries: [{ name: "bundle.app/link", symlink: "../../outside" }] },
    { name: "chained symlink escape", entries: [
      { name: "bundle.app/x/y", symlink: "../z" },
      { name: "bundle.app/deep/link", symlink: "../x/y/../../escape" },
    ] },
    { name: "local header path mismatch", entries: [{ name: "bundle.app/safe", localName: "../../escaped" }] },
    { name: "duplicate file entries", entries: [{ name: "bundle.app/same" }, { name: "bundle.app/same" }] },
  ])("rejects $name before extracting or quitting the old app", async ({ entries }) => {
    const { options, parent } = await makeFixture();
    options.platform = "darwin";
    await fs.writeFile(options.installerPath, zipFixture(entries));
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    try { await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/scope|outside|duplicate|local.*name/i); }
    finally { Object.defineProperty(process, "platform", platform); }
    expect(() => process.kill(parent.pid!, 0)).not.toThrow();
    expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
  });
});

beforeAll(async () => {
  if (process.platform !== "win32") return;
  await fs.mkdir(path.resolve(".local"), { recursive: true });
  const directory = await fs.mkdtemp(path.resolve(".local/client-update-compiler-"));
  fixtures.push(directory);
  const source = path.join(directory, "FakeUpdater.cs");
  fixtureExe = path.join(directory, "fake.exe");
  await fs.writeFile(source, fakeInstallerSource);
  const compiler = path.join(process.env.SystemRoot ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  await execFileAsync(compiler, ["/nologo", "/target:exe", "/reference:System.Web.Extensions.dll", `/out:${fixtureExe}`, source]);
  const manifest = path.join(directory, "administrator.manifest");
  administratorExe = path.join(directory, "administrator.exe");
  await fs.writeFile(manifest, '<?xml version="1.0" encoding="UTF-8"?><assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1"><trustInfo xmlns="urn:schemas-microsoft-com:asm.v3"><security><requestedPrivileges><requestedExecutionLevel level="requireAdministrator" uiAccess="false" /></requestedPrivileges></security></trustInfo></assembly>');
  await execFileAsync(compiler, ["/nologo", "/target:exe", "/reference:System.Web.Extensions.dll", `/win32manifest:${manifest}`, `/out:${administratorExe}`, source]);
}, 20_000);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) child.kill();
  // Kill only the PIDs recorded by our controlled executables, before removing fixtures.
  for (const directory of fixtures.filter((item) => !item.includes("compiler"))) {
    const userData = path.join(directory, "data ' $ & [测试]");
    for (const name of ["client-pid.txt", "installer-pid.txt", "second-stage-pid.txt"]) {
      try { process.kill(Number(await fs.readFile(path.join(userData, name), "utf8"))); } catch { /* already exited */ }
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    fixtures.splice(fixtures.indexOf(directory), 1);
  }
});

afterAll(async () => {
  for (const directory of fixtures.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32" && process.platform !== "darwin")("silent client update preparation", () => {
  it("rejects a missing downloaded installer while leaving the installed files alone", async () => {
    const { options } = await makeFixture();
    await fs.unlink(options.installerPath);
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/installer|安装包/i);
    expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
  });

  it("rejects an executable outside the installation directory", async () => {
    const { options } = await makeFixture();
    options.executablePath = process.execPath;
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/inside|范围|安装目录/i);
  });

  it("rejects filesystem roots and administrator installation directories before launch", async () => {
    const { options } = await makeFixture();
    options.appPath = path.parse(options.appPath).root;
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/root|根目录|范围/i);
    if (process.platform === "win32") {
      options.appPath = process.env.ProgramFiles!;
      options.executablePath = path.join(options.appPath, "client.exe");
      await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/administrator|admin|管理员|权限/i);
    }
  });

  it("rejects a malformed downloaded installer rather than trying an interactive shell fallback", async () => {
    const { options } = await makeFixture();
    await fs.writeFile(options.installerPath, "bad installer");
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/executable|installer|ZIP|安装包|可执行/i);
  });

  it("rejects an operation id containing path traversal", async () => {
    const { options } = await makeFixture();
    options.operationId = "../outside";
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/operation|操作/i);
  });
});

describe.skipIf(process.platform !== "win32")("Windows detached silent helper", () => {
  it("rejects an administrator manifest without invoking that executable", async () => {
    const { options } = await makeFixture();
    await fs.copyFile(administratorExe, options.installerPath);
    await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/administrator/i);
    await expect(fs.stat(path.join(options.userDataPath, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a directory whose actual ACL forbids writes", async () => {
    const { options } = await makeFixture();
    const username = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await execFileAsync("icacls.exe", [options.appPath, "/deny", `${username}:(W)`]);
    try {
      await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/permission|EPERM|EACCES/i);
      expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
    } finally { await execFileAsync("icacls.exe", [options.appPath, "/remove:d", username]); }
  });

  it("checks writable resources below the installation root before the old client exits", async () => {
    const { options } = await makeFixture();
    const resources = path.join(options.appPath, "resources");
    const username = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    await execFileAsync("icacls.exe", [resources, "/deny", `${username}:(W)`]);
    try { await expect(prepareSilentClientUpdate(options)).rejects.toThrow(/permission|EPERM|EACCES/i); }
    finally { await execFileAsync("icacls.exe", [resources, "/remove:d", username]); }
  });

  it("disposes a cancelled preparation without changing the app or launching anything", async () => {
    const { options } = await makeFixture();
    const prepared = await prepareSilentClientUpdate(options);
    const helperDirectory = await tuneHelper(options.userDataPath);
    await prepared.dispose();
    await prepared.dispose();
    await expect(fs.stat(helperDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepared.launch()).rejects.toThrow(/disposed|取消/i);
    expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
  });

  it("confirms readiness before returning and restarts the existing client once on installer failure", async () => {
    const { options, parent } = await makeFixture("error");
    const prepared = await prepareSilentClientUpdate(options);
    const helperDirectory = await tuneHelper(options.userDataPath);
    await prepared.launch();
    expect(JSON.parse(await fs.readFile(path.join(helperDirectory, "ready.json"), "utf8"))).toMatchObject({ operationId: options.operationId });
    expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
    await expect(fs.stat(path.join(options.userDataPath, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
    parent.kill();
    const result = await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    expect(result).toMatchObject({ operationId: options.operationId, success: false });
    expect(result.message).toMatch(/23/);
    expect(JSON.parse(await fs.readFile(path.join(options.userDataPath, "argv.json"), "utf8"))).toEqual([
      "--updated", "/S", "/currentuser", `/D=${options.appPath}`,
    ]);
    await eventually(() => fs.readFile(path.join(options.userDataPath, "starts.txt"), "utf8"), (value) => value === "started\n");
    await expect(prepared.launch()).rejects.toThrow(/already|已启动/i);
    expect(await fs.readFile(path.join(options.userDataPath, "starts.txt"), "utf8")).toBe("started\n");
  }, 15_000);

  it("does not accept the installer exit code as success without stable target-version heartbeats", async () => {
    const { options, parent } = await makeFixture("success");
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    parent.kill();
    const result = await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === true);
    expect(result).toMatchObject({ operationId: options.operationId, success: true });
    expect(await fs.readFile(path.join(options.userDataPath, "starts.txt"), "utf8")).toBe("started\n");
  }, 15_000);

  it.each(["corrupt", "success-corrupt"])("restores the previous executable and application after %s", async (mode) => {
    const { options, parent } = await makeFixture(mode);
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    parent.kill();
    const result = await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    expect(result).toMatchObject({ operationId: options.operationId, success: false });
    expect(await fs.readFile(path.join(options.appPath, "version.txt"), "utf8")).toBe("1.0.0");
    expect(await fs.readFile(path.join(options.appPath, "resources", "app.asar"), "utf8")).toBe("old application");
    expect(await fs.readFile(options.executablePath)).toEqual(await fs.readFile(fixtureExe));
    await eventually(() => fs.readFile(path.join(options.userDataPath, "starts.txt"), "utf8"), (value) => value === "started\n");
  }, 15_000);

  it("terminates a timed-out owned installer before restarting and reports failure", async () => {
    const { options, parent } = await makeFixture("hang");
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    parent.kill();
    const result = await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    expect(result.message).toMatch(/timeout|超时/i);
    const installerPid = Number(await fs.readFile(path.join(options.userDataPath, "installer-pid.txt"), "utf8"));
    expect(() => process.kill(installerPid, 0)).toThrow();
    await eventually(() => fs.readFile(path.join(options.userDataPath, "starts.txt"), "utf8"), (value) => value === "started\n");
  }, 15_000);

  it("terminates the owned NSIS second stage while leaving unrelated processes alive", async () => {
    const { options, parent } = await makeFixture("hang-child");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(unrelated);
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    parent.kill();
    await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    const secondStage = Number(await fs.readFile(path.join(options.userDataPath, "second-stage-pid.txt"), "utf8"));
    expect(() => process.kill(secondStage, 0)).toThrow();
    expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  }, 15_000);

  it.each(["no-start", "one-heartbeat", "wrong-health"])("reports %s as failed instead of accepting an unstabilized new client", async (mode) => {
    const { options, parent } = await makeFixture(mode);
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    parent.kill();
    const result = await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    expect(result).toMatchObject({ operationId: options.operationId, success: false });
    expect(result.message).toMatch(/stable|heartbeat|timeout/i);
  }, 15_000);

  it("leaves a client that never exits running and never starts the installer", async () => {
    const { options, parent } = await makeFixture();
    const prepared = await prepareSilentClientUpdate(options);
    await tuneHelper(options.userDataPath);
    await prepared.launch();
    await eventually(() => fs.readFile(path.join(options.userDataPath, "client-update-result.json"), "utf8").then(JSON.parse), (value) => value.success === false);
    expect(() => process.kill(parent.pid!, 0)).not.toThrow();
    await expect(fs.stat(path.join(options.userDataPath, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("fails launch without readiness and leaves the running client untouched", async () => {
    const { options, parent } = await makeFixture();
    const prepared = await prepareSilentClientUpdate(options);
    const helperDirectory = await tuneHelper(options.userDataPath);
    await fs.writeFile(path.join(helperDirectory, "helper.ps1"), "exit 7");
    await expect(prepared.launch()).rejects.toThrow(/helper|辅助/i);
    expect(() => process.kill(parent.pid!, 0)).not.toThrow();
    await expect(fs.stat(path.join(options.userDataPath, "argv.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
