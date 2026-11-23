// Turn raw WHOOP records into one row per day - used by the dashboard and the coach.
const hrs = (ms) => (ms == null ? null : +(ms / 3_600_000).toFixed(2));
const dayKey = (iso) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function summarize(raw) {
  const sleepById = new Map(raw.sleep.map((s) => [s.id, s]));
  const recByCycle = new Map(raw.recovery.map((r) => [r.cycle_id, r]));

  const days = raw.cycles
    .map((c) => {
      const rec = recByCycle.get(c.id);
      const sl =
        (rec && sleepById.get(rec.sleep_id)) ||
        raw.sleep.find((s) => s.cycle_id === c.id && !s.nap);
      const st = sl?.score?.stage_summary;
      const asleep = st ? st.total_in_bed_time_milli - st.total_awake_time_milli : null;
      // A cycle starts when you fall asleep, so label it by the day you wake up.
      const date = dayKey(sl?.end ?? c.start);
      const cStart = new Date(c.start).getTime();
      const cEnd = c.end ? new Date(c.end).getTime() : Infinity;
      return {
        date,
        cycleId: c.id,
        recovery: rec?.score?.recovery_score ?? null,
        hrv: rec?.score?.hrv_rmssd_milli ?? null,
        rhr: rec?.score?.resting_heart_rate ?? null,
        spo2: rec?.score?.spo2_percentage ?? null,
        skinTemp: rec?.score?.skin_temp_celsius ?? null,
        strain: c.score?.strain ?? null,
        calories: c.score?.kilojoule ? Math.round(c.score.kilojoule / 4.184) : null,
        sleep: sl
          ? {
              bedtime: sl.start,
              wake: sl.end,
              hoursAsleep: hrs(asleep),
              hoursInBed: hrs(st?.total_in_bed_time_milli),
              rem: hrs(st?.total_rem_sleep_time_milli),
              deep: hrs(st?.total_slow_wave_sleep_time_milli),
              light: hrs(st?.total_light_sleep_time_milli),
              awake: hrs(st?.total_awake_time_milli),
              performance: sl.score?.sleep_performance_percentage ?? null,
              consistency: sl.score?.sleep_consistency_percentage ?? null,
              efficiency: sl.score?.sleep_efficiency_percentage ?? null,
              respiratoryRate: sl.score?.respiratory_rate ?? null,
              disturbances: st?.disturbance_count ?? null,
              neededHours: sl.score?.sleep_needed
                ? hrs(
                    (sl.score.sleep_needed.baseline_milli ?? 0) +
                      (sl.score.sleep_needed.need_from_sleep_debt_milli ?? 0) +
                      (sl.score.sleep_needed.need_from_recent_strain_milli ?? 0) -
                      (sl.score.sleep_needed.need_from_recent_nap_milli ?? 0)
                  )
                : null,
            }
          : null,
        workouts: raw.workouts
          .filter((w) => {
            const t = new Date(w.start).getTime();
            return t >= cStart && t < cEnd;
          })
          .map((w) => ({
            sport: w.sport_name ?? `Sport ${w.sport_id}`,
            start: w.start,
            minutes: Math.round((new Date(w.end) - new Date(w.start)) / 60_000),
            strain: w.score?.strain ?? null,
            avgHr: w.score?.average_heart_rate ?? null,
            maxHr: w.score?.max_heart_rate ?? null,
          })),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const avg = (k) => {
    const v = days.map((d) => d[k]).filter((x) => x != null);
    return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null;
  };

  return {
    source: raw.source,
    name: raw.profile?.first_name ?? null,
    body: raw.body ?? null,
    today: days.at(-1) ?? null,
    days,
    baselines: { recovery: avg("recovery"), hrv: avg("hrv"), rhr: avg("rhr"), strain: avg("strain") },
  };
}
