// Claude-powered coach: turns your WHOOP data into a daily plan and answers questions.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const SYSTEM = `You are Eureka, a personal performance coach built on top of the user's WHOOP data.

How to work:
- Ground every recommendation in the numbers you're given (recovery %, HRV, resting HR, sleep, strain). Cite the specific number when it drives a call.
- Compare today against the user's own recent baselines, not population norms.
- WHOOP recovery zones: green 67-100% (ready to push), yellow 34-66% (moderate), red 0-33% (prioritise recovery).
- Be direct and practical. Use short headings and bullets. No filler, no disclaimers unless something looks medically concerning (e.g. sustained very low HRV with high RHR and elevated skin temp/respiratory rate) - then suggest checking in with a doctor.
- You are not a doctor; don't diagnose.`;

const PLAN_PROMPT = `Write today's plan. Structure:
## Today at a glance
One or two sentences: recovery zone and what it means for today.
## Training
Target strain range for today and what kind of session (or rest) fits.
## Sleep tonight
Recommended bedtime and wake time to hit tonight's sleep need, and one tip based on last night's stages/consistency.
## Energy & focus
When to schedule hard thinking vs. lighter work, caffeine cut-off, hydration/nutrition notes tied to the data.
## Trend watch
1-3 bullets on notable patterns across the last two weeks.
Keep it under ~300 words.`;

let client;
const getClient = () => (client ??= new Anthropic());
export const coachConfigured = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function dataBlock(summary, profile) {
  const now = new Date();
  return [
    `Current local time: ${now.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" })}`,
    profile?.goals ? `User's goals: ${profile.goals}` : null,
    profile?.schedule ? `User's schedule today: ${profile.schedule}` : null,
    `WHOOP data (${summary.source === "demo" ? "DEMO data - not real" : "live"}), one row per day, oldest first:`,
    "```json",
    JSON.stringify({ baselines: summary.baselines, body: summary.body, days: summary.days }),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Stream a coach reply. `messages` is the chat history ([{role, content}]);
 * empty means "generate today's plan". Calls onText for each text delta.
 */
export async function streamCoach({ summary, profile, messages = [], onText }) {
  const history = (messages.length ? messages : [{ role: "user", content: "__PLAN__" }]).map((m) =>
    m.role === "user" && m.content === "__PLAN__" ? { ...m, content: PLAN_PROMPT } : m
  );
  // Prepend the data to the first user turn so the system prompt stays cacheable.
  const [first, ...rest] = history;
  const apiMessages = [
    { role: "user", content: `${dataBlock(summary, profile)}\n\n${first.content}` },
    ...rest.map((m) => ({ role: m.role, content: m.content })),
  ];

  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    // If a safety classifier declines, the API retries on a suitable fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: apiMessages,
  });

  stream.on("text", (t) => onText(t));
  const final = await stream.finalMessage();
  if (final.stop_reason === "refusal") {
    onText("\n\n_The coach declined to answer that one. Try rephrasing._");
  }
  return final;
}
