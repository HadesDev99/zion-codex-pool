#!/usr/bin/env node
/**
 * Copy the compiled pooler + runtime deps into extension/resources/pooler
 * so the VSIX can spawn `node resources/pooler/index.js` without the repo checkout.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const extRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(extRoot, "..");
const outDir = path.join(extRoot, "resources", "pooler");

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

console.log("[bundle-pooler] building server…");
execSync("npm run build", { cwd: repoRoot, stdio: "inherit" });

rmrf(outDir);
fs.mkdirSync(outDir, { recursive: true });
copyDir(path.join(repoRoot, "dist"), outDir);

const pkg = {
  name: "zion-codex-pool-runtime",
  private: true,
  type: "module",
  dependencies: {
    ws: require(path.join(repoRoot, "package.json")).dependencies.ws,
  },
};
fs.writeFileSync(path.join(outDir, "package.json"), JSON.stringify(pkg, null, 2));

console.log("[bundle-pooler] npm install --omit=dev in resources/pooler…");
execSync("npm install --omit=dev", { cwd: outDir, stdio: "inherit" });

console.log(`[bundle-pooler] ready → ${outDir}`);
