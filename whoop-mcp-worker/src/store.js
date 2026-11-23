// Encrypted-at-rest state (AES-256-GCM) in one D1 row. Holds WHOOP tokens, registered Claude
// clients, *hashes* of the tokens this server issues to Claude, pending consent requests,
// WHOOP OAuth states and the password-lockout log. D1 is strongly consistent, so every
// request sees the latest write.
import { b64, decrypt, encrypt } from "./crypto.js";

const empty = () => ({ whoop: null, clients: {}, codes: {}, accessTokens: {}, refreshTokens: {}, pending: {}, whoopStates: {}, failures: [] });
let ready = null;

export class Store {
  constructor(db, key) {
    this.db = db;
    this.key = key;
  }
  async init() {
    ready ??= this.db.prepare("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run().catch((e) => { ready = null; throw e; });
    await ready;
  }
  async load() {
    await this.init();
    const row = await this.db.prepare("SELECT value FROM kv WHERE key = 'state'").first();
    if (!row) return empty();
    return { ...empty(), ...JSON.parse(await decrypt(this.key, b64.decode(row.value))) };
  }
  async save(state) {
    await this.init();
    prune(state);
    const blob = b64.encode(await encrypt(this.key, JSON.stringify(state)));
    await this.db.prepare("INSERT INTO kv (key, value) VALUES ('state', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(blob).run();
  }
  /** Raw encrypted blob, for backup. Same layout as the Node server's state.enc. */
  async exportRaw() {
    await this.init();
    const row = await this.db.prepare("SELECT value FROM kv WHERE key = 'state'").first();
    return row ? row.value : null;
  }
}

function prune(state) {
  const now = Date.now();
  for (const bucket of ["codes", "accessTokens", "refreshTokens", "pending", "whoopStates"]) {
    for (const [k, v] of Object.entries(state[bucket])) if (v.expiresAt < now) delete state[bucket][k];
  }
  state.failures = state.failures.filter((t) => now - t < 15 * 60_000);
}
