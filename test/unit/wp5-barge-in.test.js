/**
 * WP5 — barge-in gating tests: no-AEC stricter confirm, rms-vs-baseline gate,
 * interrupt latency measurement (t_voice → t_event). Frames: 512 @ 16 kHz = 32 ms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector } from "../../src/turn/turn-detector.js";

const SAMPLES = 512;
const SAMPLE_RATE = 16000;
const SPEECH = 0.95, SILENCE = 0.01;

/** frame(prob, rms) — rms is the second knob under test here. */
function frame(prob, rms = 0.01) {
  const audio = new Float32Array(SAMPLES).fill(prob >= 0.6 ? 0.1 : 0.001);
  return { probability: prob, frame: audio, rms, durationMs: (SAMPLES / SAMPLE_RATE) * 1000 };
}

function makeDetector(thresholds, events, { noAecMode = false } = {}) {
  const d = new TurnDetector({ thresholds, sampleRate: SAMPLE_RATE });
  d.noAecMode = noAecMode;
  d.onSpeechStart = () => events.speechStarts++;
  d.onTurnEnd = (e) => events.turnEnds.push(e);
  d.onInterrupt = (i) => events.interrupts.push(i);
  return d;
}

test("t14: noAecMode needs ~300 ms of confirm (10 frames), not 6", () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector({ bargeInConfirmFrames: 6, noAecBargeInConfirmMs: 300 }, ev, { noAecMode: true });
  d.setAgentSpeaking(true);
  // frames carry healthy rms (0.05) → the rms gate passes; only the window is stricter
  for (let i = 0; i < 9; i++) d.onFrame(frame(SPEECH, 0.05));
  assert.equal(ev.interrupts.length, 0, "9 frames × 32 ms = 288 ms < 300 ms → no interrupt yet");
  d.onFrame(frame(SPEECH, 0.05)); // 10th frame → 320 ms ≥ 300
  assert.equal(ev.interrupts.length, 1, "stricter confirm fires at ≈300 ms");
  assert.equal(ev.speechStarts, 0);
});

test("t15: noAecMode rms gate — TTS-leakage-level rms never confirms an interrupt", () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector({ bargeInConfirmFrames: 6, noAecBargeInConfirmMs: 300, noAecRmsFactor: 2 }, ev, { noAecMode: true });
  d.setAgentSpeaking(true);
  // Establish the agent-playback baseline: 31 frames (≈1 s) of low-rms audio
  for (let i = 0; i < 31; i++) d.onFrame(frame(SILENCE, 0.01));
  // Leakage frames: speech-level PROBABILITY but rms only 1.5× the baseline
  for (let i = 0; i < 40; i++) d.onFrame(frame(SPEECH, 0.015));
  assert.equal(ev.interrupts.length, 0, "rms ≤ 2× baseline must never confirm (TTS leakage suppressed)");
  // A real voice: rms 5× baseline → confirm accumulates → interrupt
  for (let i = 0; i < 10; i++) d.onFrame(frame(SPEECH, 0.05));
  assert.equal(ev.interrupts.length, 1, "rms above the gate confirms normally");
});

test("t15b: rms gate is OFF in AEC mode — probability alone confirms", () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector({ bargeInConfirmFrames: 6 }, ev, { noAecMode: false });
  d.setAgentSpeaking(true);
  for (let i = 0; i < 31; i++) d.onFrame(frame(SILENCE, 0.01));
  for (let i = 0; i < 6; i++) d.onFrame(frame(SPEECH, 0.015)); // low rms but AEC mode
  assert.equal(ev.interrupts.length, 1, "no rms gate with AEC active");
});

test("t16: InterruptInfo.latencyMs measures t_voice → t_event", () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector({ bargeInConfirmFrames: 6 }, ev, { noAecMode: false });
  d.setAgentSpeaking(true);
  for (let i = 0; i < 31; i++) d.onFrame(frame(SILENCE, 0.01)); // baseline only
  for (let i = 0; i < 6; i++) d.onFrame(frame(SPEECH, 0.05));
  assert.equal(ev.interrupts.length, 1);
  const info = ev.interrupts[0];
  // t_voice = start of the first above-onset frame; t_event = end of the 6th
  // → 6 × 32 = 192 ms (the plan's formula: confirm frames × frameMs)
  assert.equal(info.latencyMs, 6 * 32);
  assert.ok(info.atMs > 0);
});

test("t16b: confirm dip resets the latency origin (staccato speech)", () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector({ bargeInConfirmFrames: 4 }, ev, { noAecMode: false });
  d.setAgentSpeaking(true);
  for (let i = 0; i < 31; i++) d.onFrame(frame(SILENCE, 0.01));
  // 3 speech, 3 silence (confirm counts down 3→0 → new t_voice), 4 speech → fires
  for (let i = 0; i < 3; i++) d.onFrame(frame(SPEECH, 0.05));
  for (let i = 0; i < 3; i++) d.onFrame(frame(SILENCE, 0.01));
  for (let i = 0; i < 4; i++) d.onFrame(frame(SPEECH, 0.05));
  assert.equal(ev.interrupts.length, 1);
  // latency counts from the NEW voice onset (after the reset): 4 frames × 32 = 128
  assert.equal(ev.interrupts[0].latencyMs, 4 * 32);
});
