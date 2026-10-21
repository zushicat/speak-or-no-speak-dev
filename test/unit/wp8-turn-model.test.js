/**
 * WP8 — TurnModel integration tests (mocked models, deterministic sequences).
 * Frames: 512 @ 16 kHz = 32 ms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector } from "../../src/turn/turn-detector.js";

const SAMPLES = 512;
const SAMPLE_RATE = 16000;
const SPEECH = 0.95, SILENCE = 0.01;

function frame(prob) {
  const audio = new Float32Array(SAMPLES).fill(prob >= 0.6 ? 0.1 : 0.001);
  return { probability: prob, frame: audio, rms: 0.01, durationMs: (SAMPLES / SAMPLE_RATE) * 1000 };
}

function makeDetector(thresholds, events, model) {
  const d = new TurnDetector({ thresholds, sampleRate: SAMPLE_RATE, turnModel: model });
  d.onSpeechStart = () => events.speechStarts++;
  d.onTurnEnd = (e) => events.turnEnds.push(e);
  d.onInterrupt = (i) => events.interrupts.push(i);
  return d;
}
const feed = (d, prob, n) => { for (let i = 0; i < n; i++) d.onFrame(frame(prob)); };

const T = { onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 320, minSpeechMs: 0, graceAfterInterruptMs: 0, modelTimeoutMs: 300 };

test("m01: model says complete → turn end fires at redemption, model got the full turn audio", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const seenAudio = [];
  const model = { predictComplete: async (audio) => { seenAudio.push(audio); return true; } };
  const d = makeDetector(T, ev, model);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17); // 352 ms ≥ 320 → model evaluation
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 1, "model complete → turn end emitted");
  assert.equal(seenAudio.length, 1);
  // the model received the whole turn: 2 confirm (pad) + 3 speech + 11 silence
  assert.equal(seenAudio[0].length, (2 + 3 + 17) * SAMPLES);
  assert.equal(d.state, "ready");
});

test("m02: model says incomplete → no turn end; later speech merges; eventual end carries all", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  let verdict = false;
  const model = { predictComplete: async () => verdict };
  const d = makeDetector(T, ev, model);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17); // redemption → model incomplete → turn continues
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 0, "incomplete → no turn end");
  assert.ok(["listening", "pause"].includes(d.state), "the turn stays open (sub-state may be pause)");
  feed(d, SPEECH, 5);   // the user continues
  feed(d, SILENCE, 17);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 0, "still incomplete");
  verdict = true;       // the model flips
  feed(d, SILENCE, 17); // next redemption window → complete
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 1, "complete on the later evaluation");
  // the turn audio spans EVERYTHING (both speech bursts + all silences):
  assert.equal(ev.turnEnds[0].audio.length, (2 + 3 + 17 + 5 + 17 + 17) * SAMPLES);
});

test("m03: new speech during a pending evaluation cancels it (no stale emit)", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const resolvers = [];
  const model = { predictComplete: () => new Promise(r => resolvers.push(r)) };
  const d = makeDetector(T, ev, model);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17); // redemption → evaluation #1 pending
  assert.equal(d._evalPending, true, "evaluation pending");
  feed(d, SPEECH, 3);   // new speech arrives → must cancel
  assert.equal(d._evalPending, false, "evaluation cancelled by new speech");
  resolvers[0](true);   // the stale resolution must be DROPPED
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 0, "stale evaluation must not emit");
  feed(d, SILENCE, 17); // next redemption → a NEW evaluation runs on the extended turn
  assert.equal(resolvers.length, 2, "re-evaluated after the new speech");
  resolvers[1](true);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 1, "re-evaluated turn ends");
  assert.equal(ev.turnEnds[0].audio.length, (2 + 3 + 17 + 3 + 17) * SAMPLES, "audio includes the new speech");
});

test("m04: model slower than modelTimeoutMs → fail-open turn end", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const model = { predictComplete: () => new Promise(() => {}) }; // never resolves
  const d = makeDetector({ ...T, modelTimeoutMs: 50 }, ev, model);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17);
  await new Promise(r => setTimeout(r, 120));
  assert.equal(ev.turnEnds.length, 1, "timeout → fail-open turn end");
  assert.equal(d.state, "ready");
});

test("m05: model rejects → fail-open turn end", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const model = { predictComplete: async () => { throw new Error("boom"); } };
  const d = makeDetector(T, ev, model);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ev.turnEnds.length, 1, "model error → turn end emits");
});

test("m06: maxTurnMs truncation bypasses the model", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  let calls = 0;
  const model = { predictComplete: async () => { calls++; return false; } };
  const d = makeDetector({ ...T, maxTurnMs: 1000 }, ev, model);
  feed(d, SPEECH, 40); // 1280 ms > 1000 → truncated force-end
  assert.equal(ev.turnEnds.length, 1);
  assert.equal(ev.turnEnds[0].truncated, true);
  assert.equal(calls, 0, "the model must not be consulted on truncation");
});

test("m07: no turnModel → identical to v1 behavior (regression)", async () => {
  const ev = { speechStarts: 0, turnEnds: [], interrupts: [] };
  const d = makeDetector(T, ev, null);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 17);
  assert.equal(ev.turnEnds.length, 1, "direct emit without a model (sync)");
});
