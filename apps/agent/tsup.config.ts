import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/preload.ts"],
  format: ["cjs"],
  platform: "node",
  target: "es2022",
  sourcemap: true,
  clean: true,
  // Electron provides its own runtime. Bundle every npm dependency so
  // packaged apps never resolve monorepo/workspace paths inside app.asar.
  external: ["electron"],
  noExternal: [/.*/]
});
