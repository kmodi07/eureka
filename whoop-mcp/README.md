# Personal WHOOP connector for Claude (read-only MCP server)

A single-user remote MCP server that lets Claude read **your** WHOOP recovery, sleep and strain.

- **Read-only.** WHOOP scopes are `read:recovery read:sleep read:cycles offline`. Setting `WHOOP_INCLUDE_WORKOUTS=true` adds `read:workout`.
- **Tools:** `whoop_latest`, `whoop_recovery`, `whoop_sleep`, `whoop_cycles` (plus `whoop_workouts` if enabled). They return dated records from the WHOOP API v2.
- **Claude access is protected by OAuth 2.1** with dynamic client registration and PKCE, using the MCP SDK's auth server. When you click Connect in Claude, this server asks for **your owner password**. Then, if WHOOP isn't linked yet, it sends you to **WHOOP's official sign-in page**.
- **Secrets stay on the server.** WHOOP tokens and Claude tokens are stored in an AES-256-GCM-encrypted file. Claude's tokens are stored only as hashes. Refresh tokens rotate. OAuth `state` is checked on both legs, codes are single-use, and only Claude's callback URL `https://claude.ai/api/mcp/auth_callback` may register.
- **Disconnect:** `/admin` → "Disconnect WHOOP and delete tokens" revokes access at WHOOP (`DELETE /v2/user/access`), deletes the tokens and signs Claude out.

## Requirements

Claude connects from Anthropic's cloud, so the server must be reachable on the **public internet over HTTPS on port 443**. It also needs a **persistent disk** for the encrypted token file.

## Setup

1. **Deploy** this folder (Dockerfile included). Set these secrets in your host's secret settings: `PUBLIC_URL`, `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`, `OWNER_PASSWORD`, `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`). Point `DATA_FILE` at the persistent disk.
2. **Register the WHOOP app** at https://developer-dashboard.whoop.com:
   - Create App → scopes `read:recovery`, `read:sleep`, `read:cycles` (`offline` is requested at sign-in).
   - Redirect URL: `PUBLIC_URL/whoop/callback`, e.g. `https://your-host.example.com/whoop/callback`.
3. **Add to Claude:** go to https://claude.ai/customize/connectors → **+ Add** → **Add custom connector**. Name it "WHOOP (personal)", set the URL to `PUBLIC_URL/mcp`, leave the OAuth client on the default, then click **Add** → **Connect**. Enter your owner password, sign in to WHOOP, and approve.
4. In a chat, open **+** → **Connectors** and make sure it's on. Then ask: "Use whoop_latest to show my latest recovery and sleep."

## Local development

```bash
npm install
npm test     # end-to-end test against a fake WHOOP API
```
