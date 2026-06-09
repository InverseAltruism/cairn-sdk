// Bundle the hello-csd browser example via the esbuild JS API (the CLI shim is
// flaky under pnpm when multiple esbuild versions are hoisted). Outputs app.js
// next to index.html so the page loads with no toolchain.
import { build } from "esbuild";

await build({
  entryPoints: ["examples/hello-csd/app.ts"],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: "examples/hello-csd/app.js",
  logLevel: "info",
});
console.log("built examples/hello-csd/app.js");
