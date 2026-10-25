// Bundles the worker into dist/ as a self-contained Cloud Run source folder.
// firebase-admin stays external because its gRPC stack loads files at runtime.
import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const external = ["firebase-admin"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: external.map((name) => `${name}*`),
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

await writeFile(
  "dist/package.json",
  JSON.stringify(
    {
      name: "ownrabbit-worker",
      private: true,
      type: "module",
      scripts: { start: "node --enable-source-maps server.js" },
      dependencies: Object.fromEntries(external.map((name) => [name, pkg.dependencies[name]])),
    },
    null,
    2,
  ),
);
await copyFile("Dockerfile", "dist/Dockerfile");
await copyFile(".dockerignore", "dist/.dockerignore");
console.log("worker built -> dist/");
