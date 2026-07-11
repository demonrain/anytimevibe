import fs from "node:fs";

const source = fs.readFileSync("apps/agent/dist/main.js", "utf8");
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

const external = [...found]
  .filter((name) => !name.startsWith("node:") && !nodeBuiltins.has(name))
  .sort();

const unexpected = external.filter((name) => name !== "electron" && !optionalNatives.has(name));
console.log(external.length ? external.join("\n") : "(only electron/node builtins)");
if (unexpected.length) {
  console.error("Unexpected external requires:", unexpected.join(", "));
  process.exitCode = 1;
}
