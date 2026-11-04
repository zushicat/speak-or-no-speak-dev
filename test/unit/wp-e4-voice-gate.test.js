/**
 * WP-E4 — agent-voice-profile gate: pure decision helpers, fbank features
 * (shape + CMVN), options merge, facade wiring (drop / pass / fail-open) with
 * an injected mock gate, and the feature-cost measurement.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, isAgentVoice, AgentVoiceGate } from "../../src/gate/agent-voice-gate.js";
import { kaldiFbank } from "../../src/gate/kaldi-fbank.js";
import { DEFAULTS, mergeOptions } from "../../src/config.js";
import { createSpeakOrNoSpeak } from "../../src/speak-or-no-speak.js";
import { TurnDetector } from "../../src/turn/turn-detector.js";

const RATE = 16000, FRAME = 512, FRAME_MS = 32;

test("cosineSimilarity: parallel/orthogonal/opposite", () => {
  assert.equal(cosineSimilarity([1, 0], [2, 0]), 1, "parallel → 1");
  assert.equal(cosineSimilarity([1, 0], [0, 3]), 0, "orthogonal → 0");
  assert.equal(cosineSimilarity([1, 0], [-5, 0]), -1, "opposite → -1");
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 1]) - 1) < 1e-12);
});

test("isAgentVoice: threshold semantics (higher = fewer drops = safer)", () => {
  assert.equal(isAgentVoice(0.95, 0.8), true, "clear agent voice → drop");
  assert.equal(isAgentVoice(0.4, 0.8), false, "different voice → keep");
  assert.equal(isAgentVoice(0.8, 0.8), true, "at threshold → drop");
});

test("kaldiFbank: shape, CMVN normalization, signal sensitivity", () => {
  // a speech-like sine burst
  const n = RATE; // 1 s
  const pcm = new Float32Array(n);
  for (let i = 0; i < n; i++) pcm[i] = 0.5 * Math.sin(2 * Math.PI * 220 * (i / RATE));
  const raw = kaldiFbank(pcm, RATE);
  assert.equal(raw.numBins, 80);
  assert.equal(raw.numFrames, Math.floor((n - 400) / 160) + 1);
  assert.equal(raw.feats.length, raw.numFrames * 80);
  assert.ok([...raw.feats].every(Number.isFinite), "no NaN/Inf");
  assert.ok(Math.max(...raw.feats) > -14, "signal bins above the silence floor");

  const cmvn = kaldiFbank(pcm, RATE, { cmvn: true });
  assert.ok([...cmvn.feats].every(Number.isFinite));
  // per-bin normalization: bins WITH variance get mean ≈ 0 / std ≈ 1; a
  // constant bin (no energy in its range) correctly collapses to zeros.
  let bestBin = 0, bestVar = -1;
  for (let b = 0; b < 80; b++) {
    let m = 0;
    for (let t = 0; t < cmvn.numFrames; t++) m += cmvn.feats[t * 80 + b];
    m /= cmvn.numFrames;
    let v = 0;
    for (let t = 0; t < cmvn.numFrames; t++) { const d = cmvn.feats[t * 80 + b] - m; v += d * d; }
    if (v > bestVar) { bestVar = v; bestBin = b; }
  }
  let m = 0;
  for (let t = 0; t < cmvn.numFrames; t++) m += cmvn.feats[t * 80 + bestBin];
  m /= cmvn.numFrames;
  assert.ok(Math.abs(m) < 1e-6, `bin ${bestBin} mean ≈ 0 (got ${m})`);
  let v = 0;
  for (let t = 0; t < cmvn.numFrames; t++) { const d = cmvn.feats[t * 80 + bestBin] - m; v += d * d; }
  v = Math.sqrt(v / cmvn.numFrames);
  assert.ok(Math.abs(v - 1) < 1e-6, `bin ${bestBin} std ≈ 1 (got ${v})`);
});

test("fbank cost: 6.7 s of audio stays well under the turn-end budget", () => {
  const pcm = new Float32Array(Math.round(6.7 * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.3 * Math.sin(2 * Math.PI * 180 * (i / RATE)) * (0.5 + 0.5 * Math.sin(i / 900));
  const t0 = process.hrtime.bigint();
  kaldiFbank(pcm, RATE, { cmvn: true });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 1000, `fbank ${ms.toFixed(1)} ms for 6.7 s audio (turn-end path, not frame path)`);
});

test("options: partial voiceGate merges over DEFAULTS (deep)", () => {
  const merged = mergeOptions({ voiceGate: { enabled: true, threshold: 0.9 } }, DEFAULTS);
  assert.equal(merged.voiceGate.enabled, true);
  assert.equal(merged.voiceGate.threshold, 0.9);
  assert.equal(merged.voiceGate.profileUrl, DEFAULTS.voiceGate.profileUrl, "untouched default kept");
  assert.equal(DEFAULTS.voiceGate.enabled, false, "ships default-off (D9)");
});

// ------------------------------------------ facade wiring (mock gate, Node)

class MockEngine {
  constructor() {
    this.frameCbs = []; this.errCbs = [];
    this.startedCount = 0; this.stoppedCount = 0;
    this.aecScope = "all"; this.aecDegraded = false;
  }
  async start() { this.startedCount++; }
  stop() { this.stoppedCount++; }
  pause() {} resume() {}
  onFrame(cb) { this.frameCbs.push(cb); }
  onError(cb) { this.errCbs.push(cb); }
  emit(prob) {
    const f = {
      probability: prob,
      frame: new Float32Array(FRAME).fill(prob >= 0.6 ? 0.1 : 0.001),
      rms: prob >= 0.6 ? 0.05 : 0.001,
      durationMs: FRAME_MS,
    };
    this.frameCbs.forEach((cb) => cb(f));
  }
}

/** Produce one turn end from the mock engine (2 speech + 11 silence frames). */
function makeTurn(engine) {
  engine.emit(0.95); engine.emit(0.95);
  for (let i = 0; i < 11; i++) engine.emit(0.01);
}

/** Wait until pred() holds (bounded), for the async gate chain to settle. */
async function waitFor(pred, ms = 500) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("facade voiceGate: agent-similar turns are dropped, user turns delivered", async () => {
  const mock = {
    scoreTurn: async () => {
      mock.scored++;
      if (mock.scored === 1) return { similarity: 0.93, isAgent: true }; // first turn: agent-like
      return { similarity: 0.3, isAgent: false };
    },
    scored: 0, dropped: 0,
  };
  const engine = new MockEngine();
  const seen = [];
  const sons = await createSpeakOrNoSpeak({
    engine,
    thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64, graceAfterInterruptMs: 0 },
    voiceGate: { enabled: true, gate: mock },
    onTurnEnd: (e) => seen.push(e),
  });
  await sons.start();
  makeTurn(engine); // agent-like → dropped
  makeTurn(engine); // user → delivered
  await waitFor(() => seen.length >= 1);
  assert.equal(seen.length, 1, "agent-similar turn dropped, user turn delivered");
  assert.equal(mock.scored, 2);
  assert.equal(sons._voiceGate, mock, "injected gate exposed for tests");
  await sons.stop();
});

test("facade voiceGate: fail-open — a gate error emits the turn + one-time warning", async () => {
  let calls = 0;
  const mock = { scoreTurn: async () => { calls++; throw new Error("model exploded"); } };
  const engine = new MockEngine();
  const errors = [];
  const seen = [];
  const sons = await createSpeakOrNoSpeak({
    engine,
    thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64, graceAfterInterruptMs: 0 },
    voiceGate: { enabled: true, gate: mock },
    onTurnEnd: (e) => seen.push(e),
    onError: (e) => errors.push(e),
  });
  await sons.start();
  makeTurn(engine);
  makeTurn(engine);
  await waitFor(() => seen.length >= 2);
  assert.equal(seen.length, 2, "both turns delivered despite gate errors");
  assert.equal(errors.length, 1, "one-time warning");
  assert.match(errors[0].message, /Voice gate failed/);
  await sons.stop();
});

test("facade: voiceGate disabled (default) → turn ends pass straight through", async () => {
  const engine = new MockEngine();
  const seen = [];
  const sons = await createSpeakOrNoSpeak({ engine, thresholds: { onsetConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 }, onTurnEnd: (e) => seen.push(e) });
  await sons.start();
  makeTurn(engine);
  await waitFor(() => seen.length >= 1);
  assert.equal(seen.length, 1, "no gate → immediate delivery");
  assert.equal(sons._voiceGate, null);
  await sons.stop();
});

test("Node import of the gate module is clean; the browser gate fails loudly without ORT", async () => {
  const gate = new AgentVoiceGate({ profile: { embedding: new Array(256).fill(0.01), sampleRate: 16000 } });
  await assert.rejects(
    () => gate.scoreTurn(new Float32Array(RATE)),
    (err) => /ORT runtime unavailable/.test(err.message)
  );
});

// -------------------------------------- detector frame-level hook (4.4)

test("detector setVoiceGate: agent-similar frames do not accumulate; verdict flips live", () => {
  const det = new TurnDetector({ thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 } });
  let verdict = true; // the gate's "latest window verdict"
  det.setVoiceGate({ isAgentVoice: () => verdict });
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  const frame = () => ({ probability: 0.95, frame: new Float32Array(FRAME).fill(0.1), rms: 0.05, durationMs: FRAME_MS });
  for (let i = 0; i < 6; i++) det.onFrame(frame()); // verdict true → no accumulation
  assert.equal(det.interruptConfirm, 0, "agent-similar frames blocked");
  verdict = false; // the window flips (async scoring updated it)
  for (let i = 0; i < 6; i++) det.onFrame(frame()); // now speech accumulates
  // confirmNeed = 2 → interrupts at frames 2/4/6 (continuous speech re-fires
  // after each confirm reset — the measured E0-storm re-fire pattern)
  assert.equal(interrupts, 3, "barge-in fires when the verdict is not-agent");
});

test("facade wires the frame-level hook: gate fed + consulted while armed", async () => {
  const mock = {
    scored: 0, dropped: 0, fed: 0, lastActive: null,
    scoreTurn: async () => ({ similarity: 0.5, isAgent: false }),
    feed: (frame, active) => { mock.fed++; mock.lastActive = active; },
    isAgentVoiceSync: () => false,
    resetWindow() {},
  };
  const engine = new MockEngine();
  const sons = await createSpeakOrNoSpeak({
    engine,
    thresholds: { onsetConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 },
    voiceGate: { enabled: true, gate: mock },
  });
  await sons.start();
  sons.setAgentSpeaking(true); // the frame hook is consulted while armed
  engine.emit(0.95);
  assert.ok(mock.fed >= 1, "frames feed the gate's rolling window");
  assert.equal(mock.lastActive, true, "scoring active while armed");
  await sons.stop();
});
