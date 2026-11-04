/**
 * WP-E3 — coherence echo gate: correlation classifier (pure), detector
 * integration (armed-branch rejection, un-probed inheritance, suppressOnset),
 * regression guards, options merge, and the frame-budget probe (3.4).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { echoCorrelation } from "../../src/turn/echo-correlation.js";
import { TurnDetector } from "../../src/turn/turn-detector.js";
import { DEFAULTS, mergeOptions } from "../../src/config.js";

const RATE = 16000;
const FRAME = 512; // 32 ms @ 16 kHz
const FRAME_MS = (FRAME / RATE) * 1000;

/** Speech-like signal: 3 harmonics under a slow envelope (seed varies pitch). */
function speechLike(seed, seconds = 1.5) {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  const f0 = 140 + (seed % 7) * 25;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2.3 * t + seed * 0.7);
    out[i] = env * (
      0.5 * Math.sin(2 * Math.PI * f0 * t)
      + 0.3 * Math.sin(2 * Math.PI * f0 * 2 * t + 1.1)
      + 0.2 * Math.sin(2 * Math.PI * f0 * 3.1 * t + 2.3)
    );
  }
  return out;
}

const GATE_OPTS = { windowSamples: Math.ceil((DEFAULTS.echoGate.windowMs / 1000) * RATE), maxDelaySamples: Math.ceil((DEFAULTS.echoGate.maxDelayMs / 1000) * RATE), decimation: DEFAULTS.echoGate.decimation, lagStride: DEFAULTS.echoGate.lagStride };

// ------------------------------------------------------------- 1. pure copy

test("echoCorrelation: delayed + attenuated copy → corr ≥ 0.9 at the true delay", () => {
  const ref = speechLike(1, 1.5);
  for (const delay of [0, 1600, 4000, 6400]) { // 0 / 100 / 250 / 400 ms
    for (const gain of [0.3, 0.6, 1.0]) {
      const end = ref.length;
      const frame = ref.slice(end - FRAME - delay, end - delay).map(v => v * gain);
      const { corr, delaySamples } = echoCorrelation(frame, ref, GATE_OPTS);
      assert.ok(corr >= 0.9, `delay=${delay} gain=${gain}: corr=${corr.toFixed(3)}`);
      assert.ok(Math.abs(delaySamples - delay) <= GATE_OPTS.lagStride, `delay found ≈ true (${delaySamples} vs ${delay})`);
    }
  }
});

test("echoCorrelation: uncorrelated speech-like noise → corr < 0.3", () => {
  const ref = speechLike(1, 1.5);
  const other = speechLike(6, 1.5); // different f0 + envelope phase
  const frame = other.slice(other.length - FRAME);
  const { corr } = echoCorrelation(frame, ref, GATE_OPTS);
  assert.ok(corr < 0.3, `uncorrelated corr=${corr.toFixed(3)}`);
});

test("echoCorrelation: reverb tail (2 sparse reflections) → still ≥ threshold", () => {
  const ref = speechLike(2, 1.5);
  const end = ref.length;
  const d1 = 3200, d2 = 6400; // 200 ms + 400 ms reflections
  const w1 = ref.slice(end - FRAME - d1, end - d1);
  const w2 = ref.slice(end - FRAME - d2, end - d2);
  const frame = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) frame[i] = 0.7 * w1[i] + 0.3 * w2[i];
  const { corr } = echoCorrelation(frame, ref, GATE_OPTS);
  assert.ok(corr >= DEFAULTS.echoGate.correlationThreshold, `reverb corr=${corr.toFixed(3)}`);
});

// --------------------------------------------------- 4. detector integration

function frameOf(samples, probability, rms) {
  return { probability, frame: samples, rms: rms ?? 0.2, durationMs: FRAME_MS };
}

function echoFrameFrom(ref, end, delay, gain = 0.5) {
  const f = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) f[i] = ref[end - FRAME - delay + i] * gain;
  return f;
}

test("detector: armed + echo frames (high rms, high probability) → no interrupt accumulation", () => {
  const det = new TurnDetector({ echoGate: { enabled: true } });
  const ref = speechLike(1, 1.5);
  det.pushEchoReference(ref);
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  const end = ref.length;
  for (let k = 0; k < 12; k++) {
    // each frame is a delayed copy of the reference (delay 3200), high rms
    det.onFrame(frameOf(echoFrameFrom(ref, end - k * FRAME, 3200), 0.95, 0.4));
  }
  assert.equal(det.interruptConfirm, 0, "echo frames must not accumulate");
  assert.equal(interrupts, 0);
});

test("detector: armed + uncorrelated user-speech frames → still confirm (positive control)", () => {
  const det = new TurnDetector({ echoGate: { enabled: true } });
  const ref = speechLike(1, 1.5);
  det.pushEchoReference(ref);
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  const other = speechLike(6, 1.5);
  for (let k = 0; k < 10; k++) {
    const f = other.slice(other.length - FRAME - k * FRAME, other.length - k * FRAME);
    det.onFrame(frameOf(f, 0.95, 0.4));
  }
  assert.ok(det.interruptConfirm > 0, "user-speech frames accumulate");
  assert.equal(interrupts, 1, "barge-in fired");
});

test("detector: un-probed frames inherit the last verdict (cadence 4)", () => {
  const det = new TurnDetector({ echoGate: { enabled: true } });
  const ref = speechLike(1, 1.5);
  det.pushEchoReference(ref);
  det.setAgentSpeaking(true);
  const other = speechLike(6, 1.5);
  const end = ref.length;
  // frame 1: probe → echo verdict TRUE (inherited by frames 2–4)
  det.onFrame(frameOf(echoFrameFrom(ref, end, 3200), 0.95, 0.4));
  for (let k = 0; k < 3; k++) det.onFrame(frameOf(echoFrameFrom(ref, end, 3200), 0.95, 0.4));
  assert.equal(det.interruptConfirm, 0, "inherited echo verdict blocks accumulation");
  // frame 5: probe → uncorrelated → verdict FALSE (inherited by 6–8)
  for (let k = 0; k < 4; k++) {
    det.onFrame(frameOf(other.slice(other.length - FRAME - k * FRAME, other.length - k * FRAME), 0.95, 0.4));
  }
  assert.equal(det.interruptConfirm, 4, "inherited not-echo verdict lets speech accumulate");
});

test("detector: gate off → echo frames behave exactly like today (regression)", () => {
  const det = new TurnDetector({}); // echoGate default: enabled false
  const ref = speechLike(1, 1.5);
  det.pushEchoReference(ref); // reference present but gate off
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  const end = ref.length;
  for (let k = 0; k < 10; k++) det.onFrame(frameOf(echoFrameFrom(ref, end - k * FRAME, 3200), 0.95, 0.4));
  assert.equal(interrupts, 1, "gate off → echo frames accumulate → interrupt (WP5 behavior)");
});

test("detector: gate on but NO reference fed → no claim, behaves like today", () => {
  const det = new TurnDetector({ echoGate: { enabled: true } });
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  const other = speechLike(3, 0.5);
  for (let k = 0; k < 10; k++) det.onFrame(frameOf(other.slice(other.length - FRAME - k * FRAME, other.length - k * FRAME), 0.95, 0.4));
  assert.equal(interrupts, 1, "no reference → gate never claims → normal behavior");
});

test("detector: suppressOnset phase 2 rejects echo in READY (opt-in)", () => {
  const on = new TurnDetector({ echoGate: { enabled: true, suppressOnset: true } });
  const ref = speechLike(1, 1.5);
  on.pushEchoReference(ref);
  const end = ref.length;
  for (let k = 0; k < 12; k++) on.onFrame(frameOf(echoFrameFrom(ref, end - k * FRAME, 3200), 0.95, 0.4));
  assert.equal(on.state, "ready", "echo must not start a turn with suppressOnset");

  const off = new TurnDetector({ echoGate: { enabled: true } }); // suppressOnset default false
  off.pushEchoReference(speechLike(1, 1.5));
  const end2 = speechLike(1, 1.5).length;
  for (let k = 0; k < 12; k++) off.onFrame(frameOf(echoFrameFrom(speechLike(1, 1.5), end2 - k * FRAME, 3200), 0.95, 0.4));
  assert.equal(off.state, "listening", "without suppressOnset, un-armed echo CAN start a turn (D9 default)");
});

test("options: partial echoGate merges over DEFAULTS (deep)", () => {
  const merged = mergeOptions({ echoGate: { enabled: true, correlationThreshold: 0.5 } }, DEFAULTS);
  assert.equal(merged.echoGate.enabled, true);
  assert.equal(merged.echoGate.correlationThreshold, 0.5);
  assert.equal(merged.echoGate.maxDelayMs, 500, "untouched default kept");
  assert.equal(merged.echoGate.probeEveryFrames, 4, "untouched default kept");
  const detector = new TurnDetector({ echoGate: { enabled: true } });
  assert.equal(detector.echoGate.enabled, true);
  assert.equal(detector.echoGate.correlationThreshold, 0.75);
  assert.equal(detector.echoGate.lagStride, 16);
});

// ------------------------------------------------------- 5. budget probe 3.4

test("budget probe: detector.onFrame with the gate enabled stays p95 < 8 ms", () => {
  const det = new TurnDetector({ echoGate: { enabled: true } });
  const ref = speechLike(1, 3);
  det.pushEchoReference(ref);
  det.setAgentSpeaking(true);
  const other = speechLike(6, 3);
  const times = [];
  const end = ref.length;
  const endO = other.length;
  for (let k = 0; k < 2000; k++) {
    // alternate echo / speech frames — realistic mixed stream
    const f = k % 2 === 0
      ? echoFrameFrom(ref, end - (k % 100) * FRAME, 3200)
      : other.slice(endO - FRAME - (k % 100) * FRAME, endO - (k % 100) * FRAME);
    const t0 = process.hrtime.bigint();
    det.onFrame(frameOf(f, 0.95, 0.4));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const max = times[times.length - 1];
  // probe frames (every 4th) carry the correlation cost — p95 includes them
  assert.ok(p95 < 8, `p95=${p95.toFixed(3)} ms must stay under 8 ms (p50=${p50.toFixed(3)}, max=${max.toFixed(3)})`);
});
