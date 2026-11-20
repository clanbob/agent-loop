import { build } from "esbuild";
import { build as viteBuild } from "vite";

const watchRendererOnly = process.argv.includes("--main-only");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  sourcemap: true,
  logLevel: "warning",
};

await build({ ...common, entryPoints: ["app/main/main.ts"], outfile: "dist/app/main.cjs" });
await build({ ...common, entryPoints: ["app/preload/preload.ts"], outfile: "dist/app/preload.cjs" });

if (!watchRendererOnly) {
  await viteBuild({ configFile: "vite.config.ts", logLevel: "warn" });
}

console.log("App built.");
