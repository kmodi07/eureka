// OAuth 2.1 authorization server that lets Claude connect to this MCP server.
// The MCP SDK handles discovery metadata, dynamic client registration, PKCE checks and
// the HTTP endpoints; this class supplies storage and the owner-only consent step.
import crypto from "node:crypto";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { hashToken, newToken } from "./store.js";

export class OwnerOnlyProvider {
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.pending = new Map(); // requestId -> { clientId, params, expiresAt }  (memory only, 10 min)
    const s = store.state;
    this.clientsStore = {
      getClient: (id) => s.clients[id],
      registerClient: (client) => {
        const bad = (client.redirect_uris ?? []).filter((u) => !cfg.allowedRedirectUris.includes(String(u)));
        if (bad.length) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${bad.join(", ")}`);
        const full = { ...client, client_id: crypto.randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        if (Object.keys(s.clients).length > 50) {
          // keep the store bounded: drop the oldest registration
          const oldest = Object.values(s.clients).sort((a, b) => a.client_id_issued_at - b.client_id_issued_at)[0];
          delete s.clients[oldest.client_id];
        }
        s.clients[full.client_id] = full;
        store.save();
        return full;
      },
    };
  }

  // Step 1: Claude sends the owner here. We park the request and show the password page.
  async authorize(client, params, res) {
    const requestId = newToken(18);
    this.pending.set(requestId, { clientId: client.client_id, params, expiresAt: Date.now() + 10 * 60_000 });
    res.redirect(302, `/consent?request=${encodeURIComponent(requestId)}`);
  }

  takePending(requestId) {
    const p = this.pending.get(requestId);
    if (!p || p.expiresAt < Date.now()) return null;
    return p;
  }
  dropPending(requestId) { this.pending.delete(requestId); }

  // Step 2: after the owner proves who they are (and WHOOP is linked), issue a one-time code.
  issueCodeRedirect(requestId) {
    const p = this.takePending(requestId);
    if (!p) throw new Error("Authorization request expired. Start again from Claude.");
    this.pending.delete(requestId);
    const code = newToken();
    this.store.state.codes[hashToken(code)] = {
      clientId: p.clientId,
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      resource: p.params.resource?.toString(),
      expiresAt: Date.now() + 5 * 60_000,
    };
    this.store.save();
    const u = new URL(p.params.redirectUri);
    u.searchParams.set("code", code);
    if (p.params.state) u.searchParams.set("state", p.params.state);
    return u.toString();
  }

  denyRedirect(requestId) {
    const p = this.takePending(requestId);
    this.pending.delete(requestId);
    if (!p) return null;
    const u = new URL(p.params.redirectUri);
    u.searchParams.set("error", "access_denied");
    if (p.params.state) u.searchParams.set("state", p.params.state);
    return u.toString();
  }

  async challengeForAuthorizationCode(client, code) {
    const c = this.store.state.codes[hashToken(code)];
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.codeChallenge;
  }

  #issueTokens(clientId, resource) {
    const s = this.store.state;
    const access = newToken(), refresh = newToken();
    const now = Date.now();
    s.accessTokens[hashToken(access)] = { clientId, resource, expiresAt: now + this.cfg.accessTokenTtlSec * 1000 };
    s.refreshTokens[hashToken(refresh)] = { clientId, resource, expiresAt: now + this.cfg.refreshTokenTtlSec * 1000 };
    this.store.save();
    return { access_token: access, token_type: "Bearer", expires_in: this.cfg.accessTokenTtlSec, refresh_token: refresh, scope: "whoop.read" };
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const key = hashToken(code);
    const c = this.store.state.codes[key];
    delete this.store.state.codes[key]; // single use, even on failure
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) {
      this.store.save();
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    if (redirectUri && redirectUri !== c.redirectUri) {
      this.store.save();
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.#issueTokens(client.client_id, c.resource);
  }

  async exchangeRefreshToken(client, refreshToken) {
    const key = hashToken(refreshToken);
    const r = this.store.state.refreshTokens[key];
    if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) throw new InvalidGrantError("Invalid or expired refresh token");
    delete this.store.state.refreshTokens[key]; // rotate: old refresh token stops working
    return this.#issueTokens(client.client_id, r.resource);
  }

  async verifyAccessToken(token) {
    const t = this.store.state.accessTokens[hashToken(token)];
    if (!t || t.expiresAt < Date.now()) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token, clientId: t.clientId, scopes: ["whoop.read"],
      expiresAt: Math.floor(t.expiresAt / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
    };
  }

  async revokeToken(_client, { token }) {
    const key = hashToken(token);
    delete this.store.state.accessTokens[key];
    delete this.store.state.refreshTokens[key];
    this.store.save();
  }

  revokeAll() {
    const s = this.store.state;
    s.accessTokens = {}; s.refreshTokens = {}; s.codes = {};
    this.pending.clear();
    this.store.save();
  }
}

// Owner password check with a simple global lockout against guessing.
export class OwnerGate {
  constructor(hash) { this.hash = hash; this.failures = []; }
  check(password) {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 15 * 60_000);
    if (this.failures.length >= 5) return { ok: false, locked: true };
    const ok = crypto.timingSafeEqual(crypto.createHash("sha256").update(String(password ?? "")).digest(), this.hash);
    if (!ok) this.failures.push(now);
    return { ok, locked: false };
  }
}
