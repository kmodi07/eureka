import express from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { Whoop } from "./whoop.js";
import { OwnerOnlyProvider, OwnerGate } from "./provider.js";
import { buildMcpServer } from "./tools.js";

export function createApp(cfg = loadConfig()) {
  const store = new Store(cfg.dataFile, cfg.encryptionKey);
  const whoop = new Whoop(cfg, store);
  const provider = new OwnerOnlyProvider(cfg, store);
  const gate = new OwnerGate(cfg.ownerPasswordHash);
  const whoopStates = new Map(); // WHOOP OAuth state -> { requestId?, expiresAt }

  const app = express();
  app.set("trust proxy", 1); // behind the host's HTTPS proxy
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set({ "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });

  // OAuth for Claude: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: cfg.publicUrl,
    resourceServerUrl: cfg.mcpUrl,
    scopesSupported: ["whoop.read"],
    resourceName: "Personal WHOOP (read-only)",
  }));

  const form = express.urlencoded({ extended: false, limit: "10kb" });

  // ---- Owner consent page (Claude sends you here when you click Connect) ----
  app.get("/consent", (req, res) => {
    const p = provider.takePending(String(req.query.request ?? ""));
    if (!p) return res.status(400).send(page("Request expired", `<p>This sign-in link expired. Go back to Claude and click Connect again.</p>`));
    res.send(consentPage(String(req.query.request), whoop.linked));
  });

  app.post("/consent", form, (req, res) => {
    const requestId = String(req.body.request ?? "");
    if (req.body.action === "deny") {
      const to = provider.denyRedirect(requestId);
      return to ? res.redirect(302, to) : res.status(400).send(page("Request expired", "<p>Nothing to cancel.</p>"));
    }
    if (!provider.takePending(requestId)) return res.status(400).send(page("Request expired", "<p>Go back to Claude and click Connect again.</p>"));
    const { ok, locked } = gate.check(req.body.password);
    if (!ok) return res.status(locked ? 429 : 401).send(consentPage(requestId, whoop.linked, locked ? "Too many attempts. Wait 15 minutes." : "Wrong password."));
    if (!whoop.linked) {
      const { url, state } = whoop.authUrl();
      whoopStates.set(state, { requestId, expiresAt: Date.now() + 10 * 60_000 });
      return res.redirect(302, url);
    }
    res.redirect(302, provider.issueCodeRedirect(requestId));
  });

  // ---- WHOOP OAuth callback (register this exact URL in the WHOOP developer dashboard) ----
  app.get("/whoop/callback", async (req, res) => {
    const st = whoopStates.get(String(req.query.state ?? ""));
    whoopStates.delete(String(req.query.state ?? ""));
    if (!st || st.expiresAt < Date.now()) return res.status(400).send(page("Link failed", "<p>Invalid or expired state. Start again.</p>"));
    if (req.query.error) {
      if (st.requestId) { const to = provider.denyRedirect(st.requestId); if (to) return res.redirect(302, to); }
      return res.status(400).send(page("WHOOP access not granted", `<p>${esc(String(req.query.error_description || req.query.error))}</p>`));
    }
    try {
      await whoop.exchangeCode(String(req.query.code ?? ""));
    } catch (e) {
      console.error("WHOOP code exchange failed:", e.message);
      return res.status(502).send(page("Link failed", `<p>${esc(e.message)}</p>`));
    }
    if (st.requestId) {
      try { return res.redirect(302, provider.issueCodeRedirect(st.requestId)); }
      catch (e) { return res.status(400).send(page("WHOOP linked", `<p>WHOOP is linked, but the Claude request expired. Go back to Claude and click Connect again.</p>`)); }
    }
    res.send(page("WHOOP linked", `<p>WHOOP is linked. You can close this tab.</p><p><a href="/admin">Back to admin</a></p>`));
  });

  // ---- Admin: link / disconnect WHOOP, sign Claude out ----
  app.get("/admin", (_req, res) => res.send(adminPage()));
  app.post("/admin", form, async (req, res) => {
    const { ok, locked } = gate.check(req.body.password);
    if (!ok) return res.status(locked ? 429 : 401).send(adminPage(locked ? "Too many attempts. Wait 15 minutes." : "Wrong password."));
    switch (req.body.action) {
      case "status": {
        const w = store.state.whoop;
        return res.send(page("Status", `<ul>
          <li>WHOOP linked: <b>${w ? "yes" : "no"}</b>${w ? ` (since ${esc(w.linkedAt)}, scopes: ${esc(w.scope ?? "")})` : ""}</li>
          <li>Active Claude sessions: <b>${Object.keys(store.state.refreshTokens).length}</b></li>
          <li>Registered Claude clients: <b>${Object.keys(store.state.clients).length}</b></li></ul><p><a href="/admin">Back</a></p>`));
      }
      case "link": {
        const { url, state } = whoop.authUrl();
        whoopStates.set(state, { expiresAt: Date.now() + 10 * 60_000 });
        return res.redirect(302, url);
      }
      case "disconnect":
        await whoop.disconnect();
        provider.revokeAll();
        return res.send(page("Disconnected", `<p>WHOOP access was revoked and deleted from this server, and Claude was signed out. Claude can't read your WHOOP data until you reconnect.</p>`));
      case "signout":
        provider.revokeAll();
        return res.send(page("Claude signed out", `<p>Every Claude token was revoked. WHOOP stays linked.</p>`));
      default:
        return res.status(400).send(adminPage("Unknown action."));
    }
  });

  app.get("/healthz", (_req, res) => res.json({ ok: true, whoopLinked: whoop.linked }));

  // ---- MCP endpoint (Streamable HTTP, stateless) ----
  const bearer = requireBearerAuth({ verifier: provider, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(cfg.mcpUrl) });
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = buildMcpServer(whoop, cfg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("MCP error:", e.message);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req, res) => res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  app.get("/mcp", bearer, notAllowed);
  app.delete("/mcp", bearer, notAllowed);

  app.get("/", (_req, res) => res.send(page("Personal WHOOP MCP", `<p>Connector URL for Claude: <code>${esc(cfg.mcpUrl.toString())}</code></p><p><a href="/admin">Admin</a></p>`)));

  return { app, store, whoop, provider };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#111;background:#fafafa}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}input{background:#222;color:#eee}}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #888;width:100%;box-sizing:border-box;margin:6px 0}
button{cursor:pointer;font-weight:600}.row{display:flex;gap:8px}.err{color:#d33}code{word-break:break-all}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
}

function consentPage(requestId, linked, error) {
  return page("Allow Claude to read your WHOOP data?", `
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <p>Claude is asking for <b>read-only</b> access to your recovery, sleep and strain through this personal server.</p>
    ${linked ? "" : "<p>WHOOP isn't linked yet. After your password, you'll be sent to WHOOP's official sign-in page.</p>"}
    <form method="post" action="/consent">
      <input type="hidden" name="request" value="${esc(requestId)}">
      <label>Owner password<input type="password" name="password" autocomplete="current-password" required autofocus></label>
      <div class="row"><button name="action" value="allow">Allow</button></div>
    </form>
    <form method="post" action="/consent"><input type="hidden" name="request" value="${esc(requestId)}"><button name="action" value="deny">Deny</button></form>`);
}

function adminPage(error) {
  return page("WHOOP MCP admin", `
    ${error ? `<p class="err">${esc(error)}</p>` : ""}
    <form method="post" action="/admin">
      <label>Owner password<input type="password" name="password" autocomplete="current-password" required></label>
      <button name="action" value="status">Show status</button>
      <button name="action" value="link">Link / re-link WHOOP</button>
      <button name="action" value="signout">Sign Claude out (keep WHOOP linked)</button>
      <button name="action" value="disconnect">Disconnect WHOOP and delete tokens</button>
    </form>`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = loadConfig();
  createApp(cfg).app.listen(cfg.port, () => console.log(`WHOOP MCP listening on :${cfg.port}. Connector URL: ${cfg.mcpUrl}`));
}
