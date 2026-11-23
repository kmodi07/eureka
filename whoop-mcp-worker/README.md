# Personal WHOOP connector for Claude, on Cloudflare Workers

The same single-user, read-only WHOOP MCP server as `../whoop-mcp`, ported to Cloudflare Workers so it runs always-on for free with nothing to keep awake.

- **Read-only.** WHOOP scopes are `read:recovery read:sleep read:cycles offline` (`WHOOP_INCLUDE_WORKOUTS=true` adds `read:workout`).
- **Tools:** `whoop_latest`, `whoop_recovery`, `whoop_sleep`, `whoop_cycles` (plus `whoop_workouts` if enabled).
- **Claude access is protected by OAuth 2.1** with dynamic client registration and PKCE. Only Claude's callback URL may register. Connecting asks for **your owner password**, then sends you to **WHOOP's official sign-in page** if WHOOP isn't linked yet.
- **Secrets stay on the server.** WHOOP tokens, registered clients and *hashes* of Claude's tokens live in one AES-256-GCM-encrypted blob in a D1 database. Refresh tokens rotate, authorization codes are single-use, OAuth `state` is checked on both legs, and five wrong passwords lock the pages for 15 minutes.
- **Disconnect:** `/admin` → "Disconnect WHOOP and delete tokens" revokes access at WHOOP and signs Claude out. "Download encrypted backup" exports the blob (same format as the Node server's `state.enc`).

## Deploy (free plan, no card)

```bash
npm install
npx wrangler login                      # opens the browser once
npx wrangler d1 create whoop-mcp        # paste the database_id it prints into wrangler.jsonc
npx wrangler secret put WHOOP_CLIENT_ID
npx wrangler secret put WHOOP_CLIENT_SECRET
npx wrangler secret put OWNER_PASSWORD        # 12+ characters
npx wrangler secret put TOKEN_ENCRYPTION_KEY  # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler deploy                     # prints https://whoop-mcp.<subdomain>.workers.dev
```

`PUBLIC_URL` is optional: the Worker uses whatever origin it is reached on.

Then:

1. In the [WHOOP developer dashboard](https://developer-dashboard.whoop.com), set the app's Redirect URL to `https://whoop-mcp.<subdomain>.workers.dev/whoop/callback`.
2. At https://claude.ai/customize/connectors → **+ Add** → **Add custom connector**, name it, set the URL to `https://whoop-mcp.<subdomain>.workers.dev/mcp`, keep the default OAuth settings, click **Add** → **Connect**, enter your owner password, sign in to WHOOP, and approve.
3. Check `https://whoop-mcp.<subdomain>.workers.dev/healthz` → `{"ok":true,"whoopLinked":true}`.

### Moving from the Node server without re-linking WHOOP

The encrypted blob has the same layout as `state.enc`, so with the **same** `TOKEN_ENCRYPTION_KEY` you can import it:

```bash
node -e "console.log(\"INSERT INTO kv (key, value) VALUES ('state', '\" + require('fs').readFileSync('../whoop-mcp/data/state.enc').toString('base64') + \"') ON CONFLICT(key) DO UPDATE SET value = excluded.value;\")" > /tmp/import.sql
npx wrangler d1 execute whoop-mcp --remote --command "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
npx wrangler d1 execute whoop-mcp --remote --file /tmp/import.sql
```

## Development

```bash
npm test          # end-to-end against a fake WHOOP, inside the Workers runtime
npm run dev       # local server; copy .dev.vars.example to .dev.vars first
```
