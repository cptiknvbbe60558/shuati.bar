#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, ".deploy", "site");
const entries = [
  ".nojekyll",
  "CNAME",
  "_headers",
  "_worker.js",
  "app.js",
  "assets",
  "data",
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "styles.css",
  "theme.css"
];

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const entry of entries) {
  const source = path.join(root, entry);
  const target = path.join(output, entry);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing deploy entry: ${entry}`);
  }
  fs.cpSync(source, target, { recursive: true });
}

console.log(JSON.stringify({
  ok: true,
  output,
  entries
}, null, 2));
