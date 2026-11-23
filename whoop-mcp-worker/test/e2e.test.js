// End-to-end inside the Workers runtime: fake WHOOP (fetchMock) + the real Worker, driving
// Claude's OAuth + MCP flow. Tests share one D1 database and run in order.
import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";

const base = "https://whoop-mcp.test";
const CB = "http://127.0.0.1:9/claude-callback"; // stand-in for https://claude.ai/api/mcp/auth_callback
const PASSWORD = "correct horse battery";
const WHOOP = "https://whoop.test";
const log = { tokenCalls: [], revoked: 0, apiAuth: [] };


// Fake WHOOP: the Worker's outbound fetch for https://whoop.test is answered here (same isolate).
const realFetch = globalThis.fetch;
let n = 0;
async function fakeWhoop(req) {
  const u = new URL(req.url);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (req.method === "POST" && u.pathname === "/oauth/oauth2/token") {
    const body = Object.fromEntries(new URLSearchParams(await req.text()));
    log.tokenCalls.push(body);
    expect(body.client_secret).toBe("whoop-secret");
    n++;
    // first token expires immediately so the next API call must refresh
    return json({ access_token: `wat-${n}`, refresh_token: `wrt-${n}`, expires_in: n === 1 ? 1 : 3600, scope: "read:recovery read:sleep read:cycles offline" });
  }
  if (req.method === "DELETE" && u.pathname === "/developer/v2/user/access") { log.revoked++; return new Response(null, { status: 204 }); }
  if (req.method === "GET") {
    log.apiAuth.push(req.headers.get("authorization"));
    if (u.pathname === "/developer/v2/recovery") return json({ records: [{ cycle_id: 7, sleep_id: "s1", created_at: "2026-11-23T06:40:00Z", score_state: "SCORED", score: { recovery_score: 71, hrv_rmssd_milli: 64.2, resting_heart_rate: 52 } }], next_token: null });
    if (u.pathname === "/developer/v2/activity/sleep") return json({ records: [
      { id: "nap1", start: "2026-11-22T14:00:00Z", end: "2026-11-22T14:30:00Z", nap: true, score_state: "SCORED", score: { stage_summary: { total_in_bed_time_milli: 1_800_000, total_awake_time_milli: 0 } } },
      { id: "s1", start: "2026-11-22T22:50:00Z", end: "2026-11-23T06:35:00Z", nap: false, score_state: "SCORED", score: { stage_summary: { total_in_bed_time_milli: 27_900_000, total_awake_time_milli: 1_800_000, total_rem_sleep_time_milli: 6_000_000, total_slow_wave_sleep_time_milli: 5_400_000, total_light_sleep_time_milli: 14_700_000 }, sleep_performance_percentage: 88 } },
    ], next_token: null });
    if (u.pathname === "/developer/v2/cycle") return json({ records: [{ id: 7, start: "2026-11-22T22:50:00Z", end: null, score_state: "SCORED", score: { strain: 9.4, kilojoule: 8100 } }], next_token: null });
  }
  return new Response("not found", { status: 404 });
}
beforeAll(() => {
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    return new URL(req.url).origin === WHOOP ? fakeWhoop(req) : realFetch(input, init);
  };
});
const go = (url, opts = {}) => SELF.fetch(url.startsWith("http") ? url : base + url, { redirect: "manual", ...opts });
const formPost = (url, body) => go(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });
async function mcp(token, method, params = {}, id = 1) {
  const res = await go("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const raw = await res.text();
  const data = raw.trim().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
  return { status: res.status, body: data ? JSON.parse(data) : null };
}
const sha256b64url = async (s) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let client, tokens;

test("unauthenticated MCP request gets 401 with discovery header", async () => {
  const res = await go("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  expect(res.status).toBe(401);
  expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await go("/.well-known/oauth-protected-resource/mcp")).json();
  expect(prm.resource).toBe(`${base}/mcp`);
  const asm = await (await go("/.well-known/oauth-authorization-server")).json();
  expect(asm.registration_endpoint).toBe(`${base}/register`);
  expect(asm.code_challenge_methods_supported).toContain("S256");
  expect((await (await go("/healthz")).json()).whoopLinked).toBe(false);
});

test("client registration only accepts allowed redirect URIs", async () => {
  const bad = await go("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  expect(bad.status).toBe(400);
  const ok = await go("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: "none", client_name: "Claude" }) });
  expect(ok.status).toBe(201);
  client = await ok.json();
  expect(client.client_id).toBeTruthy();
  expect(client.client_secret).toBeUndefined();
});

test("owner password + WHOOP sign-in -> code -> tokens (PKCE)", async () => {
  const verifier = "v".repeat(20) + crypto.randomUUID() + crypto.randomUUID();
  const challenge = await sha256b64url(verifier);
  const authz = await go(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state-123", resource: `${base}/mcp` })}`);
  expect(authz.status).toBe(302);
  const requestId = new URL(authz.headers.get("location"), base).searchParams.get("request");
  expect(requestId).toBeTruthy();
  expect((await go(`/consent?request=${requestId}`)).status).toBe(200);

  const wrong = await formPost("/consent", { request: requestId, password: "nope", action: "allow" });
  expect(wrong.status).toBe(401);

  const allow = await formPost("/consent", { request: requestId, password: PASSWORD, action: "allow" });
  expect(allow.status).toBe(302);
  const toWhoop = new URL(allow.headers.get("location"));
  expect(toWhoop.origin + toWhoop.pathname).toBe(`${WHOOP}/oauth/oauth2/auth`);
  expect(toWhoop.searchParams.get("scope")).toBe("read:recovery read:sleep read:cycles offline");
  expect(toWhoop.searchParams.get("redirect_uri")).toBe(`${base}/whoop/callback`);
  const whoopState = toWhoop.searchParams.get("state");
  expect(whoopState.length).toBeGreaterThanOrEqual(8);

  // WHOOP "consents" and sends the browser back with a code
  const cbRes = await go(`/whoop/callback?code=whoop-code&state=${whoopState}`);
  expect(cbRes.status).toBe(302);
  const final = new URL(cbRes.headers.get("location"));
  expect(final.origin + final.pathname).toBe(CB);
  expect(final.searchParams.get("state")).toBe("claude-state-123");
  const code = final.searchParams.get("code");
  expect(log.tokenCalls[0]).toMatchObject({ grant_type: "authorization_code", code: "whoop-code", redirect_uri: `${base}/whoop/callback` });

  const badPkce = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: client.client_id, redirect_uri: CB });
  expect(badPkce.status).toBe(400);
  const tok = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB });
  expect(tok.status, await tok.clone().text()).toBe(200);
  tokens = await tok.json();
  expect(tokens.access_token && tokens.refresh_token).toBeTruthy();

  const replay = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB });
  expect(replay.status, "authorization code must be single-use").toBe(400);
  expect((await (await go("/healthz")).json()).whoopLinked).toBe(true);
});

test("MCP tools list is read-only and returns dated WHOOP records", async () => {
  const init = await mcp(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect(init.status).toBe(200);
  const list = await mcp(tokens.access_token, "tools/list", {}, 2);
  const names = list.body.result.tools.map((t) => t.name).sort();
  expect(names).toEqual(["whoop_cycles", "whoop_latest", "whoop_recovery", "whoop_sleep"]);
  expect(list.body.result.tools.every((t) => t.annotations.readOnlyHint === true)).toBe(true);

  const call = await mcp(tokens.access_token, "tools/call", { name: "whoop_latest", arguments: {} }, 3);
  const out = JSON.parse(call.body.result.content[0].text);
  expect(out.recovery.recovery_score_pct).toBe(71);
  expect(out.recovery.hrv_rmssd_ms).toBe(64.2);
  expect(out.recovery.resting_heart_rate_bpm).toBe(52);
  expect(out.sleep.id, "picks main sleep, not the nap").toBe("s1");
  expect(out.sleep.hours_asleep).toBe(7.25);
  expect(out.cycle.strain).toBe(9.4);
  expect(out.cycle.end).toBe("in progress");

  // first WHOOP token was issued with expires_in=1, so the server must have refreshed with scope=offline
  const refresh = log.tokenCalls.find((c) => c.grant_type === "refresh_token");
  expect(refresh?.refresh_token).toBe("wrt-1");
  expect(refresh?.scope).toBe("offline");
  expect(log.apiAuth.length).toBeGreaterThan(0);
  expect(log.apiAuth.every((h) => h === "Bearer wat-2")).toBe(true);
});

test("refresh tokens rotate; old one is rejected", async () => {
  const r1 = await formPost("/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  expect(r1.status).toBe(200);
  const t2 = await r1.json();
  const r2 = await formPost("/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  expect(r2.status).toBe(400);
  expect((await r2.json()).error).toBe("invalid_grant");
  tokens = t2;
});

test("stored state is encrypted (no tokens in plaintext)", async () => {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = 'state'").first();
  const raw = atob(row.value);
  for (const s of ["wat-2", "wrt-2", tokens.access_token, tokens.refresh_token, "whoop-secret"]) expect(raw.includes(s), `found ${s} in state`).toBe(false);
});

test("admin disconnect revokes at WHOOP and signs Claude out", async () => {
  const bad = await formPost("/admin", { password: "nope", action: "disconnect" });
  expect(bad.status).toBe(401);
  const res = await formPost("/admin", { password: PASSWORD, action: "disconnect" });
  expect(res.status).toBe(200);
  expect(log.revoked).toBe(1);
  const after = await mcp(tokens.access_token, "tools/list");
  expect(after.status).toBe(401);
  const health = await (await go("/healthz")).json();
  expect(health.whoopLinked).toBe(false);
});

test("password lockout after repeated failures", async () => {
  for (let i = 0; i < 5; i++) await formPost("/admin", { password: "wrong", action: "status" });
  const res = await formPost("/admin", { password: PASSWORD, action: "status" });
  expect(res.status).toBe(429);
});
