// All configuration comes from environment variables (set them as secrets on your host).
import crypto from "node:crypto";

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see README)`);
  return v;
}

export function loadConfig(env = process.env) {
  const publicUrl = new URL(required("PUBLIC_URL")); // e.g. https://whoop-mcp.example.com
  const includeWorkouts = env.WHOOP_INCLUDE_WORKOUTS === "true";
  const keyB64 = required("TOKEN_ENCRYPTION_KEY");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32)");
  const ownerPassword = required("OWNER_PASSWORD");
  if (ownerPassword.length < 12) throw new Error("OWNER_PASSWORD must be at least 12 characters");

  return {
    port: Number(env.PORT) || 8787,
    publicUrl,
    mcpUrl: new URL("/mcp", publicUrl),
    whoopRedirectUri: new URL("/whoop/callback", publicUrl).toString(),
    whoop: {
      clientId: required("WHOOP_CLIENT_ID"),
      clientSecret: required("WHOOP_CLIENT_SECRET"),
      oauthBase: env.WHOOP_OAUTH_BASE || "https://api.prod.whoop.com/oauth/oauth2",
      apiBase: env.WHOOP_API_BASE || "https://api.prod.whoop.com/developer",
      // Least privilege: only what the tools need. `offline` = refresh token.
      scopes: ["read:recovery", "read:sleep", "read:cycles", "offline", ...(includeWorkouts ? ["read:workout"] : [])],
    },
    includeWorkouts,
    ownerPasswordHash: crypto.createHash("sha256").update(ownerPassword).digest(),
    encryptionKey: key,
    dataFile: env.DATA_FILE || "./data/state.enc",
    // Where Claude may redirect after authorization. Override only for local testing.
    allowedRedirectUris: (env.ALLOWED_REDIRECT_URIS ||
      "https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback")
      .split(",").map((s) => s.trim()).filter(Boolean),
    accessTokenTtlSec: 3600,
    refreshTokenTtlSec: 30 * 86400,
  };
}
