/**
 * WP4 — endpointing refinement tests:
 * adaptive redemption (`redemptionFor`, ≥ 5 branch cases) and the PAUSE
 * sub-state transitions (≥ 3 cases). Frames: 512 samples @ 16 kHz = 32 ms.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector, redemptionFor } from "../../src/turn/turn-detector.js";

const SAMPLES = 512;
const SAMPLE_RATE = 16000;
const SPEECH = 0.95, SILENCE = 0.01, MID = 0.5;

function frame(prob) {
  const audio = new Float32Array(SAMPLES).fill(prob >= 0.6 ? 0.1 : 0.001);
  return { probability: prob, frame: audio, rms: 0.01, durationMs: (SAMPLES / SAMPLE_RATE) * 1000 };
}

function collect() {
  return { speechStarts: 0, turnEnds: [], interrupts: [] };
}

function makeDetector(thresholds, events) {
  const d = new TurnDetector({ thresholds, sampleRate: SAMPLE_RATE });
  d.onSpeechStart = () => events.speechStarts++;
  d.onTurnEnd = (e) => events.turnEnds.push(e);
  d.onInterrupt = (i) => events.interrupts.push(i);
  return d;
}

const feed = (d, prob, n) => { for (let i = 0; i < n; i++) d.onFrame(frame(prob)); };

// ---------------------------------------------------------------------------
// redemptionFor — pure-function branches + clamping
// ---------------------------------------------------------------------------

test("r01: default base for a mid-length turn without pauses", () => {
  // speechMs 1000 (≥ 600, < 2000), no pauses → plain base
  assert.equal(redemptionFor({ speechMs: 1000, interiorPauses: 0, longestPauseMs: 0 }), 650);
});

test("r02: fluent long turn without pauses → snappy (base − 200)", () => {
  assert.equal(redemptionFor({ speechMs: 2500, interiorPauses: 0, longestPauseMs: 0 }), 450);
});

test("r03: hesitant turns (≥ 2 interior pauses OR short speech) → patient (base + 200)", () => {
  assert.equal(redemptionFor({ speechMs: 1000, interiorPauses: 2, longestPauseMs: 300 }), 850);
  assert.equal(redemptionFor({ speechMs: 500, interiorPauses: 0, longestPauseMs: 0 }), 850);
});

test("r04: user pauses a lot (longestPauseMs ≥ 800) → at least base + 250", () => {
  assert.equal(redemptionFor({ speechMs: 1000, interiorPauses: 1, longestPauseMs: 900 }), 900);
  // fluent-but-paused: fluent branch needs 0 pauses → not fluent; still ≥ 900
  assert.equal(redemptionFor({ speechMs: 2500, interiorPauses: 1, longestPauseMs: 1000 }), 900);
});

test("r05: branch precedence — hesitant + long-pause → max wins", () => {
  // hesitant (850) then long-pause → max(850, 900) = 900
  assert.equal(redemptionFor({ speechMs: 500, interiorPauses: 2, longestPauseMs: 1000 }), 900);
});

test("r06: clamped to [350, 1200] — custom base", () => {
  // fluent with a tiny base → 0 → clamped up to 350
  assert.equal(redemptionFor({ speechMs: 2500, interiorPauses: 0, longestPauseMs: 0 }, 200), 350);
  // hesitant with a huge base → clamped down to 1200
  assert.equal(redemptionFor({ speechMs: 100, interiorPauses: 0, longestPauseMs: 0 }, 3000), 1200);
});

// ---------------------------------------------------------------------------
// PAUSE sub-state transitions
// ---------------------------------------------------------------------------

test("p01: interior pause of ~350 ms mid-utterance → turn continues", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 650, minSpeechMs: 0 }, ev);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 11); // 352 ms → enters PAUSE (256 ms), stays
  assert.equal(d.state, "pause", "silence ≥ shortPauseMs opens the PAUSE sub-state");
  feed(d, SPEECH, 5);   // speech resumes → turn continues
  assert.equal(d.state, "listening");
  assert.equal(ev.turnEnds.length, 0, "interior pause must not end the turn");
  feed(d, SILENCE, 30); // adaptive 850 (speechMs 320 < 600) crossed at frame 27
  assert.equal(ev.turnEnds.length, 1, "exactly one turn end for the whole utterance");
  assert.equal(ev.turnEnds[0].stats.interiorPauses, 1, "rhythm stats ride on the event");
  assert.equal(ev.turnEnds[0].stats.longestPauseMs, 352);
  assert.equal(ev.turnEnds[0].stats.speechMs, 320);
  // audio: 2 confirm (pad) + 8 speech + 11+27 silence (the 3 frames after the
  // turn end belong to the next cycle, not to this turn's audio)
  assert.equal(ev.turnEnds[0].audio.length, (2 + 8 + 38) * SAMPLES);
});

test("p02: pause ≥ redemption → turn ends from PAUSE", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 650, minSpeechMs: 0 }, ev);
  feed(d, SPEECH, 20); // 640 ms speech → base redemption 650 applies
  feed(d, SILENCE, 25); // crosses 650 at frame 21
  assert.equal(ev.turnEnds.length, 1);
  assert.equal(d.state, "ready");
  assert.equal(d.interiorPauses, 0, "the trailing (turn-ending) pause is not an interior pause");
});

test("p03: speech return from PAUSE resets silence and counts the pause", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 650, minSpeechMs: 0 }, ev);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 11); // pause
  const silenceAtPause = d.silenceMs;
  feed(d, SPEECH, 3);
  assert.equal(d.state, "listening");
  assert.equal(d.silenceMs, 0, "speech return resets silence");
  assert.equal(d.interiorPauses, 1);
  assert.equal(d.longestPauseMs, silenceAtPause);
});

test("p04: adaptive window in action — hesitant turn waits 850 ms, not 650", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 650, minSpeechMs: 0 }, ev);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 11); // interior pause 1
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 11); // interior pause 2 → hesitant (≥ 2 pauses)
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 21); // 672 ms — a static 650 window would end here
  assert.equal(ev.turnEnds.length, 0, "adaptive 850 window must still hold");
  feed(d, SILENCE, 6);  // total 864 ms ≥ 850
  assert.equal(ev.turnEnds.length, 1, "turn ends once the adaptive window is crossed");
  // audio: 2 confirm (pad) + 13 speech + all 49 silence frames (11+11+27)
  assert.equal(ev.turnEnds[0].audio.length, (2 + 13 + 49) * SAMPLES);
  assert.equal(ev.turnEnds[0].stats.interiorPauses, 2);
});

test("p05: mid-zone frames inside PAUSE neither resume speech nor reset silence", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 650, minSpeechMs: 0 }, ev);
  feed(d, SPEECH, 5);
  feed(d, SILENCE, 11); // in PAUSE
  feed(d, MID, 6);      // hovering probabilities
  assert.equal(d.state, "pause", "mid frames keep the PAUSE (hysteresis)");
  assert.ok(d.silenceMs >= 352, "mid frames do not reset the silence accumulation");
  feed(d, SILENCE, 20);
  assert.equal(ev.turnEnds.length, 1);
});
