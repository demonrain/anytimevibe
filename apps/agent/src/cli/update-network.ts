export type EngineUpdateNetworkOptions = {
  relayUrl?: string;
  engineUpdateBaseUrl?: string | null;
  npmRegistryUrl?: string | null;
  engineUpdateProxyUrl?: string | null;
};

let network: { relayUrl: string; engineBase: string | null; registry: string | null; proxy: string } = { relayUrl: "", engineBase: "", registry: "", proxy: "" };
let revision = 0;

function validatedUrl(value: string | null | undefined, credentials = false): string {
  if (!value?.trim()) return "";
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return "";
    if (url.hash || url.search) return "";
    if (credentials ? !url.username || !url.password || url.pathname !== "/" : !!url.username || !!url.password) return "";
    return credentials ? url.toString() : url.toString().replace(/\/+$/, "");
  } catch { return ""; }
}

/** Configure only update checks and maintenance subprocesses, never task/model traffic. */
export function configureEngineUpdateNetwork(options: EngineUpdateNetworkOptions): void {
  const relayUrl = validatedUrl(options.relayUrl);
  const sameRelay = relayUrl === network.relayUrl;
  const next = {
    relayUrl,
    engineBase: options.engineUpdateBaseUrl === null ? null : options.engineUpdateBaseUrl === undefined && sameRelay ? network.engineBase : validatedUrl(options.engineUpdateBaseUrl),
    registry: options.npmRegistryUrl === null ? null : options.npmRegistryUrl === undefined && sameRelay ? network.registry : validatedUrl(options.npmRegistryUrl),
    proxy: options.engineUpdateProxyUrl === undefined && sameRelay ? network.proxy : validatedUrl(options.engineUpdateProxyUrl, true)
  };
  if (JSON.stringify(next) !== JSON.stringify(network)) revision++;
  network = next;
}

export function engineUpdateNetworkRevision(): number { return revision; }

export function npmUpdateRegistryCandidates(): string[] {
  const override = validatedUrl(process.env.ANYTIMEVIBE_NPM_REGISTRY);
  const middle = network.registry === null ? "" : network.registry || (network.relayUrl ? `${network.relayUrl}/api/agent/npm` : "");
  return [...new Set([
    ...(override ? [override] : []),
    ...(middle ? [middle] : ["https://registry.npmjs.org", "https://registry.npmmirror.com"])
  ])];
}

export function resolveEngineUpdateUrl(kind: "cursor-installer" | "antigravity-latest", fallbackUrl: string): string {
  const base = network.engineBase === null ? "" : network.engineBase || (network.relayUrl ? `${network.relayUrl}/api/agent/engine` : "");
  if (!base) return fallbackUrl;
  if (kind === "antigravity-latest") return `${base}/antigravity/releases/latest`;
  const windows = new URL(fallbackUrl).searchParams.get("win32") === "true";
  return `${base}/cursor/install${windows ? "?win32=true" : ""}`;
}

/** Call only for installer/update children; the input environment remains untouched. */
export function buildEngineMaintenanceNetworkEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...baseEnv };
  if (!network.proxy) return next;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "npm_config_proxy", "npm_config_https_proxy"]) next[key] = network.proxy;
  delete next.ALL_PROXY;
  delete next.all_proxy;
  const directHosts = [network.relayUrl, network.engineBase, network.registry].filter((url): url is string => !!url).map((url) => new URL(url).hostname);
  next.NO_PROXY = next.no_proxy = [...new Set(["localhost", "127.0.0.1", "::1", ...directHosts])].join(",");
  next.NODE_USE_ENV_PROXY = "1";
  return next;
}

function redactOutputWithProxy(text: string, proxy: string): string {
  let safe = text.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@\r\n]+@/gi, "$1[redacted]@")
    .replace(/((?:proxy-authorization|authorization)\s*[:=]\s*)(?:Basic|Bearer)\s+[^\s"'<>]+/gi, "$1[redacted]");
  if (proxy) {
    const url = new URL(proxy);
    const prefix = `${url.protocol}//${url.username}:`;
    // A chunk can end halfway through credentials. Never echo any proxy password
    // after the credential-bearing prefix, even before an '@' delimiter arrives.
    safe = safe.replace(new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s/@\\r\\n]*`, "gi"), `${url.protocol}//[redacted]`);
    for (const secret of new Set([url.password, decodeURIComponent(url.password)])) {
      if (secret) safe = safe.split(secret).join("[redacted]");
    }
  }
  return safe;
}

export function redactEngineUpdateOutput(text: string): string { return redactOutputWithProxy(text, network.proxy); }

/** Redacts complete lines while retaining incomplete output until its delimiter arrives. */
export function createEngineUpdateOutputRedactor(emit: (text: string) => void): { write(chunk: string): void; flush(): void } {
  let pending = "";
  let discardLongLine = false;
  const proxy = network.proxy;
  const write = (chunk: string) => {
    if (discardLongLine) {
      const end = chunk.indexOf("\n");
      if (end < 0) return;
      chunk = chunk.slice(end + 1);
      discardLongLine = false;
    }
    pending += chunk;
    const lines = pending.split(/(?<=\r?\n)/);
    pending = lines.pop() || "";
    if (lines.length) emit(redactOutputWithProxy(lines.join(""), proxy));
    if (pending.length > 64_000) {
      pending = ""; discardLongLine = true;
      emit("[update output line omitted]\n");
    }
  };
  const flush = () => {
    if (!pending) return;
    emit(redactOutputWithProxy(pending, proxy));
    pending = "";
  };
  return { write, flush };
}
