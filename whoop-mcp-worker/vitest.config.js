import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      isolatedStorage: false,
      miniflare: {
        bindings: {
          WHOOP_CLIENT_ID: "whoop-id",
          WHOOP_CLIENT_SECRET: "whoop-secret",
          WHOOP_OAUTH_BASE: "https://whoop.test/oauth/oauth2",
          WHOOP_API_BASE: "https://whoop.test/developer",
          OWNER_PASSWORD: "correct horse battery",
          TOKEN_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
          ALLOWED_REDIRECT_URIS: "http://127.0.0.1:9/claude-callback",
        },
      },
    }),
  ],
});
