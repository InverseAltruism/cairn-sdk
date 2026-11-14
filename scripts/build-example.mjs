// Bundle the browser examples via the esbuild JS API (the CLI shim is flaky under pnpm when multiple esbuild versions
// are hoisted). Outputs app.js next to each index.html so the page loads with no toolchain. The examples import the
// package by its published name, which resolves to this repo's dist/ through the exports map: run `pnpm build` first.
import { build } from "esbuild";

for (const dir of ["examples/hello-csd", "examples/integrate-wallet"]) {
  await build({
    entryPoints: [`${dir}/app.ts`],
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    outfile: `${dir}/app.js`,
    logLevel: "info",
  });
  console.log(`built ${dir}/app.js`);
}
