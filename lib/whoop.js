// WHOOP Developer API v2 client: OAuth 2.0 + auto token refresh + pagination.
// Docs: https://developer.whoop.com/api
import crypto from "node:crypto";
import { loadTokens, saveTokens, clearTokens } from "./store.js";

const AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth";
const TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
const API = "https://api.prod.whoop.com/developer";

export const SCOPES = [
  "offline", // required to receive a refresh_token
  "read:profile",
  "read:body_measurement",
  "read:cycles",
  "read:recovery",
  "read:sleep",
  "read:workout",
];

const cfg = () => ({
  clientId: process.env.WHOOP_CLIENT_ID,
  clientSecret: process.env.WHOOP_CLIENT_SECRET,
  redirectUri:
    process.env.WHOOP_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/auth/whoop/callback`,
});

export const isConfigured = () => Boolean(cfg().clientId && cfg().clientSecret);
export const isConnected = () => Boolean(loadTokens()?.access_token);
export const disconnect = () => clearTokens();

export function buildAuthUrl() {
  // WHOOP requires a state of at least 8 characters.
  const state = crypto.randomBytes(16).toString("hex");
  const { clientId, redirectUri } = cfg();
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES.join(" "),
    state,
  }).toString();
  return { url: url.toString(), state };
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = cfg();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`WHOOP token request failed (${res.status}): ${await res.text()}`);
  }
  const t = await res.json();
  const tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? loadTokens()?.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope,
  };
  saveTokens(tokens);
  return tokens;
}

export const exchangeCode = (code) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: cfg().redirectUri });

let refreshing = null;
async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error("WHOOP not connected");
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token;
  if (!tokens.refresh_token) throw new Error("WHOOP session expired - reconnect");
  // Refresh tokens are single-use: make sure concurrent calls share one refresh.
  refreshing ??= tokenRequest({
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    scope: "offline",
  }).finally(() => (refreshing = null));
  return (await refreshing).access_token;
}

async function get(pathname, query = {}) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await getAccessToken()}` },
  });
  if (res.status === 401) {
    throw new Error("WHOOP rejected the token - try reconnecting");
  }
  if (!res.ok) throw new Error(`WHOOP ${pathname} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

// Collection endpoints return { records, next_token }; max 25 per page.
async function collection(pathname, { days = 14, max = 100 } = {}) {
  const start = new Date(Date.now() - days * 86_400_000).toISOString();
  const out = [];
  let nextToken;
  do {
    const page = await get(pathname, { limit: 25, start, nextToken });
    out.push(...(page.records ?? []));
    nextToken = page.next_token;
  } while (nextToken && out.length < max);
  return out;
}

export async function fetchAll(days = 14) {
  const [profile, body, cycles, recovery, sleep, workouts] = await Promise.all([
    get("/v2/user/profile/basic"),
    get("/v2/user/measurement/body").catch(() => null),
    collection("/v2/cycle", { days }),
    collection("/v2/recovery", { days }),
    collection("/v2/activity/sleep", { days }),
    collection("/v2/activity/workout", { days }),
  ]);
  return { source: "whoop", profile, body, cycles, recovery, sleep, workouts };
}
