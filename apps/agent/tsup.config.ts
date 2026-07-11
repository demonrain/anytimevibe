import { defineConfig } from "tsup";

// Packages that must stay external at runtime inside Electron.
// Everything else (ws, electron-updater, zod, workspace protocol, …) is bundled
// so packaged apps never resolve monorepo/workspace paths inside app.asar.
const runtimeExternals = ["electron", "bufferutil", "utf-8-validate"];

export default defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  // Explicit list — do NOT use noExternal: [/.*/], it also matches "electron"
  // and inlines the npm path-stub (a string), which breaks the main process.
  external: runtimeExternals,
  noExternal: [
    "@anytimevibe/protocol",
    "ws",
    "electron-updater",
    "zod",
    "builder-util-runtime",
    "fs-extra",
    "js-yaml",
    "lazy-val",
    "lodash.escaperegexp",
    "lodash.isequal",
    "semver",
    "tiny-typed-emitter",
    "debug",
    "graceful-fs",
    "jsonfile",
    "universalify",
    "argparse",
    "ms"
  ],
  esbuildOptions(options) {
    // Guarantee electron stays external even if transitive tooling re-marks it.
    const external = new Set<string>([
      ...((options.external as string[] | undefined) ?? []),
      ...runtimeExternals
    ]);
    options.external = [...external];
  }
});
