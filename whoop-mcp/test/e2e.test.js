// End-to-end: fake WHOOP + the real server, driving Claude's OAuth + MCP flow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

const CB = "http://127.0.0.1:9/claude-callback"; // stand-in for https://claude.ai/api/mcp/auth_callback
const PASSWORD = "correct horse battery";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "whoop-mcp-"));
const log = { tokenCalls: [], revoked: 0, apiAuth: [] };
let whoopSrv, appSrv, base, whoopBase, createApp;

before(async () => {
  // ---- fake WHOOP ----
  const w = express();
  w.use(express.urlencoded({ extended: false }));
  let n = 0;
  w.get("/oauth/oauth2/auth", (req, res) => {
    assert.equal(req.query.scope, "read:recovery read:sleep read:cycles offline");
    assert.ok(req.query.state.length >= 8);
    res.redirect(`${req.query.redirect_uri}?code=whoop-code&state=${req.query.state}`);
  });
  w.post("/oauth/oauth2/token", (req, res) => {
    log.tokenCalls.push(req.body);
    assert.equal(req.body.client_secret, "whoop-secret");
    n++;
    // first token expires immediately so the next API call must refresh
    res.json({ access_token: `wat-${n}`, refresh_token: `wrt-${n}`, expires_in: n === 1 ? 1 : 3600, scope: "read:recovery read:sleep read:cycles offline" });
  });
  const auth = (req, res, next) => { log.apiAuth.push(req.headers.authorization); next(); };
  w.get("/developer/v2/recovery", auth, (_q, res) => res.json({ records: [{ cycle_id: 7, sleep_id: "s1", created_at: "2026-11-23T06:40:00Z", score_state: "SCORED", score: { recovery_score: 71, hrv_rmssd_milli: 64.2, resting_heart_rate: 52 } }], next_token: null }));
  w.get("/developer/v2/activity/sleep", auth, (_q, res) => res.json({ records: [
    { id: "nap1", start: "2026-11-22T14:00:00Z", end: "2026-11-22T14:30:00Z", nap: true, score_state: "SCORED", score: { stage_summary: { total_in_bed_time_milli: 1_800_000, total_awake_time_milli: 0 } } },
    { id: "s1", start: "2026-11-22T22:50:00Z", end: "2026-11-23T06:35:00Z", nap: false, score_state: "SCORED", score: { stage_summary: { total_in_bed_time_milli: 27_900_000, total_awake_time_milli: 1_800_000, total_rem_sleep_time_milli: 6_000_000, total_slow_wave_sleep_time_milli: 5_400_000, total_light_sleep_time_milli: 14_700_000 }, sleep_performance_percentage: 88 } },
  ] }));
  w.get("/developer/v2/cycle", auth, (_q, res) => res.json({ records: [{ id: 7, start: "2026-11-22T22:50:00Z", end: null, score_state: "SCORED", score: { strain: 9.4, kilojoule: 8100 } }] }));
  w.delete("/developer/v2/user/access", (_q, res) => { log.revoked++; res.status(204).end(); });
  whoopSrv = w.listen(0);
  whoopBase = `http://127.0.0.1:${whoopSrv.address().port}`;

  // ---- the real server ----
  const port = 18000 + Math.floor(Math.random() * 1000);
  Object.assign(process.env, {
    PUBLIC_URL: `http://localhost:${port}`, PORT: String(port),
    WHOOP_CLIENT_ID: "whoop-id", WHOOP_CLIENT_SECRET: "whoop-secret",
    WHOOP_OAUTH_BASE: `${whoopBase}/oauth/oauth2`, WHOOP_API_BASE: `${whoopBase}/developer`,
    OWNER_PASSWORD: PASSWORD, TOKEN_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
    DATA_FILE: path.join(tmp, "state.enc"), ALLOWED_REDIRECT_URIS: CB,
  });
  ({ createApp } = await import("../src/server.js"));
  appSrv = createApp().app.listen(port);
  base = `http://localhost:${port}`;
});
after(() => { appSrv?.close(); whoopSrv?.close(); });

const go = (url, opts = {}) => fetch(url.startsWith("http") ? url : base + url, { redirect: "manual", ...opts });
const formPost = (url, body) => go(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
async function mcp(token, method, params = {}, id = 1) {
  const res = await go("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const raw = await res.text();
  const data = raw.trim().startsWith("{") ? raw : raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
  return { status: res.status, body: data ? JSON.parse(data) : null };
}

let client, tokens;

test("unauthenticated MCP request gets 401 with discovery header", async () => {
  const res = await go("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate"), /resource_metadata="[^"]*\/\.well-known\/oauth-protected-resource\/mcp"/);
  const prm = await (await go("/.well-known/oauth-protected-resource/mcp")).json();
  assert.equal(prm.resource, `${base}/mcp`);
  const asm = await (await go("/.well-known/oauth-authorization-server")).json();
  assert.ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes("S256"));
});

test("client registration only accepts allowed redirect URIs", async () => {
  const bad = await go("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  assert.equal(bad.status, 400);
  const ok = await go("/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [CB], token_endpoint_auth_method: "none", client_name: "Claude" }) });
  assert.equal(ok.status, 201);
  client = await ok.json();
});

test("owner password + WHOOP sign-in -> code -> tokens (PKCE)", async () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authz = await go(`/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CB, code_challenge: challenge, code_challenge_method: "S256", state: "claude-state-123", resource: `${base}/mcp` })}`);
  assert.equal(authz.status, 302);
  const requestId = new URL(authz.headers.get("location"), base).searchParams.get("request");
  assert.ok(requestId);

  const wrong = await formPost("/consent", { request: requestId, password: "nope", action: "allow" });
  assert.equal(wrong.status, 401);

  const allow = await formPost("/consent", { request: requestId, password: PASSWORD, action: "allow" });
  assert.equal(allow.status, 302);
  const toWhoop = allow.headers.get("location");
  assert.ok(toWhoop.startsWith(whoopBase + "/oauth/oauth2/auth"));

  const back = await go(toWhoop); // fake WHOOP immediately "consents"
  const cbRes = await go(back.headers.get("location"));
  assert.equal(cbRes.status, 302);
  const final = new URL(cbRes.headers.get("location"));
  assert.equal(final.origin + final.pathname, CB);
  assert.equal(final.searchParams.get("state"), "claude-state-123");
  const code = final.searchParams.get("code");

  const badPkce = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: "x".repeat(43), client_id: client.client_id, redirect_uri: CB });
  assert.equal(badPkce.status, 400);
  const tok = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB });
  // code was consumed by the failed PKCE attempt? The SDK checks PKCE before exchange, so it's still valid here.
  assert.equal(tok.status, 200, await tok.clone().text());
  tokens = await tok.json();
  assert.ok(tokens.access_token && tokens.refresh_token);

  const replay = await formPost("/token", { grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CB });
  assert.equal(replay.status, 400, "authorization code must be single-use");
});

test("MCP tools list is read-only and returns dated WHOOP records", async () => {
  const init = await mcp(tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.status, 200);
  const list = await mcp(tokens.access_token, "tools/list", {}, 2);
  const names = list.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["whoop_cycles", "whoop_latest", "whoop_recovery", "whoop_sleep"]);
  assert.ok(list.body.result.tools.every((t) => t.annotations.readOnlyHint === true));

  const call = await mcp(tokens.access_token, "tools/call", { name: "whoop_latest", arguments: {} }, 3);
  const out = JSON.parse(call.body.result.content[0].text);
  assert.equal(out.recovery.recovery_score_pct, 71);
  assert.equal(out.recovery.hrv_rmssd_ms, 64.2);
  assert.equal(out.recovery.resting_heart_rate_bpm, 52);
  assert.equal(out.sleep.id, "s1", "picks main sleep, not the nap");
  assert.equal(out.sleep.hours_asleep, 7.25);
  assert.equal(out.cycle.strain, 9.4);
  assert.equal(out.cycle.end, "in progress");

  // first WHOOP token was issued with expires_in=1, so the server must have refreshed with scope=offline
  const refresh = log.tokenCalls.find((c) => c.grant_type === "refresh_token");
  assert.equal(refresh?.refresh_token, "wrt-1");
  assert.equal(refresh?.scope, "offline");
  assert.ok(log.apiAuth.every((h) => h === "Bearer wat-2"));
});

test("refresh tokens rotate; old one is rejected", async () => {
  const r1 = await formPost("/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r1.status, 200);
  const t2 = await r1.json();
  const r2 = await formPost("/token", { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id });
  assert.equal(r2.status, 400);
  assert.equal((await r2.json()).error, "invalid_grant");
  tokens = t2;
});

test("state file is encrypted (no tokens in plaintext)", () => {
  const raw = fs.readFileSync(process.env.DATA_FILE).toString("latin1");
  for (const s of ["wat-2", "wrt-2", tokens.access_token, tokens.refresh_token, "whoop-secret"]) assert.ok(!raw.includes(s), `found ${s} in state file`);
});

test("admin disconnect revokes at WHOOP and signs Claude out", async () => {
  const bad = await formPost("/admin", { password: "nope", action: "disconnect" });
  assert.equal(bad.status, 401);
  const res = await formPost("/admin", { password: PASSWORD, action: "disconnect" });
  assert.equal(res.status, 200);
  assert.equal(log.revoked, 1);
  const after = await mcp(tokens.access_token, "tools/list");
  assert.equal(after.status, 401);
  const health = await (await go("/healthz")).json();
  assert.equal(health.whoopLinked, false);
});

test("password lockout after repeated failures", async () => {
  for (let i = 0; i < 5; i++) await formPost("/admin", { password: "wrong", action: "status" });
  const res = await formPost("/admin", { password: PASSWORD, action: "status" });
  assert.equal(res.status, 429);
});
