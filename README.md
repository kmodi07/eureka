# Eureka - your WHOOP, with a Claude coach

A personal web app that pulls your **WHOOP** data (recovery, HRV, resting HR, sleep stages, strain, workouts) through the official WHOOP API. It shows the data on a dashboard and uses **Claude** to turn it into a daily plan you can chat with.

- **Dashboard:** today's recovery ring, HRV/RHR/sleep/strain against your 14-day baseline, recovery and HRV-vs-strain trends, last night's sleep stages, recent workouts.
- **Coach:** "Plan my day" gives you a training target, bedtime, focus windows and trend notes. You can also ask follow-ups ("Should I train hard today?", "Why is my HRV down?"). Add your goals and today's schedule so the plan fits your life.
- **Demo mode:** the app runs on realistic fake data until you connect WHOOP.

## Quick start

```bash
npm install
cp .env.example .env    # then fill in the keys below
npm start               # http://localhost:3000
```

### 1. Get WHOOP API keys (about 5 minutes)

1. Go to the [WHOOP Developer Dashboard](https://developer-dashboard.whoop.com) and sign in with your WHOOP account.
2. Create a **Team** if asked, then **Create App**.
3. Scopes: tick `read:recovery`, `read:cycles`, `read:sleep`, `read:workout`, `read:profile`, `read:body_measurement` (`offline` is requested automatically so you stay logged in).
4. Redirect URL: `http://localhost:3000/auth/whoop/callback`. It must match `WHOOP_REDIRECT_URI` in `.env` exactly.
5. Copy the **Client ID** and **Client Secret** into `.env`.

### 2. Get a Claude API key

Create a key at [console.anthropic.com](https://console.anthropic.com) and set `ANTHROPIC_API_KEY` in `.env`. The coach uses `claude-opus-5-5` by default; override it with `CLAUDE_MODEL`.

### 3. Connect

Restart `npm start`, open http://localhost:3000, click **Connect WHOOP** and approve. Tokens are saved locally to `data/tokens.json`, which git ignores. They refresh automatically.

## How it works

```
server.js          Express app: OAuth routes, /api/summary, /api/coach (SSE stream)
lib/whoop.js       WHOOP v2 API client: OAuth, token refresh, pagination
lib/summarize.js   Raw WHOOP records -> one tidy row per day + baselines
lib/coach.js       Claude prompt + streaming
lib/demo.js        Fake data in WHOOP's response format
public/            Dashboard (plain HTML/CSS/JS, no build step)
```

WHOOP endpoints used: `/v2/user/profile/basic`, `/v2/user/measurement/body`, `/v2/cycle`, `/v2/recovery`, `/v2/activity/sleep`, `/v2/activity/workout`. The app fetches the last 14 days and caches them for 5 minutes. Use ↻ to force a refresh.

## Privacy

Everything runs on your machine. Your WHOOP data goes to only two places: WHOOP's API, which you're reading from, and Anthropic's API, and only when you ask the coach something. This is a single-user local app; don't deploy it publicly as-is.

## Ideas to extend

- Morning brief by email or SMS on a schedule
- Calendar integration so the coach plans around real events
- WHOOP webhooks (`recovery.updated`) to trigger the plan the moment you wake up
- Long-term storage (SQLite) for trends beyond 14 days
