// OAuth 2.1 authorization server for Claude: discovery metadata, dynamic client registration
// (restricted to Claude's callback), PKCE authorization codes, token issue/refresh/revoke and
// bearer verification. Same contract as the MCP SDK's Express router, on Web-standard APIs.
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { hashToken, hex, newToken, randomBytes, sha256b64url, timingSafeEqual } from "./crypto.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
export const oauthError = (error, error_description, status = 400, headers = {}) => json({ error, error_description }, status, headers);
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

export const asMetadata = (cfg) => ({
  issuer: cfg.publicUrl.href,
  authorization_endpoint: new URL("/authorize", cfg.publicUrl).href,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint: new URL("/token", cfg.publicUrl).href,
  token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  scopes_supported: ["whoop.read"],
  revocation_endpoint: new URL("/revoke", cfg.publicUrl).href,
  revocation_endpoint_auth_methods_supported: ["client_secret_post"],
  registration_endpoint: new URL("/register", cfg.publicUrl).href,
});

export const prmMetadata = (cfg) => ({
  resource: cfg.mcpUrl.href,
  authorization_servers: [cfg.publicUrl.href],
  scopes_supported: ["whoop.read"],
  resource_name: "Personal WHOOP (read-only)",
  bearer_methods_supported: ["header"],
});

export const prmUrl = (cfg) => new URL("/.well-known/oauth-protected-resource/mcp", cfg.publicUrl).href;

// ---- Dynamic client registration (RFC 7591) ----
export async function register({ cfg, store, state }, request) {
  let body;
  try { body = await request.json(); } catch { return oauthError("invalid_client_metadata", "Body must be JSON"); }
  const parsed = OAuthClientMetadataSchema.safeParse(body);
  if (!parsed.success) return oauthError("invalid_client_metadata", parsed.error.message);
  const meta = parsed.data;
  const bad = (meta.redirect_uris ?? []).filter((u) => !cfg.allowedRedirectUris.includes(String(u)));
  if (bad.length) return oauthError("invalid_client_metadata", `redirect_uri not allowed: ${bad.join(", ")}`);
  const isPublic = meta.token_endpoint_auth_method === "none";
  const client = {
    ...meta,
    client_id: crypto.randomUUID(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    ...(isPublic ? {} : { client_secret: hex(randomBytes(32)), client_secret_expires_at: 0 }),
  };
  const ids = Object.keys(state.clients);
  if (ids.length > 50) {
    const oldest = Object.values(state.clients).sort((a, b) => a.client_id_issued_at - b.client_id_issued_at)[0];
    delete state.clients[oldest.client_id];
  }
  state.clients[client.client_id] = client;
  await store.save(state);
  return json(client, 201);
}

// ---- Authorization request: validate, park it, send the owner to the consent page ----
export async function authorize({ cfg, store, state }, request) {
  const params = request.method === "POST" ? new URLSearchParams(await request.text()) : new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  if (!clientId) return oauthError("invalid_request", "client_id is required");
  const client = state.clients[clientId];
  if (!client) return oauthError("invalid_client", "Invalid client_id");
  let redirectUri = params.get("redirect_uri") ?? undefined;
  if (redirectUri !== undefined) {
    if (!URL.canParse(redirectUri)) return oauthError("invalid_request", "redirect_uri must be a valid URL");
    if (!client.redirect_uris.includes(redirectUri)) return oauthError("invalid_request", "Unregistered redirect_uri");
  } else if (client.redirect_uris.length === 1) redirectUri = client.redirect_uris[0];
  else return oauthError("invalid_request", "redirect_uri must be specified when client has multiple registered URIs");

  const st = params.get("state") ?? undefined;
  const fail = (code, desc) => {
    const u = new URL(redirectUri);
    u.searchParams.set("error", code); u.searchParams.set("error_description", desc);
    if (st) u.searchParams.set("state", st);
    return redirect(u.href);
  };
  if (params.get("response_type") !== "code") return fail("invalid_request", "response_type must be code");
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge) return fail("invalid_request", "code_challenge is required");
  if (params.get("code_challenge_method") !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const resource = params.get("resource") ?? undefined;
  if (resource !== undefined && !URL.canParse(resource)) return fail("invalid_request", "resource must be a valid URL");

  const requestId = newToken(18);
  state.pending[requestId] = { clientId, state: st, redirectUri, codeChallenge, resource, expiresAt: Date.now() + 10 * 60_000 };
  await store.save(state);
  return redirect(`/consent?request=${encodeURIComponent(requestId)}`);
}

export function takePending(state, requestId) {
  const p = state.pending[requestId];
  return p && p.expiresAt >= Date.now() ? p : null;
}

// After the owner proved who they are (and WHOOP is linked): one-time code back to Claude.
export async function issueCodeRedirect({ cfg, store, state }, requestId) {
  const p = takePending(state, requestId);
  if (!p) throw new Error("Authorization request expired. Start again from Claude.");
  delete state.pending[requestId];
  const code = newToken();
  state.codes[await hashToken(code)] = { clientId: p.clientId, codeChallenge: p.codeChallenge, redirectUri: p.redirectUri, resource: p.resource, expiresAt: Date.now() + 5 * 60_000 };
  await store.save(state);
  const u = new URL(p.redirectUri);
  u.searchParams.set("code", code);
  if (p.state) u.searchParams.set("state", p.state);
  return u.href;
}

export async function denyRedirect({ store, state }, requestId) {
  const p = takePending(state, requestId);
  delete state.pending[requestId];
  await store.save(state);
  if (!p) return null;
  const u = new URL(p.redirectUri);
  u.searchParams.set("error", "access_denied");
  if (p.state) u.searchParams.set("state", p.state);
  return u.href;
}

// ---- Token endpoint ----
function authenticateClient(state, form) {
  const clientId = form.get("client_id");
  if (!clientId) return { error: oauthError("invalid_request", "client_id is required") };
  const client = state.clients[clientId];
  if (!client) return { error: oauthError("invalid_client", "Invalid client_id") };
  if (client.client_secret) {
    const secret = form.get("client_secret");
    if (!secret) return { error: oauthError("invalid_client", "Client secret is required") };
    if (!timingSafeEqual(client.client_secret, secret)) return { error: oauthError("invalid_client", "Invalid client_secret") };
  }
  return { client };
}

async function issueTokens({ cfg, store, state }, clientId, resource) {
  const access = newToken(), refresh = newToken(), now = Date.now();
  state.accessTokens[await hashToken(access)] = { clientId, resource, expiresAt: now + cfg.accessTokenTtlSec * 1000 };
  state.refreshTokens[await hashToken(refresh)] = { clientId, resource, expiresAt: now + cfg.refreshTokenTtlSec * 1000 };
  await store.save(state);
  return { access_token: access, token_type: "Bearer", expires_in: cfg.accessTokenTtlSec, refresh_token: refresh, scope: "whoop.read" };
}

export async function token(ctx, request) {
  const { store, state } = ctx;
  const form = new URLSearchParams(await request.text());
  const auth = authenticateClient(state, form);
  if (auth.error) return auth.error;
  const client = auth.client;
  switch (form.get("grant_type")) {
    case "authorization_code": {
      const code = form.get("code"), verifier = form.get("code_verifier"), redirectUri = form.get("redirect_uri");
      if (!code || !verifier) return oauthError("invalid_request", "code and code_verifier are required");
      const key = await hashToken(code);
      const c = state.codes[key];
      if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) return oauthError("invalid_grant", "Invalid or expired authorization code");
      // PKCE is checked before the code is consumed, as in the SDK.
      if ((await sha256b64url(verifier)) !== c.codeChallenge) return oauthError("invalid_grant", "code_verifier does not match the challenge");
      delete state.codes[key]; // single use
      if (redirectUri && redirectUri !== c.redirectUri) { await store.save(state); return oauthError("invalid_grant", "redirect_uri does not match the authorization request"); }
      return json(await issueTokens(ctx, client.client_id, c.resource));
    }
    case "refresh_token": {
      const rt = form.get("refresh_token");
      if (!rt) return oauthError("invalid_request", "refresh_token is required");
      const key = await hashToken(rt);
      const r = state.refreshTokens[key];
      if (!r || r.clientId !== client.client_id || r.expiresAt < Date.now()) return oauthError("invalid_grant", "Invalid or expired refresh token");
      delete state.refreshTokens[key]; // rotate: old refresh token stops working
      return json(await issueTokens(ctx, client.client_id, r.resource));
    }
    default:
      return oauthError("unsupported_grant_type", "The grant type is not supported by this authorization server.");
  }
}

export async function revoke({ store, state }, request) {
  const form = new URLSearchParams(await request.text());
  const auth = authenticateClient(state, form);
  if (auth.error) return auth.error;
  const t = form.get("token");
  if (!t) return oauthError("invalid_request", "token is required");
  const key = await hashToken(t);
  delete state.accessTokens[key]; delete state.refreshTokens[key];
  await store.save(state);
  return json({}, 200);
}

export async function revokeAll({ store, state }) {
  state.accessTokens = {}; state.refreshTokens = {}; state.codes = {}; state.pending = {};
  await store.save(state);
}

// ---- Bearer verification for /mcp ----
export async function verifyBearer({ cfg, state }, request) {
  const challenge = (code, msg) => ({
    response: oauthError(code, msg, 401, { "WWW-Authenticate": `Bearer error="${code}", error_description="${msg}", resource_metadata="${prmUrl(cfg)}"` }),
  });
  const header = request.headers.get("Authorization");
  if (!header) return challenge("invalid_token", "Missing Authorization header");
  const [type, tok] = header.split(" ");
  if (!tok || type.toLowerCase() !== "bearer") return challenge("invalid_token", "Invalid Authorization header format, expected 'Bearer TOKEN'");
  const t = state.accessTokens[await hashToken(tok)];
  if (!t || t.expiresAt < Date.now()) return challenge("invalid_token", "Invalid or expired access token");
  return { authInfo: { token: tok, clientId: t.clientId, scopes: ["whoop.read"], expiresAt: Math.floor(t.expiresAt / 1000), resource: t.resource ? new URL(t.resource) : undefined } };
}

// ---- Owner password with a global lockout against guessing ----
export function checkPassword(cfg, state, password) {
  const now = Date.now();
  state.failures = state.failures.filter((t) => now - t < 15 * 60_000);
  if (state.failures.length >= 5) return { ok: false, locked: true };
  const ok = timingSafeEqual(cfg.ownerPassword, String(password ?? ""));
  if (!ok) state.failures.push(now);
  return { ok, locked: false };
}
