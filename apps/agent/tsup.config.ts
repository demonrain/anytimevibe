import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  // Keep Electron runtime modules external; bundle workspace protocol so
  // packaged apps do not depend on monorepo node_modules paths.
  external: ["electron", "electron-updater", "ws"],
  noExternal: ["@anytimevibe/protocol"]
});
