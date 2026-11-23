// WHOOP API v2 client: OAuth code exchange, refresh, read-only fetches, revoke.
// Works on one loaded state object and saves it through the store.
import { hex, randomBytes } from "./crypto.js";

export class Whoop {
  constructor(cfg, store, state) {
    this.cfg = cfg.whoop;
    this.redirectUri = cfg.whoopRedirectUri;
    this.store = store;
    this.state = state;
    this.refreshing = null;
  }

  get linked() { return Boolean(this.state.whoop?.refreshToken || this.state.whoop?.accessToken); }

  authUrl() {
    const state = hex(randomBytes(24)); // WHOOP requires >= 8 chars
    const u = new URL(this.cfg.oauthBase + "/auth");
    u.search = new URLSearchParams({
      response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.redirectUri,
      scope: this.cfg.scopes.join(" "), state,
    }).toString();
    return { url: u.toString(), state };
  }

  async #token(params) {
    const res = await fetch(this.cfg.oauthBase + "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
    });
    if (!res.ok) throw new Error(`WHOOP token endpoint returned ${res.status}`); // body may echo secrets; don't log it
    const t = await res.json();
    this.state.whoop = {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? this.state.whoop?.refreshToken ?? null,
      expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
      scope: t.scope ?? this.cfg.scopes.join(" "),
      linkedAt: this.state.whoop?.linkedAt ?? new Date().toISOString(),
    };
    await this.store.save(this.state);
  }

  exchangeCode(code) {
    return this.#token({ grant_type: "authorization_code", code, redirect_uri: this.redirectUri });
  }

  async #accessToken() {
    let w = this.state.whoop;
    if (!w) throw new Error("WHOOP is not linked. Open /admin on this server to link it.");
    if (Date.now() < w.expiresAt - 60_000) return w.accessToken;
    if (!w.refreshToken) throw new Error("WHOOP session expired and no refresh token is stored. Re-link WHOOP at /admin.");
    try {
      // WHOOP refresh tokens rotate, so concurrent calls in this request share one refresh.
      this.refreshing ??= this.#token({ grant_type: "refresh_token", refresh_token: w.refreshToken, scope: "offline" }).finally(() => { this.refreshing = null; });
      await this.refreshing;
    } catch (e) {
      // If another request (in another isolate) refreshed first, its result is already stored:
      // reload and use that instead of failing.
      this.state = await this.store.load();
      w = this.state.whoop;
      if (w && Date.now() < w.expiresAt - 60_000) return w.accessToken;
      throw e;
    }
    return this.state.whoop.accessToken;
  }

  async get(path, query = {}) {
    const u = new URL(this.cfg.apiBase + path);
    for (const [k, v] of Object.entries(query)) if (v != null) u.searchParams.set(k, String(v));
    const res = await fetch(u, { headers: { Authorization: `Bearer ${await this.#accessToken()}` } });
    if (res.status === 401) throw new Error("WHOOP rejected the access token. Re-link WHOOP at /admin.");
    if (res.status === 429) throw new Error("WHOOP rate limit reached. Try again in a minute.");
    if (!res.ok) throw new Error(`WHOOP ${path} returned ${res.status}`);
    return res.json();
  }

  /** Paginated collection fetch (WHOOP returns { records, next_token }, max 25 per page). */
  async collection(path, { start, end, max = 25 } = {}) {
    const out = [];
    let nextToken;
    do {
      const page = await this.get(path, { limit: Math.min(25, max - out.length), start, end, nextToken });
      out.push(...(page.records ?? []));
      nextToken = page.next_token;
    } while (nextToken && out.length < max);
    return out;
  }

  /** Revoke this app's access at WHOOP (best effort), then forget tokens locally. */
  async disconnect() {
    try {
      if (this.state.whoop) {
        await fetch(this.cfg.apiBase + "/v2/user/access", {
          method: "DELETE",
          headers: { Authorization: `Bearer ${await this.#accessToken()}` },
        });
      }
    } catch { /* still remove local tokens */ }
    this.state.whoop = null;
    await this.store.save(this.state);
  }
}
