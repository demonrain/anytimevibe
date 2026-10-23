export type NodeRuntimeAsset = { version: string; fileName: string; sha256: string; url: string };

export function nodeRuntimeAsset(
  entries: unknown,
  platform: "win32" | "darwin",
  arch: "x64" | "arm64"
): NodeRuntimeAsset {
  if (!Array.isArray(entries)) throw new Error("nodejs.org returned an invalid release list");
  const release = entries.find((entry) => entry && typeof entry === "object"
    && (entry as { lts?: unknown }).lts && typeof (entry as { version?: unknown }).version === "string"
    && /^v22\.\d+\.\d+$/.test((entry as { version: string }).version)) as { version: string } | undefined;
  if (!release) throw new Error("Could not find the latest Node.js 22 LTS release");
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const fileName = `node-${release.version}-${platform === "win32" ? "win" : "darwin"}-${arch}.${extension}`;
  return { version: release.version.slice(1), fileName, sha256: "", url: `https://nodejs.org/dist/${release.version}/${fileName}` };
}

export function parseNodeRuntimeChecksum(text: string, fileName: string): string {
  const line = text.split(/\r?\n/).find((item) => item.trim().endsWith(` ${fileName}`) || item.trim().endsWith(` *${fileName}`));
  const checksum = line?.trim().split(/\s+/)[0];
  if (!checksum || !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`Official Node.js checksum missing for ${fileName}`);
  return checksum.toLowerCase();
}

export function nodeRuntimeArchiveName(version: string, platform: "win32" | "darwin", arch: "x64" | "arm64"): string {
  if (!/^22\.\d+\.\d+$/.test(version)) throw new Error("Invalid Node.js LTS version");
  return `node-v${version}-${platform === "win32" ? "win" : "darwin"}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
}
