// All configuration comes from Worker vars and secrets. PUBLIC_URL is optional: by default
// the Worker uses the origin it was reached on (your workers.dev address or custom domain).
import { b64 } from "./crypto.js";

function required(env, name) {
  const v = env[name];
  if (!v) throw new Error(`Missing required secret ${name} (see README)`);
  return v;
}

export function loadConfig(env, requestUrl) {
  const publicUrl = new URL(env.PUBLIC_URL || new URL(requestUrl).origin);
  const includeWorkouts = env.WHOOP_INCLUDE_WORKOUTS === "true";
  const key = b64.decode(required(env, "TOKEN_ENCRYPTION_KEY"));
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  const ownerPassword = required(env, "OWNER_PASSWORD");
  if (ownerPassword.length < 12) throw new Error("OWNER_PASSWORD must be at least 12 characters");

  return {
    publicUrl,
    mcpUrl: new URL("/mcp", publicUrl),
    whoopRedirectUri: new URL("/whoop/callback", publicUrl).toString(),
    whoop: {
      clientId: required(env, "WHOOP_CLIENT_ID"),
      clientSecret: required(env, "WHOOP_CLIENT_SECRET"),
      oauthBase: env.WHOOP_OAUTH_BASE || "https://api.prod.whoop.com/oauth/oauth2",
      apiBase: env.WHOOP_API_BASE || "https://api.prod.whoop.com/developer",
      // Least privilege: only what the tools need. `offline` = refresh token.
      scopes: ["read:recovery", "read:sleep", "read:cycles", "offline", ...(includeWorkouts ? ["read:workout"] : [])],
    },
    includeWorkouts,
    ownerPassword,
    encryptionKey: key,
    // Where Claude may redirect after authorization. Override only for local testing.
    allowedRedirectUris: (env.ALLOWED_REDIRECT_URIS ||
      "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
      .split(",").map((s) => s.trim()).filter(Boolean),
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 30 * 86400,
  };
}
