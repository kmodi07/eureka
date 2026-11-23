// Tiny JSON-file store for WHOOP tokens. Single-user, local-only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, "..", "data", "tokens.json");

export function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function clearTokens() {
  try {
    fs.unlinkSync(FILE);
  } catch {}
}
