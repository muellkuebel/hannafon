#!/usr/bin/env node
// Derive FAMILY_CODE_HASH from HANNAFON_FAMILY_CODE and write it to
// gitignored worker/.dev.vars. Never prints or writes the plaintext code.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const devvars = path.join(root, "worker/.dev.vars");

function normalize(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function hashFamilyCode(code) {
  const n = normalize(code);
  if (!n) throw new Error("HANNAFON_FAMILY_CODE missing or empty");
  return crypto.createHash("sha256").update(n, "utf8").digest("hex");
}

export function syncDevVars(env = process.env) {
  const raw = env.HANNAFON_FAMILY_CODE;
  if (!raw) throw new Error("HANNAFON_FAMILY_CODE is not set");
  const digest = hashFamilyCode(raw);
  let text = fs.existsSync(devvars) ? fs.readFileSync(devvars, "utf8") : "";
  if (/^FAMILY_CODE_HASH=.*$/m.test(text)) {
    text = text.replace(/^FAMILY_CODE_HASH=.*$/m, `FAMILY_CODE_HASH=${digest}`);
  } else {
    text = `FAMILY_CODE_HASH=${digest}\n${text}`;
  }
  text = text.replace(/^FAMILY_CODE=.*\n?/m, "");
  fs.writeFileSync(devvars, text, { mode: 0o600 });
  return { hashLength: digest.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { hashLength } = syncDevVars();
  console.log("FAMILY_CODE_HASH updated (length " + hashLength + ")");
}
