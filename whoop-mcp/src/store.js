// Encrypted-at-rest state file (AES-256-GCM). Holds WHOOP tokens, registered Claude
// clients, and *hashes* of the tokens this server issues to Claude.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const empty = () => ({ whoop: null, clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} });

export class Store {
  constructor(file, key) {
    this.file = file;
    this.key = key;
    this.state = this.#read();
  }
  #read() {
    let buf;
    try { buf = fs.readFileSync(this.file); } catch { return empty(); }
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), data = buf.subarray(28);
    const d = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
    d.setAuthTag(tag);
    return { ...empty(), ...JSON.parse(Buffer.concat([d.update(data), d.final()]).toString("utf8")) };
  }
  save() {
    this.#prune();
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(this.state), "utf8"), c.final()]);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, Buffer.concat([iv, c.getAuthTag(), data]), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  #prune() {
    const now = Date.now();
    for (const bucket of ["codes", "accessTokens", "refreshTokens"]) {
      for (const [k, v] of Object.entries(this.state[bucket])) if (v.expiresAt < now) delete this.state[bucket][k];
    }
  }
}

export const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
