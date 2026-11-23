const $ = (id) => document.getElementById(id);
const zoneColor = (r) => (r == null ? "var(--muted)" : r >= 67 ? "var(--green)" : r >= 34 ? "var(--yellow)" : "var(--red)");
const fmtH = (h) => (h == null ? "–" : `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, "0")}m`);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

let summary = null;
let status = null;
const chatHistory = []; // [{role, content}]

function banner(msg, isError = false) {
  const b = $("banner");
  b.textContent = msg;
  b.className = "banner" + (isError ? " error" : "");
}

async function loadStatus() {
  status = await fetch("/api/status").then((r) => r.json());
  $("connect-btn").classList.toggle("hidden", status.whoopConnected);
  $("disconnect-btn").classList.toggle("hidden", !status.whoopConnected);
  const badge = $("source-badge");
  badge.textContent = status.whoopConnected ? "Live WHOOP" : "Demo data";
  badge.classList.toggle("live", status.whoopConnected);
  if (!status.whoopConfigured) {
    $("connect-btn").title = "Add WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET to .env first";
  }
  if (!status.coachConfigured) {
    $("plan-btn").disabled = true;
    $("chat-input").disabled = true;
    $("chat-input").placeholder = "Add ANTHROPIC_API_KEY to .env to enable the coach";
  }
}

async function loadSummary(fresh = false) {
  const res = await fetch("/api/summary" + (fresh ? "?fresh=1" : ""));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Failed to load data");
  summary = data;
  render();
}

function delta(el, val, base, unit, higherIsBetter = true, neutral = false) {
  if (val == null || base == null) return (el.textContent = "");
  const d = +(val - base).toFixed(1);
  const good = higherIsBetter ? d >= 0 : d <= 0;
  el.textContent = `${d >= 0 ? "+" : ""}${d}${unit} vs 14-day avg`;
  el.className = "delta " + (neutral || Math.abs(d) < 0.05 ? "" : good ? "up" : "down");
}

function render() {
  const t = summary.today || {};
  const b = summary.baselines;
  const rec = t.recovery;
  const h = new Date().getHours();
  const name = summary.name ? `, ${summary.name}` : "";
  $("greeting").textContent = `${h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"}${name}`;
  $("today-date").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  $("recovery-val").textContent = rec == null ? "–" : `${rec}%`;
  const ring = $("ring-fg");
  ring.style.stroke = zoneColor(rec);
  ring.style.strokeDashoffset = 326.7 * (1 - (rec ?? 0) / 100);
  $("zone-text").textContent =
    rec == null ? "No recovery score yet today." :
    rec >= 67 ? "Green zone - your body is primed. A great day to push." :
    rec >= 34 ? "Yellow zone - maintain. Moderate effort, protect your sleep." :
    "Red zone - prioritise recovery. Go easy and rest up.";

  $("m-hrv").textContent = t.hrv != null ? `${Math.round(t.hrv)} ms` : "–";
  $("m-rhr").textContent = t.rhr != null ? `${t.rhr} bpm` : "–";
  $("m-sleep").textContent = fmtH(t.sleep?.hoursAsleep);
  $("m-strain").textContent = t.strain != null ? t.strain.toFixed(1) : "–";
  delta($("d-hrv"), t.hrv, b.hrv, " ms");
  delta($("d-rhr"), t.rhr, b.rhr, " bpm", false);
  $("d-sleep").textContent = t.sleep?.performance != null ? `${t.sleep.performance}% of need` : "";
  delta($("d-strain"), t.strain, b.strain, "", true, true);

  renderRecoveryChart();
  renderHrvChart();
  renderSleep(t.sleep);
  renderWorkouts();
}

function renderRecoveryChart() {
  const days = summary.days.slice(-14);
  const W = 420, H = 160, pad = 18, bw = (W - pad) / days.length;
  const bars = days.map((d, i) => {
    const v = d.recovery ?? 0;
    const bh = (v / 100) * (H - 30);
    const x = pad + i * bw + 3, y = H - 18 - bh;
    return `<rect x="${x}" y="${y}" width="${bw - 6}" height="${bh}" rx="3" fill="${zoneColor(d.recovery)}" opacity="${i === days.length - 1 ? 1 : 0.7}"><title>${d.date}: ${d.recovery ?? "–"}%</title></rect>
      <text x="${x + (bw - 6) / 2}" y="${H - 4}" text-anchor="middle" font-size="9" fill="#8b97a3">${new Date(d.date + "T12:00").getDate()}</text>`;
  });
  const grid = [33, 67].map((g) => `<line x1="${pad}" x2="${W}" y1="${H - 18 - (g / 100) * (H - 30)}" y2="${H - 18 - (g / 100) * (H - 30)}" stroke="#232a32" stroke-dasharray="3 3"/>`);
  $("chart-recovery").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${grid.join("")}${bars.join("")}</svg>`;
}

function renderHrvChart() {
  const days = summary.days.slice(-14);
  const W = 420, H = 160, pad = 18;
  const hrvs = days.map((d) => d.hrv).filter((v) => v != null);
  const lo = Math.min(...hrvs) * 0.9, hi = Math.max(...hrvs) * 1.05;
  const x = (i) => pad + (i * (W - pad * 2)) / Math.max(1, days.length - 1);
  const yH = (v) => H - 18 - ((v - lo) / (hi - lo || 1)) * (H - 30);
  const yS = (v) => H - 18 - (v / 21) * (H - 30);
  const line = (key, y) => days.map((d, i) => (d[key] == null ? null : `${x(i)},${y(d[key])}`)).filter(Boolean).join(" ");
  const dots = days.map((d, i) => d.hrv == null ? "" : `<circle cx="${x(i)}" cy="${yH(d.hrv)}" r="3" fill="var(--blue)"><title>${d.date}: HRV ${Math.round(d.hrv)} ms, strain ${d.strain ?? "–"}</title></circle>`);
  $("chart-hrv").innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <polyline points="${line("strain", yS)}" fill="none" stroke="var(--purple)" stroke-width="2" opacity=".7"/>
    <polyline points="${line("hrv", yH)}" fill="none" stroke="var(--blue)" stroke-width="2.5"/>${dots.join("")}</svg>`;
}

function renderSleep(s) {
  const el = $("sleep-stages");
  if (!s) return (el.innerHTML = `<p class="empty">No sleep recorded yet.</p>`);
  const stages = [["Awake", s.awake, "#5b6670"], ["Light", s.light, "#7aa7d6"], ["Deep (SWS)", s.deep, "#a78bfa"], ["REM", s.rem, "#3aa0ff"]];
  const total = stages.reduce((a, [, v]) => a + (v || 0), 0) || 1;
  el.innerHTML = `
    <div class="muted" style="font-size:14px">${fmtTime(s.bedtime)} → ${fmtTime(s.wake)} · ${fmtH(s.hoursAsleep)} asleep${s.neededHours ? ` (need ${fmtH(s.neededHours)})` : ""}</div>
    <div class="stages">${stages.map(([n, v, c]) => `<div title="${n}" style="width:${((v || 0) / total) * 100}%;background:${c}"></div>`).join("")}</div>
    <div class="stage-legend">${stages.map(([n, v, c]) => `<div><span class="sw" style="background:${c}"></span>${n} <b>${fmtH(v)}</b></div>`).join("")}
      <div class="muted">Efficiency <b>${s.efficiency ?? "–"}%</b></div><div class="muted">Consistency <b>${s.consistency ?? "–"}%</b></div>
      <div class="muted">Resp. rate <b>${s.respiratoryRate ?? "–"}</b></div><div class="muted">Disturbances <b>${s.disturbances ?? "–"}</b></div>
    </div>`;
}

function renderWorkouts() {
  const ws = summary.days.flatMap((d) => d.workouts).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 6);
  $("workouts").innerHTML = ws.length
    ? ws.map((w) => `<li><span>${esc(w.sport)}<br><span class="muted" style="font-size:13px">${new Date(w.start).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} · ${w.minutes} min · avg ${w.avgHr ?? "–"} bpm</span></span><b>${w.strain?.toFixed(1) ?? "–"}</b></li>`).join("")
    : `<li class="empty">No workouts in the last two weeks.</li>`;
}

// ---------- Coach ----------
function md(text) {
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/_(.+?)_/g, "<i>$1</i>").replace(/`(.+?)`/g, "<code>$1</code>");
  let html = "", inList = false;
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const hd = line.match(/^#{1,4}\s+(.*)/);
    if (hd) html += `<h3>${inline(hd[1])}</h3>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}

function addMsg(role, text = "") {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.innerHTML = role === "user" ? esc(text) : md(text);
  $("chat").appendChild(div);
  return div;
}

function profile() {
  return { goals: $("goals").value.trim(), schedule: $("schedule").value.trim() };
}

async function askCoach(messages) {
  const out = addMsg("assistant thinking");
  out.textContent = "Reading your data…";
  $("plan-btn").disabled = true;
  let text = "";
  try {
    const res = await fetch("/api/coach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, profile: profile() }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || "Coach failed");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const ev = chunk.match(/^event: (.*)$/m)?.[1];
        const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "null");
        if (ev === "text") { text += data; out.className = "msg assistant"; out.innerHTML = md(text); }
        if (ev === "error") throw new Error(data.message);
      }
    }
    chatHistory.push({ role: "assistant", content: text });
  } catch (e) {
    out.className = "msg assistant";
    out.innerHTML = `<p style="color:var(--red)">${esc(e.message)}</p>`;
    chatHistory.pop(); // drop the unanswered user turn
  } finally {
    $("plan-btn").disabled = !status?.coachConfigured;
  }
}

$("plan-btn").onclick = () => {
  chatHistory.length = 0;
  $("chat").innerHTML = "";
  chatHistory.push({ role: "user", content: "__PLAN__" }); // server swaps in its daily-plan prompt
  askCoach([...chatHistory]);
};

$("chat-form").onsubmit = (e) => {
  e.preventDefault();
  const q = $("chat-input").value.trim();
  if (!q) return;
  $("chat-input").value = "";
  $("chat").querySelector(".empty")?.remove();
  addMsg("user", q);
  chatHistory.push({ role: "user", content: q });
  askCoach([...chatHistory]);
};

$("settings-btn").onclick = () => $("settings").classList.toggle("hidden");
for (const id of ["goals", "schedule"]) {
  try { $(id).value = localStorage.getItem("eureka:" + id) || ""; } catch {}
  $(id).oninput = () => { try { localStorage.setItem("eureka:" + id, $(id).value); } catch {} };
}

$("disconnect-btn").onclick = async () => {
  await fetch("/auth/whoop/disconnect", { method: "POST" });
  await loadStatus(); await loadSummary();
};
$("refresh-btn").onclick = () => loadSummary(true).catch((e) => banner(e.message, true));

// ---------- Boot ----------
const params = new URLSearchParams(location.search);
if (params.get("error")) banner("WHOOP: " + params.get("error"), true);
if (params.get("connected")) banner("WHOOP connected - showing your live data.");
if (params.size) history.replaceState(null, "", "/");

(async () => {
  await loadStatus();
  if (!status.whoopConnected) banner("Showing demo data. Click “Connect WHOOP” to load your own (setup steps in the README).");
  try { await loadSummary(); } catch (e) { banner(e.message, true); }
  if (!status.coachConfigured) $("chat").innerHTML = `<p class="empty">Add an Anthropic API key to .env to get a daily plan and chat with your data.</p>`;
  else $("chat").innerHTML = `<p class="empty">Hit “Plan my day” for a plan built from today’s recovery, sleep and strain - or ask a question.</p>`;
})();
