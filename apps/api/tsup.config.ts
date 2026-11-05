import { cpSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: [/^@frontrun\//],
  clean: true,
  sourcemap: true,
  // CommonJS dependencies inside an ESM bundle still call require() for Node builtins.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  onSuccess: async () => {
    cpSync("../../packages/server/drizzle", "dist/drizzle", { recursive: true });
  },
});
