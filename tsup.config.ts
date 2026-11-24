import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node18",
    splitting: false,
    treeshake: true,
    outExtension({ format }) {
      return {
        js: format === "cjs" ? ".cjs" : ".js",
      };
    },
  },
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    target: "node18",
    splitting: false,
    treeshake: true,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
