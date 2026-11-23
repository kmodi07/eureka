// Personal WHOOP MCP server on Cloudflare Workers. Routes:
//   OAuth for Claude: /.well-known/*, /register, /authorize, /token, /revoke
//   Owner pages:      /consent, /whoop/callback, /admin
//   MCP endpoint:     /mcp (Streamable HTTP, stateless, JSON responses)
import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Whoop } from "./whoop.js";
import { buildMcpServer } from "./tools.js";
import * as oauth from "./oauth.js";
import { adminPage, consentPage, esc, page } from "./pages.js";

const app = new Hono();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
});

// Load config and the encrypted state once per request.
app.use("*", async (c, next) => {
  const cfg = loadConfig(c.env, c.req.url);
  const store = new Store(c.env.DB, cfg.encryptionKey);
  const state = await store.load();
  c.set("ctx", { cfg, store, state, whoop: new Whoop(cfg, store, state) });
  await next();
});

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version" };
const withCors = (res) => { for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); return res; };
app.options("/register", (c) => withCors(new Response(null, { status: 204 })));
app.options("/token", (c) => withCors(new Response(null, { status: 204 })));

// ---- OAuth for Claude ----
app.get("/.well-known/oauth-authorization-server", (c) => c.json(oauth.asMetadata(c.get("ctx").cfg)));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => c.json(oauth.prmMetadata(c.get("ctx").cfg)));
app.get("/.well-known/oauth-protected-resource", (c) => c.json(oauth.prmMetadata(c.get("ctx").cfg)));
app.post("/register", async (c) => withCors(await oauth.register(c.get("ctx"), c.req.raw)));
app.on(["GET", "POST"], "/authorize", (c) => oauth.authorize(c.get("ctx"), c.req.raw));
app.post("/token", async (c) => withCors(await oauth.token(c.get("ctx"), c.req.raw)));
app.post("/revoke", (c) => oauth.revoke(c.get("ctx"), c.req.raw));

// ---- Owner consent page (Claude sends you here when you click Connect) ----
app.get("/consent", (c) => {
  const { state, whoop } = c.get("ctx");
  const requestId = c.req.query("request") ?? "";
  if (!oauth.takePending(state, requestId)) return c.html(page("Request expired", `<p>This sign-in link expired. Go back to Claude and click Connect again.</p>`), 400);
  return c.html(consentPage(requestId, whoop.linked));
});

app.post("/consent", async (c) => {
  const ctx = c.get("ctx"); const { cfg, store, state, whoop } = ctx;
  const body = await c.req.parseBody();
  const requestId = String(body.request ?? "");
  if (body.action === "deny") {
    const to = await oauth.denyRedirect(ctx, requestId);
    return to ? c.redirect(to, 302) : c.html(page("Request expired", "<p>Nothing to cancel.</p>"), 400);
  }
  if (!oauth.takePending(state, requestId)) return c.html(page("Request expired", "<p>Go back to Claude and click Connect again.</p>"), 400);
  const { ok, locked } = oauth.checkPassword(cfg, state, body.password);
  if (!ok) { await store.save(state); return c.html(consentPage(requestId, whoop.linked, locked ? "Too many attempts. Wait 15 minutes." : "Wrong password."), locked ? 429 : 401); }
  if (!whoop.linked) {
    const { url, state: st } = whoop.authUrl();
    state.whoopStates[st] = { requestId, expiresAt: Date.now() + 10 * 60_000 };
    await store.save(state);
    return c.redirect(url, 302);
  }
  return c.redirect(await oauth.issueCodeRedirect(ctx, requestId), 302);
});

// ---- WHOOP OAuth callback (register this exact URL in the WHOOP developer dashboard) ----
app.get("/whoop/callback", async (c) => {
  const ctx = c.get("ctx"); const { store, state, whoop } = ctx;
  const key = c.req.query("state") ?? "";
  const st = state.whoopStates[key];
  delete state.whoopStates[key];
  if (!st || st.expiresAt < Date.now()) { await store.save(state); return c.html(page("Link failed", "<p>Invalid or expired state. Start again.</p>"), 400); }
  if (c.req.query("error")) {
    if (st.requestId) { const to = await oauth.denyRedirect(ctx, st.requestId); if (to) return c.redirect(to, 302); }
    await store.save(state);
    return c.html(page("WHOOP access not granted", `<p>${esc(c.req.query("error_description") || c.req.query("error"))}</p>`), 400);
  }
  try {
    await whoop.exchangeCode(c.req.query("code") ?? "");
  } catch (e) {
    console.error("WHOOP code exchange failed:", e.message);
    return c.html(page("Link failed", `<p>${esc(e.message)}</p>`), 502);
  }
  if (st.requestId) {
    try { return c.redirect(await oauth.issueCodeRedirect(ctx, st.requestId), 302); }
    catch { return c.html(page("WHOOP linked", `<p>WHOOP is linked, but the Claude request expired. Go back to Claude and click Connect again.</p>`), 400); }
  }
  return c.html(page("WHOOP linked", `<p>WHOOP is linked. You can close this tab.</p><p><a href="/admin">Back to admin</a></p>`));
});

// ---- Admin: link / disconnect WHOOP, sign Claude out, backup ----
app.get("/admin", (c) => c.html(adminPage()));
app.post("/admin", async (c) => {
  const ctx = c.get("ctx"); const { cfg, store, state, whoop } = ctx;
  const body = await c.req.parseBody();
  const { ok, locked } = oauth.checkPassword(cfg, state, body.password);
  if (!ok) { await store.save(state); return c.html(adminPage(locked ? "Too many attempts. Wait 15 minutes." : "Wrong password."), locked ? 429 : 401); }
  switch (body.action) {
    case "status": {
      const w = state.whoop;
      return c.html(page("Status", `<ul>
        <li>WHOOP linked: <b>${w ? "yes" : "no"}</b>${w ? ` (since ${esc(w.linkedAt)}, scopes: ${esc(w.scope ?? "")})` : ""}</li>
        <li>Active Claude sessions: <b>${Object.keys(state.refreshTokens).length}</b></li>
        <li>Registered Claude clients: <b>${Object.keys(state.clients).length}</b></li></ul><p><a href="/admin">Back</a></p>`));
    }
    case "link": {
      const { url, state: st } = whoop.authUrl();
      state.whoopStates[st] = { expiresAt: Date.now() + 10 * 60_000 };
      await store.save(state);
      return c.redirect(url, 302);
    }
    case "disconnect":
      await whoop.disconnect();
      await oauth.revokeAll(ctx);
      return c.html(page("Disconnected", `<p>WHOOP access was revoked and deleted from this server, and Claude was signed out. Claude can't read your WHOOP data until you reconnect.</p>`));
    case "signout":
      await oauth.revokeAll(ctx);
      return c.html(page("Claude signed out", `<p>Every Claude token was revoked. WHOOP stays linked.</p>`));
    case "export": {
      const raw = await store.exportRaw();
      if (!raw) return c.html(page("Nothing to export", "<p>No state stored yet.</p>"), 404);
      return new Response(Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="state.enc"' } });
    }
    default:
      return c.html(adminPage("Unknown action."), 400);
  }
});

app.get("/healthz", (c) => c.json({ ok: true, whoopLinked: c.get("ctx").whoop.linked }));

// ---- MCP endpoint (Streamable HTTP, stateless) ----
app.post("/mcp", async (c) => {
  const ctx = c.get("ctx");
  const auth = await oauth.verifyBearer(ctx, c.req.raw);
  if (auth.response) return auth.response;
  const server = buildMcpServer(ctx.whoop, ctx.cfg);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw, { authInfo: auth.authInfo });
    c.executionCtx.waitUntil(res.clone().arrayBuffer().then(() => transport.close()).catch(() => {}));
    return res;
  } catch (e) {
    console.error("MCP error:", e.message);
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
  }
});
app.on(["GET", "DELETE"], "/mcp", async (c) => {
  const auth = await oauth.verifyBearer(c.get("ctx"), c.req.raw);
  if (auth.response) return auth.response;
  return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405, { Allow: "POST" });
});

app.get("/", (c) => c.html(page("Personal WHOOP MCP", `<p>Connector URL for Claude: <code>${esc(c.get("ctx").cfg.mcpUrl.href)}</code></p><p><a href="/admin">Admin</a></p>`)));

app.onError((e, c) => {
  console.error("Unhandled:", e.message);
  return c.text(e.message.startsWith("Missing required secret") ? e.message : "Internal error", 500);
});

export default app;
