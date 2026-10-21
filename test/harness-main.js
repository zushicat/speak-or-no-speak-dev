/**
 * Calibration harness UI (WP6 §6.1): live timeline canvas, scenario recorder
 * with ground-truth marks, offline replay + metrics table.
 *
 * Browser-only module — guarded so Node's test runner (which auto-executes
 * every .js under test/) loads it harmlessly.
 */
import { createSpeakOrNoSpeak, DEFAULTS } from "../src/index.js";
import { replayScenario, computeMetrics, aggregateMetrics } from "./harness/replay.js";

if (typeof document === "undefined") {
  // Node (test-runner import): nothing to do.
} else {
  initHarness();
}

function initHarness() {
  const $ = (id) => document.getElementById(id);
  const canvas = $("timeline");
  const ctx2d = canvas.getContext("2d");
  const status = $("hStatus");
  const recStatus = $("recStatus");

  // --- facade + live data -------------------------------------------------
  let sons = null;
  /** scrolling window of live frames: {t, prob, rms} (t = performance.now ms) */
  const liveFrames = [];
  /** live event markers: {t, kind} */
  const liveMarks = [];
  const WINDOW_MS = 20000;

  // --- recording state ----------------------------------------------------
  let recording = null; // {name, startedAt, frames, events, marks}
  let lastFrameT = 0;

  $("hStart").addEventListener("click", async () => {
    $("hStart").disabled = true;
    status.textContent = "starting…";
    sons = await createSpeakOrNoSpeak({
      onSpeechStart: () => { liveMarks.push({ t: performance.now(), kind: "onset" }); recordEvent({ kind: "onSpeechStart", t: recT() }); },
      onTurnEnd: (e) => { liveMarks.push({ t: performance.now(), kind: "turnEnd" }); recordEvent({ kind: "onTurnEnd", t: recT(), durationMs: e.durationMs, truncated: e.truncated, afterInterrupt: e.afterInterrupt, stats: e.stats }); },
      onInterrupt: (i) => { liveMarks.push({ t: performance.now(), kind: "interrupt" }); recordEvent({ kind: "onInterrupt", t: recT(), latencyMs: i.latencyMs, atMs: i.atMs }); },
      onLevel: () => {},
      onError: (e) => { status.textContent = `error [${e.code}]`; },
    });
    try {
      await sons.start();
      status.textContent = "mic live — timeline scrolling";
      window.__sons = sons; // tooling handle (automation/instrumentation)
    } catch {
      $("hStart").disabled = false;
      status.textContent = "start failed";
    }
  });

  /** recording-relative time in ms (or 0 when not recording) */
  function recT() {
    return recording ? performance.now() - recording.startedAt : 0;
  }

  function recordEvent(ev) {
    if (recording) {
      recording.events.push(ev);
      window.__recEvents = recording.events.length; // live counter for automation
    }
  }

  // frame tap: feed the timeline + the recorder (before/around the detector is
  // equivalent — we tap via onLevel? onLevel only carries rms; we need prob —
  // tap the detector directly like the test tooling does.)
  // NOTE: installed after facade creation below.

  // --- timeline drawing ---------------------------------------------------
  function draw() {
    requestAnimationFrame(draw);
    if (!sons) return;
    const now = performance.now();
    const w = canvas.width, h = canvas.height;
    ctx2d.clearRect(0, 0, w, h);
    // grid
    ctx2d.strokeStyle = "#22262c";
    for (let i = 1; i < 5; i++) {
      ctx2d.beginPath(); ctx2d.moveTo(0, (h / 5) * i); ctx2d.lineTo(w, (h / 5) * i); ctx2d.stroke();
    }
    const visible = liveFrames.filter(f => now - f.t <= WINDOW_MS);
    if (!visible.length) return;
    const toX = (t) => w - ((now - t) / WINDOW_MS) * w;
    // prob (green)
    ctx2d.strokeStyle = "#22c55e"; ctx2d.lineWidth = 1.5; ctx2d.beginPath();
    for (let i = 0; i < visible.length; i++) {
      const x = toX(visible[i].t), y = h - visible[i].prob * h;
      i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    // rms (yellow)
    ctx2d.strokeStyle = "#eab308"; ctx2d.lineWidth = 1; ctx2d.beginPath();
    for (let i = 0; i < visible.length; i++) {
      const x = toX(visible[i].t), y = h - Math.min(1, visible[i].rms * 4) * h;
      i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    // event markers
    for (const m of liveMarks.filter(m => now - m.t <= WINDOW_MS)) {
      ctx2d.strokeStyle = m.kind === "onset" ? "#4ade80" : m.kind === "turnEnd" ? "#fb923c" : "#f87171";
      ctx2d.lineWidth = 2;
      ctx2d.beginPath(); ctx2d.moveTo(toX(m.t), 0); ctx2d.lineTo(toX(m.t), h); ctx2d.stroke();
    }
  }
  requestAnimationFrame(draw);

  // tap frames AFTER the facade exists (wrap the detector)
  const tapFrames = () => {
    if (!sons) return;
    const det = sons._detector;
    const orig = det.onFrame.bind(det);
    det.onFrame = (f) => {
      const t = performance.now();
      liveFrames.push({ t, prob: f.probability, rms: f.rms });
      if (recording) recording.frames.push({ t: t - recording.startedAt, prob: f.probability, rms: f.rms });
      if (liveFrames.length > 4000) liveFrames.splice(0, liveFrames.length - 4000);
      orig(f);
    };
  };
  $("hStart").addEventListener("click", () => setTimeout(tapFrames, 300));

  // --- recorder -----------------------------------------------------------
  $("recStart").addEventListener("click", () => {
    if (!sons) { recStatus.textContent = "start the microphone first"; return; }
    // Start from a deterministic state: the replay must see the same machine
    // state the live run saw (mid-turn leftovers would desync the replay).
    sons.setAgentSpeaking(false); // never inherit an armed flag from a previous round
    sons._detector.reset();
    recording = {
      name: $("scenName").value.trim() || `scenario-${new Date().toISOString().slice(11, 19)}`,
      createdAt: Date.now(),
      browser: navigator.userAgent,
      noaec: new URLSearchParams(location.search).has("noaec"),
      thresholds: structuredClone(DEFAULTS.thresholds),
      frames: [], events: [], marks: [], agentFlags: [],
      startedAt: performance.now(),
    };
    // Record the agent-flag timeline so interrupt scenarios replay faithfully.
    let lastFlag = sons._detector.agentSpeaking;
    const flagIv = setInterval(() => {
      if (!recording) { clearInterval(flagIv); return; }
      const cur = sons._detector.agentSpeaking;
      if (cur !== lastFlag) {
        lastFlag = cur;
        recording.agentFlags.push({ t: recT(), active: cur });
      }
    }, 100);
    $("recStart").disabled = true;
    $("recStop").disabled = false;
    $("markStart").disabled = false;
    $("markEnd").disabled = false;
    recStatus.textContent = "recording…";
  });

  $("recStop").addEventListener("click", () => {
    if (!recording) return;
    const rec = recording;
    rec.durationMs = recT();
    recording = null;
    $("recStart").disabled = false;
    $("recStop").disabled = true;
    $("markStart").disabled = true;
    $("markEnd").disabled = true;
    recStatus.textContent = `saved: ${rec.name} (${(rec.durationMs / 1000).toFixed(1)} s, ${rec.frames.length} frames)`;
    saveRecording(rec);
  });

  $("markStart").addEventListener("click", () => recording?.marks.push({ kind: "speech-start", t: recT() }));
  $("markEnd").addEventListener("click", () => recording?.marks.push({ kind: "speech-end", t: recT() }));

  function saveRecording(rec) {
    const key = "sons-recordings";
    const list = JSON.parse(localStorage.getItem(key) ?? "[]");
    list.push(rec);
    while (list.length > 10) list.shift();
    localStorage.setItem(key, JSON.stringify(list));
    renderRecList();
  }

  function renderRecList() {
    const list = JSON.parse(localStorage.getItem("sons-recordings") ?? "[]");
    const container = $("recList");
    container.textContent = "";
    const pick = $("replayPick");
    pick.textContent = "";
    list.forEach((rec, i) => {
      const b = document.createElement("button");
      b.textContent = `↺ ${rec.name} (${((rec.frames[rec.frames.length - 1]?.t ?? 0) / 1000).toFixed(0)} s)`;
      b.addEventListener("click", () => replayAndShow([rec]));
      container.appendChild(b);
      const d = document.createElement("button");
      d.textContent = "⤓";
      d.title = "download JSON";
      d.addEventListener("click", () => {
        const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${rec.name.replace(/[^\w.-]+/g, "_")}.json`;
        a.click();
      });
      container.appendChild(d);
      const x = document.createElement("button");
      x.textContent = "✕";
      x.addEventListener("click", () => {
        list.splice(i, 1);
        localStorage.setItem("sons-recordings", JSON.stringify(list));
        renderRecList();
      });
      container.appendChild(x);
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = rec.name;
      pick.appendChild(opt);
    });
  }
  renderRecList();

  // --- replay + metrics ---------------------------------------------------
  function replayAndShow(recordings) {
    const useRecorded = $("useRecordedThresholds").checked;
    const rows = [];
    for (const rec of recordings) {
      const thresholds = useRecorded ? rec.thresholds : undefined;
      const { events } = replayScenario(rec, thresholds);
      const durationMs = rec.frames[rec.frames.length - 1]?.t ?? 0;
      const metrics = computeMetrics(events, rec.marks ?? [], durationMs, rec.frames);
      rows.push({ name: rec.name, metrics, durationMs });
    }
    const tbody = $("metricsTable").querySelector("tbody");
    tbody.textContent = "";
    for (const { name, metrics, durationMs } of rows) {
      const tr = document.createElement("tr");
      const cells = [
        name,
        metrics.onsetLatenciesMs.length,
        fmtPair(metrics.onsetLatenciesMs),
        metrics.turnEndLatenciesMs.length,
        fmtPair(metrics.turnEndLatenciesMs),
        metrics.interruptLatenciesMs.length,
        fmtPair(metrics.interruptLatenciesMs),
        metrics.falseOnsets,
        metrics.prematureTurnEnds,
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        td.textContent = String(c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    const agg = aggregateMetrics(rows);
    $("aggRow").textContent = `AGGREGATE — onset p50/p95: ${agg.onset.p50}/${agg.onset.p95} ms · turnEnd p50/p95: ${agg.turnEnd.p50}/${agg.turnEnd.p95} ms · interrupt p50/p95: ${agg.interrupt.p50}/${agg.interrupt.p95} ms · premature: ${agg.prematureTurnEnds}/${agg.totalTurnEnds} · false onsets/min: ${agg.falseOnsetsPerMin ?? "n/a"}`;
  }

  const fmtPair = (arr) => {
    if (!arr.length) return "–";
    const s = [...arr].sort((a, b) => a - b);
    return `${Math.round(s[Math.floor(s.length * 0.5)])}/${Math.round(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)])}`;
  };

  $("replayAll").addEventListener("click", () => {
    const list = JSON.parse(localStorage.getItem("sons-recordings") ?? "[]");
    if (!list.length) { $("aggRow").textContent = "no recordings saved yet"; return; }
    replayAndShow(list);
  });
}
