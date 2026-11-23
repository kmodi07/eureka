import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as whoop from "./lib/whoop.js";
import { demoData } from "./lib/demo.js";
import { summarize } from "./lib/summarize.js";
import { streamCoach, coachConfigured } from "./lib/coach.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;
const pendingStates = new Set();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(here, "public")));

// ---------- WHOOP OAuth ----------
app.get("/auth/whoop", (_req, res) => {
  if (!whoop.isConfigured()) {
    return res.status(400).send("Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET in .env first (see README).");
  }
  const { url, state } = whoop.buildAuthUrl();
  pendingStates.add(state);
  setTimeout(() => pendingStates.delete(state), 10 * 60_000);
  res.redirect(url);
});

app.get("/auth/whoop/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  if (!state || !pendingStates.delete(state)) {
    return res.redirect("/?error=" + encodeURIComponent("Login expired or state mismatch - try again"));
  }
  try {
    await whoop.exchangeCode(code);
    cache = null;
    res.redirect("/?connected=1");
  } catch (e) {
    console.error(e);
    res.redirect("/?error=" + encodeURIComponent(e.message));
  }
});

app.post("/auth/whoop/disconnect", (_req, res) => {
  whoop.disconnect();
  cache = null;
  res.json({ ok: true });
});

// ---------- Data ----------
let cache = null; // { at, summary }
async function getSummary({ fresh = false } = {}) {
  if (!whoop.isConnected()) return summarize(demoData());
  if (!fresh && cache && Date.now() - cache.at < 5 * 60_000) return cache.summary;
  const summary = summarize(await whoop.fetchAll(14));
  cache = { at: Date.now(), summary };
  return summary;
}

app.get("/api/status", (_req, res) => {
  res.json({
    whoopConfigured: whoop.isConfigured(),
    whoopConnected: whoop.isConnected(),
    coachConfigured: coachConfigured(),
  });
});

app.get("/api/summary", async (req, res) => {
  try {
    res.json(await getSummary({ fresh: req.query.fresh === "1" }));
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

// ---------- Coach (Server-Sent Events stream) ----------
app.post("/api/coach", async (req, res) => {
  if (!coachConfigured()) {
    return res.status(400).json({ error: "Set ANTHROPIC_API_KEY in .env to enable the coach." });
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const summary = await getSummary();
    await streamCoach({
      summary,
      profile: req.body?.profile,
      messages: Array.isArray(req.body?.messages) ? req.body.messages : [],
      onText: (t) => send("text", t),
    });
    send("done", {});
  } catch (e) {
    console.error(e);
    send("error", { message: e.message });
  }
  res.end();
});

app.listen(PORT, () => {
  console.log(`Eureka running at http://localhost:${PORT}`);
  if (!whoop.isConfigured()) console.log("  WHOOP keys not set - showing demo data.");
  if (!coachConfigured()) console.log("  ANTHROPIC_API_KEY not set - coach disabled.");
});
