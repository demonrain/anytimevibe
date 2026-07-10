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
