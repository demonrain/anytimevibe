export function normalizeWindowsCommandPath(command: string): string {
  const trimmed = command.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function quoteArgument(argument: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(argument)) return argument;
  return `"${argument.replace(/"/g, '""')}"`;
}

export function windowsCmdArguments(command: string, args: string[]): string[] {
  const executable = normalizeWindowsCommandPath(command).replace(/"/g, '""');
  const commandLine = [`""${executable}"`, ...args.map(quoteArgument)].join(" ") + '"';
  return ["/d", "/s", "/c", commandLine];
}

/** Prefer real Windows launchers over extensionless npm/bash shims (which CreateProcess cannot spawn). */
export function windowsExecutableRank(filePath: string): number {
  const lower = normalizeWindowsCommandPath(filePath).toLowerCase();
  if (lower.endsWith(".exe") || lower.endsWith(".com")) return 0;
  if (lower.endsWith(".cmd")) return 1;
  if (lower.endsWith(".bat")) return 2;
  if (lower.endsWith(".ps1")) return 3;
  return 10;
}

/**
 * True when Node `spawn(path)` cannot run the file directly on Windows.
 * .cmd/.bat and extensionless npm shims must go through cmd.exe.
 */
export function windowsNeedsCmdShim(command: string): boolean {
  if (process.platform !== "win32") return false;
  const lower = normalizeWindowsCommandPath(command).toLowerCase();
  return !(lower.endsWith(".exe") || lower.endsWith(".com"));
}

/** Sibling Windows launcher paths for an extensionless or bare name. */
export function windowsLauncherCandidates(filePath: string): string[] {
  const normalized = normalizeWindowsCommandPath(filePath);
  const lower = normalized.toLowerCase();
  if (/\.(exe|com|cmd|bat|ps1)$/i.test(lower)) return [normalized];
  return [
    `${normalized}.cmd`,
    `${normalized}.exe`,
    `${normalized}.bat`,
    `${normalized}.com`,
    normalized
  ];
}
