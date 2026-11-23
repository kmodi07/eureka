// Read-only MCP tools over the WHOOP v2 API.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const ms2h = (ms) => (ms == null ? null : Math.round((ms / 3_600_000) * 100) / 100);
const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const range = {
  days: z.number().int().min(1).max(90).default(7).describe("How many days back to look (1-90). Default 7."),
  limit: z.number().int().min(1).max(100).default(10).describe("Max records to return, newest first (1-100). Default 10."),
};
const since = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] });

export const fmtRecovery = (r) => ({
  source: "WHOOP API v2 /v2/recovery",
  cycle_id: r.cycle_id, sleep_id: r.sleep_id, date: r.created_at, score_state: r.score_state,
  recovery_score_pct: r.score?.recovery_score ?? null,
  hrv_rmssd_ms: r.score?.hrv_rmssd_milli ?? null,
  resting_heart_rate_bpm: r.score?.resting_heart_rate ?? null,
  spo2_pct: r.score?.spo2_percentage ?? null,
  skin_temp_c: r.score?.skin_temp_celsius ?? null,
  user_calibrating: r.score?.user_calibrating ?? null,
});

export const fmtSleep = (s) => {
  const st = s.score?.stage_summary;
  return {
    source: "WHOOP API v2 /v2/activity/sleep",
    id: s.id, start: s.start, end: s.end, nap: s.nap, score_state: s.score_state,
    hours_asleep: st ? ms2h(st.total_in_bed_time_milli - st.total_awake_time_milli) : null,
    hours_in_bed: ms2h(st?.total_in_bed_time_milli),
    hours_rem: ms2h(st?.total_rem_sleep_time_milli),
    hours_deep: ms2h(st?.total_slow_wave_sleep_time_milli),
    hours_light: ms2h(st?.total_light_sleep_time_milli),
    hours_awake: ms2h(st?.total_awake_time_milli),
    sleep_performance_pct: s.score?.sleep_performance_percentage ?? null,
    sleep_efficiency_pct: s.score?.sleep_efficiency_percentage ?? null,
    sleep_consistency_pct: s.score?.sleep_consistency_percentage ?? null,
    respiratory_rate: s.score?.respiratory_rate ?? null,
  };
};

export const fmtCycle = (c) => ({
  source: "WHOOP API v2 /v2/cycle",
  id: c.id, start: c.start, end: c.end ?? "in progress", score_state: c.score_state,
  strain: c.score?.strain ?? null,
  kilojoules: c.score?.kilojoule ?? null,
  avg_heart_rate_bpm: c.score?.average_heart_rate ?? null,
  max_heart_rate_bpm: c.score?.max_heart_rate ?? null,
});

const fmtWorkout = (w) => ({
  source: "WHOOP API v2 /v2/activity/workout",
  id: w.id, sport: w.sport_name ?? null, start: w.start, end: w.end, score_state: w.score_state,
  strain: w.score?.strain ?? null, avg_heart_rate_bpm: w.score?.average_heart_rate ?? null,
  max_heart_rate_bpm: w.score?.max_heart_rate ?? null, kilojoules: w.score?.kilojoule ?? null,
});

export function buildMcpServer(whoop, { includeWorkouts }) {
  const server = new McpServer({ name: "whoop-personal", version: "0.1.0" });

  server.registerTool("whoop_latest", {
    title: "Latest WHOOP snapshot",
    description: "Most recent WHOOP recovery (score, HRV, resting HR), most recent main sleep (duration, stages) and most recent physiological cycle (day strain), each with its date. Use this first.",
    inputSchema: {}, annotations: ro,
  }, async () => {
    try {
      const [rec, sleeps, cyc] = await Promise.all([
        whoop.collection("/v2/recovery", { max: 1 }),
        whoop.collection("/v2/activity/sleep", { max: 5 }),
        whoop.collection("/v2/cycle", { max: 1 }),
      ]);
      const mainSleep = sleeps.find((s) => !s.nap) ?? sleeps[0];
      return text({
        recovery: rec[0] ? fmtRecovery(rec[0]) : "missing (no recovery records returned)",
        sleep: mainSleep ? fmtSleep(mainSleep) : "missing (no sleep records returned)",
        cycle: cyc[0] ? fmtCycle(cyc[0]) : "missing (no cycle records returned)",
      });
    } catch (e) { return fail(e); }
  });

  server.registerTool("whoop_recovery", {
    title: "WHOOP recovery history",
    description: "Recovery records (recovery %, HRV rMSSD ms, resting HR, SpO2, skin temp), newest first.",
    inputSchema: range, annotations: ro,
  }, async ({ days, limit }) => {
    try { return text((await whoop.collection("/v2/recovery", { start: since(days), max: limit })).map(fmtRecovery)); }
    catch (e) { return fail(e); }
  });

  server.registerTool("whoop_sleep", {
    title: "WHOOP sleep history",
    description: "Sleep records (time asleep, stages, performance, efficiency, consistency, respiratory rate), newest first. Includes naps (nap: true).",
    inputSchema: range, annotations: ro,
  }, async ({ days, limit }) => {
    try { return text((await whoop.collection("/v2/activity/sleep", { start: since(days), max: limit })).map(fmtSleep)); }
    catch (e) { return fail(e); }
  });

  server.registerTool("whoop_cycles", {
    title: "WHOOP strain (cycles)",
    description: "Physiological cycles with day strain, energy (kJ) and heart rate, newest first. The newest cycle may still be in progress.",
    inputSchema: range, annotations: ro,
  }, async ({ days, limit }) => {
    try { return text((await whoop.collection("/v2/cycle", { start: since(days), max: limit })).map(fmtCycle)); }
    catch (e) { return fail(e); }
  });

  if (includeWorkouts) {
    server.registerTool("whoop_workouts", {
      title: "WHOOP workouts",
      description: "Workouts with sport, strain and heart rate, newest first.",
      inputSchema: range, annotations: ro,
    }, async ({ days, limit }) => {
      try { return text((await whoop.collection("/v2/activity/workout", { start: since(days), max: limit })).map(fmtWorkout)); }
      catch (e) { return fail(e); }
    });
  }

  return server;
}
