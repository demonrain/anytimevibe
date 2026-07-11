import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mainJs = path.join(root, "apps/agent/dist/main.js");
const source = fs.readFileSync(mainJs, "utf8");
const re = /require\(["']([^"']+)["']\)/g;
const found = new Set();
let match;
while ((match = re.exec(source))) found.add(match[1]);

const nodeBuiltins = new Set([
  "fs", "path", "os", "child_process", "util", "crypto", "stream", "events",
  "http", "https", "net", "tls", "url", "zlib", "buffer", "assert", "tty",
  "constants", "module", "process", "readline", "string_decoder", "querystring",
  "diagnostics_channel", "async_hooks", "perf_hooks", "worker_threads"
]);

// Optional native accelerators for `ws` (loaded inside try/catch at runtime).
const optionalNatives = new Set(["bufferutil", "utf-8-validate"]);

// Electron runtime must remain an external require — never bundle the npm path stub.
if (!found.has("electron")) {
  console.error("FATAL: dist/main.js does not require('electron').");
  console.error("The Electron npm package was likely bundled (path stub). Packaging will break.");
  process.exitCode = 1;
}

if (/@anytimevibe\//.test(source)) {
  console.error("FATAL: dist/main.js still references @anytimevibe/* — workspace packages must be bundled.");
  process.exitCode = 1;
}

const external = [...found]
  .filter((name) => !name.startsWith("node:") && !nodeBuiltins.has(name))
  .sort();

const unexpected = external.filter((name) => name !== "electron" && !optionalNatives.has(name));
console.log(external.length ? external.join("\n") : "(only electron/node builtins)");
if (unexpected.length) {
  console.error("Unexpected external requires:", unexpected.join(", "));
  process.exitCode = 1;
}
