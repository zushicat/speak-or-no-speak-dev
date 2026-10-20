/**
 * WP1 smoke wiring (plan 1.4 + 1.5) — will be replaced by the real demo in WP2.
 * UI mapping only; all detection logic lives in src/.
 */
import { SileroVadAdapter } from "../src/vad/silero-vad-adapter.js";

// WP0.5 probe kept: secure context must hold for mic access.
console.log("secure context:", window.isSecureContext,
            "mediaDevices:", !!navigator.mediaDevices);

const button = document.getElementById("start");
const indicator = document.getElementById("indicator");
const statusEl = document.getElementById("status");

// --- 1.5 performance probe state -------------------------------------------
const handlerDurationsMs = [];
const frameIntervalsMs = [];
let lastFrameAt = 0;
let frameCount = 0;
let probeTimer = null;
// Live perf arrays for external probes (WP1 verification tooling).
window.__sonsPerf = { handlerDurationsMs, frameIntervalsMs, frameCountRef: () => frameCount };

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function logPerfSummary() {
  const durations = [...handlerDurationsMs].sort((a, b) => a - b);
  const intervals = [...frameIntervalsMs].sort((a, b) => a - b);
  const summary = {
    frames: frameCount,
    handler_p50_ms: +percentile(durations, 50).toFixed(3),
    handler_p95_ms: +percentile(durations, 95).toFixed(3),
    frame_interval_p50_ms: +percentile(intervals, 50).toFixed(1),
    frame_interval_p95_ms: +percentile(intervals, 95).toFixed(1),
    verdict: percentile(durations, 95) < 8
      ? "main-thread inference OK (p95 < 8 ms)"
      : "p95 >= 8 ms → WP7 worker contingency must trigger",
  };
  console.log("[sons] perf summary after 60 s:", summary);
}

// --- 1.4 smoke wiring -------------------------------------------------------
button.addEventListener("click", async () => {
  button.disabled = true;
  statusEl.textContent = "starting…\n";

  const engine = new SileroVadAdapter();
  window.__sonsEngine = engine; // debug handle (WP1 smoke; useful until WP3 tests)
  engine.onError((err) => {
    // Clean error path — including the cdn-unavailable guard (acceptance last bullet).
    console.error("[sons] onError:", err);
    statusEl.textContent += `error [${err.code}]: ${err.message}\n`;
    button.disabled = false;
  });

  engine.onFrame((frame) => {
    // 1.5: measure handler time (the number that decides worker contingency).
    const t0 = performance.now();

    frameCount += 1;
    if (lastFrameAt > 0) frameIntervalsMs.push(performance.now() - lastFrameAt);
    lastFrameAt = performance.now();

    // 1.4: every 10th frame → console; naive indicator (pre-WP2 sanity check, D2).
    if (frameCount % 10 === 0) {
      console.log(`[sons] frame #${frameCount} prob=${frame.probability.toFixed(3)} rms=${frame.rms.toFixed(4)}`);
    }
    indicator.classList.toggle("speech", frame.probability > 0.6);
    if (frameCount % 5 === 0) {
      statusEl.textContent = `frames: ${frameCount}  last prob: ${frame.probability.toFixed(3)}  rms: ${frame.rms.toFixed(4)}\n` +
        (engine.micSettings
          ? `mic: echoCancellation=${engine.micSettings.echoCancellation} ` +
            `noiseSuppression=${engine.micSettings.noiseSuppression} ` +
            `autoGainControl=${engine.micSettings.autoGainControl} ` +
            `sampleRate=${engine.micSettings.sampleRate ?? "?"} ` +
            `aecDegraded=${engine.aecDegraded}\n`
          : "");
    }

    handlerDurationsMs.push(performance.now() - t0);
  });

  try {
    await engine.start(); // mic + model load happen inside the user gesture
    const settings = engine.micSettings ?? {};
    console.log("[sons] mic track settings (once):", settings);
    console.log("[sons] engine runtime findings: frameParamProvided =", engine.frameParamProvided);
    statusEl.textContent += "listening — speak and watch the circle/console.\n";
    probeTimer = setTimeout(logPerfSummary, 60_000); // 1.5: summary after 60 s
  } catch (err) {
    // onError already reported the taxonomy code; keep the button usable.
    button.disabled = false;
  }
});
