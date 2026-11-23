// Realistic fake data in WHOOP v2 response shapes, so the app works before you connect.
const DAY = 86_400_000;

function rng(seed) {
  return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
}

export function demoData(days = 14) {
  const rand = rng(42);
  const cycles = [], recovery = [], sleep = [], workouts = [];
  const sports = ["Running", "Functional Fitness", "Weightlifting", "Cycling", "Yoga"];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 0; i--) {
    const dayStart = today.getTime() - i * DAY;
    const cycleId = 1000 + i;
    const sleepId = `demo-sleep-${i}`;
    const bed = dayStart - 1.5 * 3600_000 + rand() * 3600_000; // ~22:30-23:30
    const inBed = (6.6 + rand() * 2.2) * 3600_000;
    const awake = inBed * (0.06 + rand() * 0.06);
    const asleep = inBed - awake;
    const rem = asleep * (0.2 + rand() * 0.06);
    const sws = asleep * (0.17 + rand() * 0.06);
    const sleepPerf = Math.min(100, Math.round((asleep / (8 * 3600_000)) * 100));
    const rec = Math.round(Math.max(8, Math.min(99, 30 + sleepPerf * 0.45 + (rand() - 0.5) * 40)));

    sleep.push({
      id: sleepId, cycle_id: cycleId, start: new Date(bed).toISOString(),
      end: new Date(bed + inBed).toISOString(), nap: false, score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: inBed, total_awake_time_milli: awake,
          total_light_sleep_time_milli: asleep - rem - sws,
          total_slow_wave_sleep_time_milli: sws, total_rem_sleep_time_milli: rem,
          sleep_cycle_count: 4 + Math.round(rand() * 2), disturbance_count: Math.round(rand() * 12),
        },
        sleep_needed: { baseline_milli: 7.8 * 3600_000, need_from_sleep_debt_milli: rand() * 3600_000 },
        respiratory_rate: +(14.5 + rand() * 1.5).toFixed(1),
        sleep_performance_percentage: sleepPerf,
        sleep_consistency_percentage: Math.round(60 + rand() * 35),
        sleep_efficiency_percentage: +((asleep / inBed) * 100).toFixed(1),
      },
    });
    recovery.push({
      cycle_id: cycleId, sleep_id: sleepId, score_state: "SCORED",
      created_at: new Date(bed + inBed).toISOString(),
      score: {
        user_calibrating: false, recovery_score: rec,
        resting_heart_rate: Math.round(62 - rec * 0.12 + rand() * 3),
        hrv_rmssd_milli: +(35 + rec * 0.6 + rand() * 8).toFixed(1),
        spo2_percentage: +(95 + rand() * 3).toFixed(1),
        skin_temp_celsius: +(33.4 + rand() * 0.8).toFixed(2),
      },
    });
    const strain = i === 0 ? +(4 + rand() * 4).toFixed(1) : +(7 + rand() * 11).toFixed(1);
    cycles.push({
      id: cycleId, start: new Date(bed).toISOString(),
      end: i === 0 ? null : new Date(bed + DAY).toISOString(), score_state: "SCORED",
      score: { strain, kilojoule: Math.round(8000 + strain * 450), average_heart_rate: 68, max_heart_rate: 150 + Math.round(rand() * 35) },
    });
    if (rand() > 0.3 && i !== 0) {
      const wStart = dayStart + (7 + rand() * 11) * 3600_000;
      const dur = (35 + rand() * 50) * 60_000;
      const ws = +(6 + rand() * 9).toFixed(1);
      workouts.push({
        id: `demo-workout-${i}`, start: new Date(wStart).toISOString(),
        end: new Date(wStart + dur).toISOString(), sport_name: sports[Math.floor(rand() * sports.length)],
        score_state: "SCORED",
        score: { strain: ws, average_heart_rate: 130 + Math.round(rand() * 20), max_heart_rate: 165 + Math.round(rand() * 20), kilojoule: Math.round(dur / 60_000 * 45) },
      });
    }
  }
  return {
    source: "demo",
    profile: { user_id: 0, first_name: "Demo", last_name: "User", email: "demo@example.com" },
    body: { height_meter: 1.78, weight_kilogram: 75, max_heart_rate: 195 },
    cycles: cycles.reverse(), recovery: recovery.reverse(), sleep: sleep.reverse(), workouts: workouts.reverse(),
  };
}
