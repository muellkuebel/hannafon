#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { syncDevVars } from "./sync-family-hash.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = path.resolve(root, "../private");
const mediaDir = path.join(root, "worker/private-media");
const APP_PORT = Number(process.env.HANNAFON_APP_PORT || 4173);
const MEDIA_PORT = Number(process.env.HANNAFON_MEDIA_PORT || 4174);
const WORKER_PORT = Number(process.env.HANNAFON_WORKER_PORT || 8787);

function mime(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webmanifest": "application/manifest+json",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
      ".ttf": "font/ttf",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    }[ext] || "application/octet-stream"
  );
}

function copyMedia() {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  const allow = new Set([
    "people.json",
    "family.webp",
    "family.jpg",
    "family-blur.webp",
    "family-blur.jpg",
  ]);
  for (const name of fs.readdirSync(privateDir)) {
    if (allow.has(name)) fs.copyFileSync(path.join(privateDir, name), path.join(mediaDir, name));
  }
  const maskSrc = path.join(privateDir, "masks");
  const maskDst = path.join(mediaDir, "masks");
  if (fs.existsSync(maskSrc)) {
    fs.mkdirSync(maskDst, { recursive: true });
    for (const name of fs.readdirSync(maskSrc)) {
      if (name.endsWith(".webp") || name.endsWith(".png")) {
        fs.copyFileSync(path.join(maskSrc, name), path.join(maskDst, name));
      }
    }
  }
  // names.json / faces.json stay private and are not copied.
}

function staticServer(dir, port, urlPrefix = "") {
  const prefix = urlPrefix.replace(/\/$/, "");
  return http.createServer((req, res) => {
    const raw = decodeURIComponent((req.url || "/").split("?")[0]);
    let rel = raw;
    if (prefix) {
      if (raw === prefix) rel = "/";
      else if (raw.startsWith(prefix + "/")) rel = raw.slice(prefix.length);
      else {
        res.writeHead(404);
        res.end("not found");
        return;
      }
    }
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.normalize(path.join(dir, rel));
    if (!file.startsWith(dir)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(err.code === "ENOENT" ? 404 : 500);
        res.end(err.code === "ENOENT" ? "not found" : "error");
        return;
      }
      res.writeHead(200, { "Content-Type": mime(file), "Cache-Control": "no-cache" });
      res.end(data);
    });
  }).listen(port, "127.0.0.1");
}

function spawnLogged(cmd, args, opts) {
  const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const label = path.basename(cmd);
  const onData = (buf) => {
    const text = buf.toString();
    // Never echo a family code if a child process were to print one.
    const redacted = text.replace(/HANNAFON_FAMILY_CODE|FAMILY_CODE(?!_HASH)/g, "[code]");
    process.stdout.write(redacted);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (code && code !== 0) process.stderr.write(`${label} exited ${code}\n`);
  });
  return child;
}

if (!fs.existsSync(path.join(privateDir, "people.json"))) {
  console.error("private media missing; run scripts/generate-assets.py first");
  process.exit(1);
}

try {
  syncDevVars();
  console.log("FAMILY_CODE_HASH synced from environment");
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

copyMedia();
console.log("private media copied for the worker (not in git)");

const mediaServer = staticServer(mediaDir, MEDIA_PORT);
const appServer = staticServer(root, APP_PORT, "/hannafon");
console.log(`app  http://127.0.0.1:${APP_PORT}/hannafon/`);
console.log(`media http://127.0.0.1:${MEDIA_PORT}/ (localhost only)`);

const wrangler = path.join(root, "node_modules/.bin/wrangler");
const worker = spawnLogged(wrangler, ["dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1"], {
  cwd: path.join(root, "worker"),
  env: { ...process.env },
});

function shutdown() {
  worker.kill("SIGTERM");
  mediaServer.close();
  appServer.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
