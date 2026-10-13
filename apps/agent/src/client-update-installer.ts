import { execFile, spawn } from "node:child_process";
import { constants as nodeConstants, promises as nodeFs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";

export interface SilentClientUpdateOptions {
  platform: "win32" | "darwin";
  installerPath: string;
  appPath: string;
  executablePath: string;
  currentPid: number;
  userDataPath: string;
  currentVersion: string;
  targetVersion: string;
  operationId: string;
}

const execFileAsync = promisify(execFile);

// Electron patches node:fs to understand virtual paths inside app.asar. The
// installed application backup must copy the physical app.asar archive itself,
// so use Electron's original-fs when it is available. Plain Node test/build
// processes do not expose that module and safely fall back to node:fs.
const originalFs = (() => {
  try { return createRequire(__filename)("original-fs") as typeof import("node:fs"); }
  catch { return undefined; }
})();
const fs = originalFs?.promises ?? nodeFs;
const constants = originalFs?.constants ?? nodeConstants;

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ordinaryPath(value: string, kind: "file" | "directory", label: string): Promise<string> {
  if (!path.isAbsolute(value) || /[\x00-\x1f]/.test(value) || (process.platform === "win32" && value.includes('"'))) throw new Error(`${label} must be an absolute, safe path`);
  const absolute = path.resolve(value);
  const info = await fs.lstat(absolute).catch(() => { throw new Error(`${label} is missing`); });
  if (info.isSymbolicLink() || (kind === "file" ? !info.isFile() : !info.isDirectory())) throw new Error(`${label} must be an ordinary ${kind}`);
  const canonical = await fs.realpath(absolute);
  if (path.relative(canonical, absolute) !== "") throw new Error(`${label} cannot contain symbolic links`);
  return canonical;
}

async function writableDirectory(directory: string): Promise<void> {
  const probe = path.join(directory, `.client-update-write-${randomUUID()}`);
  try {
    const handle = await fs.open(probe, "wx", 0o600);
    await handle.close();
    await fs.unlink(probe);
  } catch (error) { throw new Error(`Client update permission denied for ${directory}: ${String(error)}`); }
}

async function writableWindowsTree(directory: string): Promise<void> {
  await writableDirectory(directory);
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Installation contains a link outside the update scope");
    if (entry.isDirectory()) await writableWindowsTree(item);
    else if (entry.isFile()) await fs.access(item, constants.W_OK);
    else throw new Error("Installation contains an unsupported file outside the update scope");
  }
}

// Inspect RT_MANIFEST, never arbitrary strings in an executable's overlay.
async function requireInvokerInstaller(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const read = async (offset: number, length: number) => {
      if (offset < 0 || offset + length > size || length > 16 * 1024 * 1024) throw new Error("Invalid installer executable");
      const buffer = Buffer.alloc(length);
      if ((await handle.read(buffer, 0, length, offset)).bytesRead !== length) throw new Error("Invalid installer executable");
      return buffer;
    };
    const dos = await read(0, 64);
    if (dos.toString("ascii", 0, 2) !== "MZ") throw new Error("Invalid installer executable");
    const peOffset = dos.readUInt32LE(60);
    const pe = await read(peOffset, 24);
    if (pe.readUInt32LE(0) !== 0x4550) throw new Error("Invalid installer executable");
    const optionalSize = pe.readUInt16LE(20);
    const optional = await read(peOffset + 24, optionalSize);
    const directoriesOffset = optional.readUInt16LE(0) === 0x20b ? 112 : optional.readUInt16LE(0) === 0x10b ? 96 : -1;
    if (directoriesOffset < 0 || optional.length < directoriesOffset + 24) throw new Error("Invalid installer executable");
    const resourceRva = optional.readUInt32LE(directoriesOffset + 16);
    const resourceSize = optional.readUInt32LE(directoriesOffset + 20);
    const sectionCount = pe.readUInt16LE(6);
    if (sectionCount > 96 || !resourceRva || !resourceSize) throw new Error("Installer has no safe execution manifest");
    const sections = await read(peOffset + 24 + optionalSize, sectionCount * 40);
    const rawOffset = (rva: number, length: number) => {
      for (let index = 0; index < sectionCount; index++) {
        const start = index * 40;
        const address = sections.readUInt32LE(start + 12);
        const rawSize = sections.readUInt32LE(start + 16);
        if (rva >= address && rva + length <= address + rawSize) return sections.readUInt32LE(start + 20) + rva - address;
      }
      throw new Error("Invalid installer resource bounds");
    };
    const resource = await read(rawOffset(resourceRva, resourceSize), resourceSize);
    const entries = (offset: number): Array<{ id: number; offset: number; directory: boolean }> => {
      if (offset < 0 || offset + 16 > resource.length) throw new Error("Invalid installer manifest directory");
      const count = resource.readUInt16LE(offset + 12) + resource.readUInt16LE(offset + 14);
      if (offset + 16 + count * 8 > resource.length) throw new Error("Invalid installer manifest directory");
      return Array.from({ length: count }, (_, index) => {
        const entry = offset + 16 + index * 8;
        const target = resource.readUInt32LE(entry + 4);
        return { id: resource.readUInt32LE(entry), offset: target & 0x7fffffff, directory: !!(target & 0x80000000) };
      });
    };
    const manifestType = entries(0).find((entry) => entry.id === 24 && entry.directory);
    if (!manifestType) throw new Error("Installer has no safe execution manifest");
    let found = false;
    for (const name of entries(manifestType.offset)) {
      if (!name.directory) throw new Error("Invalid installer manifest");
      for (const language of entries(name.offset)) {
        if (language.directory || language.offset + 16 > resource.length) throw new Error("Invalid installer manifest");
        const dataRva = resource.readUInt32LE(language.offset);
        const dataSize = resource.readUInt32LE(language.offset + 4);
        const manifestBytes = await read(rawOffset(dataRva, dataSize), dataSize);
        const manifest = manifestBytes[0] === 0xff && manifestBytes[1] === 0xfe ? manifestBytes.toString("utf16le") : manifestBytes.toString("utf8");
        const levels = [...manifest.matchAll(/<requestedExecutionLevel\b[^>]*\blevel\s*=\s*['"]([^'"]+)['"]/gi)];
        if (levels.length !== 1 || levels[0]?.[1] !== "asInvoker") throw new Error("Installer requires administrator rights or lacks an asInvoker manifest");
        found = true;
      }
    }
    if (!found) throw new Error("Installer has no safe execution manifest");
  } catch (error) {
    if (error instanceof RangeError) throw new Error("Invalid installer executable");
    throw error;
  } finally { await handle.close(); }
}

function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

async function rejectMachineInstall(options: SilentClientUpdateOptions): Promise<void> {
  if (!/^[a-z]:\\/i.test(options.appPath) || /[ .]$/.test(options.appPath)) throw new Error("Administrator or network installation directories are unsupported");
  for (const name of ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "SystemRoot", "ProgramData"]) {
    const root = process.env[name];
    if (root && (path.relative(root, options.appPath) === "" || inside(root, options.appPath))) throw new Error("Administrator installation cannot be updated silently");
  }
  // A writable custom path can still have an HKLM uninstaller that elevates.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($env:ANYTIMEVIBE_UPDATE_APP).TrimEnd('\')
foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  try {
    $key = $base.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')
    if ($null -eq $key) { continue }
    try { foreach ($name in $key.GetSubKeyNames()) {
      $entry = $key.OpenSubKey($name)
      if ($null -eq $entry) { continue }
      try {
        $location = [string]$entry.GetValue('InstallLocation', '')
        $uninstall = [string]$entry.GetValue('UninstallString', '')
        $sameLocation=$false
        if ($location -ne '') { try { $sameLocation=[IO.Path]::GetFullPath($location.Trim('"')).TrimEnd('\') -eq $target } catch [ArgumentException] {} }
        if ($sameLocation -or $uninstall.IndexOf($target + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Administrator installation cannot be updated silently' }
      } finally { $entry.Dispose() }
    } } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
`;
  await execFileAsync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, ANYTIMEVIBE_UPDATE_APP: options.appPath },
  }).catch((error) => { throw new Error(`Silent update permission / administrator check failed: ${(error as { stderr?: string }).stderr ?? "registry probe failed"}`); });
}

// Frameworks need symlinks. Validate their ZIP targets before extracting: a
// post-extraction check alone cannot prevent an archive writing outside stage.
async function validateZip(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const tail = Buffer.alloc(Math.min(size, 65_557));
    await handle.read(tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index--) {
      if (tail.readUInt32LE(index) === 0x06054b50 && index + 22 + tail.readUInt16LE(index + 20) === tail.length) { end = index; break; }
    }
    if (end < 0 || tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error("Invalid update ZIP installer");
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length > 16 * 1024 * 1024 || offset + length > size - tail.length + end) throw new Error("Unsupported or malformed update ZIP installer");
    const central = Buffer.alloc(length);
    if ((await handle.read(central, 0, length, offset)).bytesRead !== length) throw new Error("Invalid update ZIP installer");
    let cursor = 0;
    const key = (name: string) => path.posix.normalize(name).replace(/\/$/, "").normalize("NFC").toLowerCase();
    const names = new Set<string>();
    const links = new Map<string, { name: string; target: string }>();
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid update ZIP directory");
      const nameLength = central.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + central.readUInt16LE(cursor + 30) + central.readUInt16LE(cursor + 32);
      if (next > length) throw new Error("Invalid update ZIP directory");
      const name = central.toString("utf8", cursor + 46, cursor + 46 + nameLength);
      if (!name || /[\x00-\x1f\\]/.test(name) || name.startsWith("/") || /^[a-z]:/i.test(name) || name.split("/").includes("..")) throw new Error("Update ZIP path is outside the application scope");
      if (names.has(key(name))) throw new Error("Duplicate update ZIP entry is outside safe extraction scope");
      names.add(key(name));
      const type = (central.readUInt32LE(cursor + 38) >>> 16) & 0o170000;
      if (type !== 0 && type !== 0o100000 && type !== 0o040000 && type !== 0o120000) throw new Error("Unsupported update ZIP entry");
      const compressedSize = central.readUInt32LE(cursor + 20);
      const method = central.readUInt16LE(cursor + 10);
      const localOffset = central.readUInt32LE(cursor + 42);
      const local = Buffer.alloc(30);
      if (localOffset + 30 > offset || (await handle.read(local, 0, 30, localOffset)).bytesRead !== 30 || local.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid update ZIP local header");
      const localNameLength = local.readUInt16LE(26);
      const localName = Buffer.alloc(localNameLength);
      if (localOffset + 30 + localNameLength > offset || (await handle.read(localName, 0, localNameLength, localOffset + 30)).bytesRead !== localNameLength || !localName.equals(central.subarray(cursor + 46, cursor + 46 + nameLength))) throw new Error("Update ZIP local name differs from its safe directory name");
      if ((central.readUInt16LE(cursor + 8) & 1) || (local.readUInt16LE(6) & 1) || (method !== 0 && method !== 8) || local.readUInt16LE(8) !== method) throw new Error("Unsupported update ZIP encoding");
      const dataOffset = localOffset + 30 + localNameLength + local.readUInt16LE(28);
      if (dataOffset + compressedSize > offset) throw new Error("Invalid update ZIP data bounds");
      if (type === 0o120000) {
        const uncompressedSize = central.readUInt32LE(cursor + 24);
        if (compressedSize > 4096 || uncompressedSize > 4096) throw new Error("Invalid update ZIP symlink");
        const compressed = Buffer.alloc(compressedSize);
        if ((await handle.read(compressed, 0, compressedSize, dataOffset)).bytesRead !== compressedSize) throw new Error("Invalid update ZIP symlink");
        const target = (method === 8 ? inflateRawSync(compressed, { maxOutputLength: 4096 }) : compressed).toString("utf8");
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), target));
        const bundle = name.split("/")[0]!;
        if (!target || /[\x00-\x1f\\]/.test(target) || target.startsWith("/") || !bundle.endsWith(".app") || !resolved.startsWith(`${bundle}/`)) throw new Error("Update ZIP symlink is outside the application scope");
        links.set(key(name), { name, target });
      }
      cursor = next;
    }
    if (cursor !== length || count === 0) throw new Error("Invalid update ZIP installer");
    for (const name of names) {
      const parts = name.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        if (links.has(parts.slice(0, depth).join("/"))) throw new Error("Update ZIP entry traverses a symlink outside safe extraction scope");
      }
    }
    for (const link of links.values()) {
      const parts = path.posix.dirname(link.name).split("/");
      let pending = link.target.split("/");
      let hops = 0;
      while (pending.length) {
        const part = pending.shift()!;
        if (part === "." || part === "") continue;
        if (part === "..") {
          if (parts.length <= 1) throw new Error("Update ZIP chained symlink is outside the application scope");
          parts.pop(); continue;
        }
        parts.push(part);
        const nextLink = links.get(key(parts.join("/")));
        if (nextLink) {
          if (++hops > 40) throw new Error("Update ZIP chained symlink is outside safe extraction scope");
          parts.pop(); pending = [...nextLink.target.split("/"), ...pending];
        }
      }
    }
  } finally { await handle.close(); }
}

async function prepareMac(options: SilentClientUpdateOptions): Promise<{ stagePath: string; stagedAppPath: string; backupPath: string }> {
  if (!options.appPath.endsWith(".app") || options.appPath.startsWith("/Volumes/")) throw new Error("Client must be installed in a writable .app outside a DMG");
  await validateZip(options.installerPath);
  const parent = path.dirname(options.appPath);
  await writableDirectory(parent);
  const stagePath = await fs.mkdtemp(path.join(parent, ".anytimevibe-update-"));
  try {
    const payload = path.join(stagePath, "payload");
    await fs.mkdir(payload);
    await execFileAsync("/usr/bin/ditto", ["-x", "-k", options.installerPath, payload], { timeout: 120_000 });
    const apps = (await fs.readdir(payload)).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new Error("Update installer must contain exactly one .app");
    const stagedAppPath = await ordinaryPath(path.join(payload, apps[0]!), "directory", "Staged application");
    const plist = async (app: string, key: string) => (await execFileAsync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path.join(app, "Contents", "Info.plist")], { timeout: 10_000 })).stdout.trim();
    const executableName = await plist(stagedAppPath, "CFBundleExecutable");
    if (!executableName || path.basename(executableName) !== executableName || /[\x00-\x1f]/.test(executableName)) throw new Error("Invalid update application executable");
    if (await plist(stagedAppPath, "CFBundleIdentifier") !== await plist(options.appPath, "CFBundleIdentifier")) throw new Error("Update application identifier does not match");
    if (await plist(stagedAppPath, "CFBundleShortVersionString") !== options.targetVersion) throw new Error("Update application version does not match target version");
    if (path.relative(options.appPath, options.executablePath) !== path.join("Contents", "MacOS", executableName)) throw new Error("Update application executable does not match installed application");
    const executable = await ordinaryPath(path.join(stagedAppPath, "Contents", "MacOS", executableName), "file", "Update executable");
    await fs.access(executable, constants.X_OK);
    const signing = async (app: string): Promise<string | undefined> => {
      try { return (await execFileAsync("/usr/bin/codesign", ["--display", "--verbose=4", app], { timeout: 10_000 })).stderr; }
      catch (error) {
        if (/code object is not signed at all/i.test((error as { stderr?: string }).stderr ?? "")) return undefined;
        throw error;
      }
    };
    const currentSignature = await signing(options.appPath);
    const updateSignature = await signing(stagedAppPath);
    // electron-builder skips signing when no identity/certificate is configured;
    // this repository permits such builds. Do not require signing only at update
    // time, but preserve the trust level of an already signed installation.
    if (currentSignature && !updateSignature) throw new Error("Update application lost the installed application's code signature");
    if (updateSignature) {
      await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedAppPath], { timeout: 60_000 });
      const currentTeam = currentSignature?.match(/^TeamIdentifier=(.+)$/m)?.[1];
      const updateTeam = updateSignature.match(/^TeamIdentifier=(.+)$/m)?.[1];
      if (currentTeam && currentTeam !== "not set" && currentTeam !== updateTeam) throw new Error("Update application signing team does not match");
    }
    return { stagePath, stagedAppPath, backupPath: path.join(stagePath, "previous.app") };
  } catch (error) { await fs.rm(stagePath, { recursive: true, force: true }); throw error; }
}

async function prepareWindows(options: SilentClientUpdateOptions): Promise<{ stagePath: string; backupPath: string }> {
  const parent = path.dirname(options.appPath);
  await writableDirectory(parent);
  const stagePath = await fs.mkdtemp(path.join(parent, ".anytimevibe-update-"));
  const backupPath = path.join(stagePath, "previous");
  try {
    // Same filesystem as appPath so recovery can rename whole directories.
    // Windows allows copying the running executable and loaded DLLs for read.
    await fs.cp(options.appPath, backupPath, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    return { stagePath, backupPath };
  } catch (error) {
    await fs.rm(stagePath, { recursive: true, force: true });
    throw new Error(`Could not prepare a complete client backup: ${String(error)}`);
  }
}

export async function prepareSilentClientUpdate(input: SilentClientUpdateOptions): Promise<{ launch(): Promise<void>; dispose(): Promise<void> }> {
  const options = { ...input };
  if (options.platform !== process.platform || (options.platform !== "win32" && options.platform !== "darwin")) throw new Error("Silent client update platform is unsupported");
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.operationId)) throw new Error("Invalid client update operation id");
  if (!Number.isSafeInteger(options.currentPid) || options.currentPid <= 0) throw new Error("Invalid current client pid");
  for (const version of [options.currentVersion, options.targetVersion]) if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) throw new Error("Invalid client update version");
  if (!path.isAbsolute(options.appPath) || path.resolve(options.appPath) === path.parse(path.resolve(options.appPath)).root) throw new Error("Application root directory is outside the update scope");
  if (!inside(path.resolve(options.appPath), path.resolve(options.executablePath))) throw new Error("Client executable must be inside its installation directory");
  if (options.platform === "win32") await rejectMachineInstall(options);
  options.appPath = await ordinaryPath(options.appPath, "directory", "Installation directory");
  options.executablePath = await ordinaryPath(options.executablePath, "file", "Client executable");
  options.installerPath = await ordinaryPath(options.installerPath, "file", "Downloaded installer");
  options.userDataPath = await ordinaryPath(options.userDataPath, "directory", "Client user data");
  if (inside(options.appPath, options.userDataPath) || path.relative(options.appPath, options.userDataPath) === "" || inside(options.appPath, options.installerPath)) throw new Error("Installer and user data must be outside the installation directory");
  if ((await fs.stat(options.installerPath)).size === 0) throw new Error("Downloaded installer is empty");
  if (options.platform === "win32") await writableWindowsTree(options.appPath);
  else await writableDirectory(options.appPath);
  await writableDirectory(options.userDataPath);
  if (options.platform === "win32") await requireInvokerInstaller(options.installerPath);
  const staging = options.platform === "darwin" ? await prepareMac(options) : await prepareWindows(options);
  const helperDirectory = await fs.mkdtemp(path.join(options.userDataPath, "client-update-")).catch(async (error) => {
    await fs.rm(staging.stagePath, { recursive: true, force: true });
    throw error;
  });
  const configPath = path.join(helperDirectory, "config.json");
  const readyPath = path.join(helperDirectory, "ready.json");
  const ackPath = path.join(helperDirectory, "ack");
  const cancelPath = path.join(helperDirectory, "cancel");
  const resultPath = path.join(options.userDataPath, "client-update-result.json");
  const healthPath = path.join(options.userDataPath, "client-update-health.json");
  const helperPath = path.join(helperDirectory, options.platform === "win32" ? "helper.ps1" : "helper.sh");
  const config = { ...options, ...staging, helperDirectory, readyPath, ackPath, cancelPath, resultPath, healthPath,
    parentTimeoutMs: 60_000, installTimeoutMs: 180_000, healthTimeoutMs: 90_000, stabilityMs: 10_000, pollMs: 250 };
  try {
    await fs.writeFile(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    await fs.writeFile(helperPath, options.platform === "win32" ? windowsHelper : macHelper, { flag: "wx", mode: 0o700 });
  } catch (error) {
    await fs.rm(helperDirectory, { recursive: true, force: true });
    await fs.rm(staging.stagePath, { recursive: true, force: true });
    throw error;
  }
  let launched = false;
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  return {
    async dispose() {
      if (launched) return;
      disposed = true;
      cleanup ??= (async () => {
        await fs.rm(helperDirectory, { recursive: true, force: true });
        await fs.rm(staging.stagePath, { recursive: true, force: true });
      })();
      await cleanup;
    },
    async launch() {
    if (disposed) throw new Error("Client update preparation was disposed");
    if (launched) throw new Error("Client update helper already launched");
    launched = true;
    let failure: Error | undefined;
    let exitDetail: string | undefined;
    // DETACHED_PROCESS + CREATE_NO_WINDOW makes Windows PowerShell silently
    // exit before executing a script on some systems. Start a native process
    // group instead, with no console and no dependency on this parent lifetime.
    let helperPid: number | undefined;
    let helper: ReturnType<typeof spawn> | undefined;
    const deadline = Date.now() + 15_000;
    try {
      if (options.platform === "win32") {
        const { stdout } = await execFileAsync(powershellPath(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsLauncher, "utf16le").toString("base64")], {
          windowsHide: true, timeout: 15_000,
          env: { ...process.env, ANYTIMEVIBE_UPDATE_HELPER: helperPath, ANYTIMEVIBE_UPDATE_CONFIG: configPath },
        });
        helperPid = Number(stdout.trim());
        if (!Number.isSafeInteger(helperPid) || helperPid <= 0) throw new Error("Client update helper did not report its process id");
      } else {
        helper = spawn("/bin/bash", [helperPath, configPath], { detached: true, stdio: "ignore" });
        helper.once("error", (error) => { failure = error; });
        helper.once("exit", (code, signal) => { exitDetail = `exit ${code}, signal ${signal}`; });
        helperPid = helper.pid;
      }
      while (Date.now() < deadline) {
        if (failure || exitDetail) throw new Error(`Client update helper failed to start: ${failure?.message ?? exitDetail}`);
        try { if (helperPid) process.kill(helperPid, 0); } catch { throw new Error("Client update helper exited before readiness"); }
        try {
          const ready = JSON.parse(await fs.readFile(readyPath, "utf8"));
          if (ready.operationId === options.operationId && ready.pid === helperPid) {
            process.kill(ready.pid, 0);
            await fs.writeFile(ackPath, "ready", { flag: "wx", mode: 0o600 });
            helper?.unref(); return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("Client update helper readiness timeout");
    } catch (error) {
      await fs.writeFile(cancelPath, "cancel", { mode: 0o600 }).catch(() => {});
      if (helperPid) { try { process.kill(helperPid); } catch { /* helper already exited */ } }
      helper?.unref();
      // The helper needs ack AND parent exit before modifying installed files.
      await fs.rm(staging.stagePath, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  } };
}

const windowsLauncher = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class SilentHelperLauncher {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP { public int size; public string reserved,desktop,title; public int x,y,cx,cy,xcount,ycount,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public int pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUP si,out PROCESS pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int Start(string exe, string helper, string config) {
    var command=new StringBuilder("\""+exe+"\" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+helper+"\" \""+config+"\"");
    var startup=new STARTUP(); startup.size=Marshal.SizeOf(startup); PROCESS process;
    if(!CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,0x08000200,IntPtr.Zero,null,ref startup,out process)) throw new Win32Exception();
    CloseHandle(process.thread); CloseHandle(process.process);
    return process.pid;
  }
}
'@
[SilentHelperLauncher]::Start((Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'), $env:ANYTIMEVIBE_UPDATE_HELPER, $env:ANYTIMEVIBE_UPDATE_CONFIG)
`;

const windowsHelper = String.raw`
param([Parameter(Mandatory=$true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$utf8 = New-Object Text.UTF8Encoding($false)
function Write-Json($file, $value) {
  $temporary = $file + '.' + $PID + '.tmp'
  [IO.File]::WriteAllText($temporary, ($value | ConvertTo-Json -Compress), $utf8)
  Move-Item -LiteralPath $temporary -Destination $file -Force
}
function Result($success, $message) { Write-Json $cfg.resultPath @{ operationId=$cfg.operationId; success=$success; message=$message } }
function Now { return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# Start suspended and assign a job BEFORE the installer can spawn NSIS's second
# stage. A timeout kills this job, never processes selected by name or path.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class OwnedInstaller : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
  [StructLayout(LayoutKind.Sequential)] struct LIMITS { public BASIC basic; public IO_COUNTERS io; public UIntPtr a,b,c,d; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long a,b,c,d; public uint pageFaults,totalProcesses,activeProcesses,terminatedProcesses; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUP { public int size; public string reserved,desktop,title; public int x,y,cx,cy,xcount,ycount,fill,flags; public short show,reserved2; public IntPtr reserved3,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS { public IntPtr process,thread; public int pid,tid; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string b);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref LIMITS data,int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out ACCOUNTING data,int size,IntPtr returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUP si,out PROCESS pi);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h,out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h,uint timeout);
  IntPtr job, processHandle; public int Pid { get; private set; }
  public OwnedInstaller(string exe,string arguments,string directory) {
    job=CreateJobObject(IntPtr.Zero,null);
    if(job==IntPtr.Zero) throw new Win32Exception();
    var limits=new LIMITS(); limits.basic.flags=0x2000;
    if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) { Dispose(); throw new Win32Exception(); }
    var startup=new STARTUP(); startup.size=Marshal.SizeOf(startup); PROCESS child;
    if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+arguments),IntPtr.Zero,IntPtr.Zero,false,0x08000004,IntPtr.Zero,directory,ref startup,out child)) { Dispose(); throw new Win32Exception(); }
    processHandle=child.process; Pid=child.pid;
    try {
      if(!AssignProcessToJobObject(job,child.process)) { TerminateProcess(child.process,1); throw new Win32Exception(); }
      if(ResumeThread(child.thread)==0xffffffff) { TerminateJobObject(job,1); throw new Win32Exception(); }
    } catch { Dispose(); throw; }
    finally { CloseHandle(child.thread); }
  }
  public bool Wait(int timeout) { uint state=WaitForSingleObject(processHandle,(uint)timeout); if(state==0xffffffff) throw new Win32Exception(); return state==0; }
  public bool WaitEmpty(int timeout) {
    var watch=Stopwatch.StartNew();
    do {
      ACCOUNTING accounting;
      if(!QueryInformationJobObject(job,1,out accounting,Marshal.SizeOf(typeof(ACCOUNTING)),IntPtr.Zero)) throw new Win32Exception();
      if(accounting.activeProcesses==0) return true;
      if(watch.ElapsedMilliseconds>=timeout) return false;
      System.Threading.Thread.Sleep(50);
    } while(true);
  }
  public int ExitCode { get { uint code; if(!GetExitCodeProcess(processHandle,out code)) throw new Win32Exception(); return (int)code; } }
  public void Stop() { if(job!=IntPtr.Zero && !TerminateJobObject(job,1)) throw new Win32Exception(); }
  public void Release() {
    var limits=new LIMITS();
    if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(limits))) throw new Win32Exception();
    CloseHandle(job); job=IntPtr.Zero;
  }
  public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } if(processHandle!=IntPtr.Zero) { CloseHandle(processHandle); processHandle=IntPtr.Zero; } }
}
'@

function Wait-Health($version, $since, $expectedPid) {
  $until = (Now) + [long]$cfg.healthTimeoutMs
  $stableSince = 0; $stablePid = 0; $firstStamp = 0
  while ((Now) -lt $until) {
    try {
      $health = Get-Content -LiteralPath $cfg.healthPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $stamp = if ($health.updatedAt -is [string]) { [DateTimeOffset]::Parse($health.updatedAt).ToUnixTimeMilliseconds() } else { [long]$health.updatedAt }
      $id = [int]$health.pid
      $process = Get-Process -Id $id -ErrorAction Stop
      $samePath = [IO.Path]::GetFullPath($process.MainModule.FileName) -eq $cfg.executablePath
      if ($health.version -eq $version -and $id -eq $expectedPid -and $samePath -and $stamp -ge $since -and $stamp -le (Now) + 2000 -and (Now) - $stamp -le 15000) {
        if ($stablePid -ne $id) { $stablePid=$id; $stableSince=Now; $firstStamp=$stamp }
        if ((Now) - $stableSince -ge [long]$cfg.stabilityMs -and $stamp -gt $firstStamp) { return $true }
      } else { $stableSince=0; $stablePid=0 }
    } catch { $stableSince=0; $stablePid=0 }
    Start-Sleep -Milliseconds $cfg.pollMs
  }
  return $false
}
function Restart-Client {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName=$cfg.executablePath; $start.Arguments='--updated --client-update-restart'; $start.WorkingDirectory=$cfg.appPath
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  [void][Diagnostics.Process]::Start($start)
}

function Validate-Stage {
  $stage=[IO.Path]::GetFullPath($cfg.stagePath)
  if ($stage -ne $cfg.stagePath -or [IO.Path]::GetDirectoryName($stage) -ne [IO.Path]::GetDirectoryName($cfg.appPath) -or [IO.Path]::GetFileName($stage) -notmatch '^\.anytimevibe-update-[a-zA-Z0-9]+$' -or $cfg.backupPath -ne [IO.Path]::Combine($stage, 'previous')) { throw 'Client backup is outside the update scope' }
  if (([IO.File]::GetAttributes($stage) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or ![IO.Directory]::Exists($cfg.backupPath)) { throw 'Client backup is not an ordinary directory' }
}
function Restore-Client {
  Validate-Stage
  $damaged=[IO.Path]::Combine($cfg.stagePath, 'failed')
  if ([IO.Directory]::Exists($cfg.appPath)) { [IO.Directory]::Move($cfg.appPath, $damaged) }
  try { [IO.Directory]::Move($cfg.backupPath, $cfg.appPath) }
  catch {
    if (![IO.Directory]::Exists($cfg.appPath) -and [IO.Directory]::Exists($damaged)) { [IO.Directory]::Move($damaged, $cfg.appPath) }
    throw
  }
}

$owned = $null
$newClient = $null
$parentExited = $false
$committed = $false
try {
  Validate-Stage
  $parent = Get-Process -Id $cfg.currentPid -ErrorAction Stop
  Write-Json $cfg.readyPath @{ operationId=$cfg.operationId; pid=$PID }
  $ackUntil=(Now)+20000
  while (!(Test-Path -LiteralPath $cfg.ackPath)) {
    if ((Test-Path -LiteralPath $cfg.cancelPath) -or (Now) -gt $ackUntil) { exit 1 }
    Start-Sleep -Milliseconds $cfg.pollMs
  }
  if (!$parent.WaitForExit([int]$cfg.parentTimeoutMs)) { Result $false 'Client exit timeout; update was not installed'; exit 1 }
  $parentExited=$true
  if (Test-Path -LiteralPath $cfg.cancelPath) { exit 1 }
  $since=Now
  # NSIS /D must be literal, unquoted, and last. No shell parses this command.
  # /S does not auto-start the assisted or one-click installer unless
  # --force-run is supplied. We start the new client directly in its own job.
  $arguments='--updated /S /currentuser /D=' + $cfg.appPath
  $installDeadline=(Now)+[long]$cfg.installTimeoutMs
  $owned=New-Object OwnedInstaller($cfg.installerPath, $arguments, $cfg.helperDirectory)
  if (!$owned.Wait([int]$cfg.installTimeoutMs)) { $owned.Stop(); throw 'Installer timeout; stopped the owned installer process tree' }
  if ($owned.ExitCode -ne 0) { throw ('Installer exited with code ' + $owned.ExitCode) }
  $remaining=[Math]::Max(0, $installDeadline-(Now))
  if (!$owned.WaitEmpty([int]$remaining)) { $owned.Stop(); throw 'Installer second-stage process timeout' }
  $newClient=New-Object OwnedInstaller($cfg.executablePath, '--updated --client-update-restart', $cfg.appPath)
  if (!(Wait-Health $cfg.targetVersion $since $newClient.Pid)) { throw 'Target client did not provide stable version heartbeats before timeout' }
  $newClient.Release()
  $committed=$true
  $message='Client updated to ' + $cfg.targetVersion
  try { Validate-Stage; [IO.Directory]::Delete($cfg.stagePath, $true) } catch { $message += '; previous client backup retained' }
  Result $true $message
} catch {
  $message=[string]$_.Exception.Message
  $stopped=$true
  if (!$committed) {
    foreach ($process in @($newClient, $owned)) {
      if ($null -ne $process) { try { $process.Stop(); if (!$process.Wait(5000) -or !$process.WaitEmpty(5000)) { throw 'Owned process termination timeout' } } catch { $stopped=$false; $message += '; could not confirm owned process termination' } }
    }
    if ($parentExited -and $stopped) {
      try { Restore-Client; $message += '; restored previous client files' }
      catch { $message += '; previous client restoration failed: ' + $_.Exception.Message }
    }
    Result $false $message
    if ($parentExited -and $stopped) {
      try { Restart-Client } catch { Result $false ($message + '; client restart failed: ' + $_.Exception.Message) }
    }
  } else {
    Result $true ('New client is running; ' + $message)
  }
} finally {
  if ($null -ne $owned) { $owned.Dispose() }
  if ($null -ne $newClient) { $newClient.Dispose() }
}
`;

const macHelper = String.raw`
#!/bin/bash
set -u
config=$1
read_config() { /usr/bin/plutil -extract "$1" raw -o - "$config"; }
app=$(read_config appPath) || exit 1
exe=$(read_config executablePath) || exit 1
parent=$(read_config currentPid) || exit 1
operation=$(read_config operationId) || exit 1
target=$(read_config targetVersion) || exit 1
stage=$(read_config stagePath) || exit 1
new_app=$(read_config stagedAppPath) || exit 1
backup=$(read_config backupPath) || exit 1
ready=$(read_config readyPath) || exit 1
ack=$(read_config ackPath) || exit 1
cancel=$(read_config cancelPath) || exit 1
health=$(read_config healthPath) || exit 1
result=$(read_config resultPath) || exit 1
parent_timeout=$(read_config parentTimeoutMs) || exit 1
health_timeout=$(read_config healthTimeoutMs) || exit 1
stability=$(read_config stabilityMs) || exit 1
now() { /bin/date +%s; }
write_result() {
  # Paths remain opaque argv. These fixed messages and validated ids/versions
  # contain no JSON escapes. No user-controlled string is evaluated by a shell.
  /usr/bin/printf '{"operationId":"%s","success":%s,"message":"%s"}' "$operation" "$1" "$2" > "$result.$$.tmp" && /bin/mv -f "$result.$$.tmp" "$result"
}
safe_stage() {
  [ "$(/usr/bin/dirname "$stage")" = "$(/usr/bin/dirname "$app")" ] || return 1
  stage_name=$(/usr/bin/basename "$stage")
  [[ "$stage_name" =~ ^\.anytimevibe-update-[a-zA-Z0-9]+$ ]] || return 1
  [ "$(/usr/bin/dirname "$new_app")" = "$stage/payload" ] || return 1
  case "$new_app" in *.app) ;; *) return 1 ;; esac
  [ "$backup" = "$stage/previous.app" ] && [ "$new_app" != "$app" ] && [ ! -L "$stage" ] && [ ! -L "$backup" ]
}
safe_stage || exit 1
parent_exited=0
new_pid=0
finish() {
  status=$?
  if [ "$status" -ne 0 ] && [ "$parent_exited" -eq 1 ]; then
    if [ "$new_pid" -gt 0 ] && kill -0 "$new_pid" 2>/dev/null; then
      kill "$new_pid" 2>/dev/null || true
      for i in 1 2 3 4 5; do kill -0 "$new_pid" 2>/dev/null || break; /bin/sleep 1; done
      kill -9 "$new_pid" 2>/dev/null || true
    fi
    if [ -d "$backup" ]; then
      # Only move within this operation's unique stage. Never recursively
      # delete the installed application in order to perform rollback.
      if [ -e "$app" ]; then /bin/mv "$app" "$stage/failed.app" || return; fi
      /bin/mv "$backup" "$app" || { write_result false 'Update failed and backup restoration failed'; return; }
    fi
    write_result false 'Silent update failed; restored the previous client'
    if [ -x "$exe" ]; then "$exe" --updated --client-update-restart >/dev/null 2>&1 & fi
  elif [ "$status" -ne 0 ]; then
    write_result false 'Update helper failed before client exit; installation was not changed'
  fi
  # Retain failed payloads for diagnosis. Delete our stage only after verified
  # new-version stability, or before any installed application has moved.
  if [ "$status" -eq 0 ] || [ "$parent_exited" -eq 0 ]; then
    safe_stage && /bin/rm -rf -- "$stage"
  fi
}
trap finish EXIT
kill -0 "$parent" 2>/dev/null || exit 1
/usr/bin/printf '{"operationId":"%s","pid":%s}' "$operation" "$$" > "$ready.$$.tmp" && /bin/mv "$ready.$$.tmp" "$ready" || exit 1
until=$(( $(now) + 20 ))
while [ ! -f "$ack" ]; do
  [ ! -f "$cancel" ] && [ "$(now)" -lt "$until" ] || exit 1
  /bin/sleep 0.25
done
until=$(( $(now) + (parent_timeout + 999) / 1000 ))
while kill -0 "$parent" 2>/dev/null; do
  [ ! -f "$cancel" ] && [ "$(now)" -lt "$until" ] || exit 1
  /bin/sleep 0.25
done
parent_exited=1
[ ! -f "$cancel" ] || exit 1
[ ! -L "$app" ] && [ -d "$app" ] && [ ! -e "$backup" ] || exit 1
/bin/mv "$app" "$backup" || exit 1
/bin/mv "$new_app" "$app" || exit 1
since=$(( $(now) * 1000 ))
"$exe" --updated --client-update-restart >/dev/null 2>&1 &
new_pid=$!
until=$(( $(now) + (health_timeout + 999) / 1000 ))
stable_since=0
first_stamp=0
while [ "$(now)" -lt "$until" ]; do
  kill -0 "$new_pid" 2>/dev/null || exit 1
  version=$(/usr/bin/plutil -extract version raw -o - "$health" 2>/dev/null) || version=''
  health_pid=$(/usr/bin/plutil -extract pid raw -o - "$health" 2>/dev/null) || health_pid=0
  stamp=$(/usr/bin/plutil -extract updatedAt raw -o - "$health" 2>/dev/null) || stamp=0
  case "$stamp" in ''|*[!0-9]*) stamp=0 ;; esac
  time=$(now)
  if [ "$version" = "$target" ] && [ "$health_pid" = "$new_pid" ] && [ "$stamp" -ge "$since" ] && [ "$stamp" -le $(( time * 1000 + 2000 )) ] && [ $(( time * 1000 - stamp )) -le 15000 ]; then
    if [ "$stable_since" -eq 0 ]; then stable_since=$time; first_stamp=$stamp; fi
    if [ $(( (time - stable_since) * 1000 )) -ge "$stability" ] && [ "$stamp" -gt "$first_stamp" ]; then
      write_result true 'Client updated and provided stable version heartbeats' || exit 1
      exit 0
    fi
  else stable_since=0
  fi
  /bin/sleep 0.25
done
exit 1
`;
