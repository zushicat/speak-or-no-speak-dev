/**
 * WP3 unit tests t01–t12 — synthetic VadFrame sequences into a bare
 * `TurnDetector` (pure, no browser). Zero test deps (D1, `node --test`).
 *
 * Frame reality (WP1 D-WP1-1): Silero v5 → 512 samples @ 16 kHz = 32 ms/frame.
 * The plan's t01–t03 frame numbers were calibrated for 96 ms frames; wall-clock
 * windows are preserved (confirm 3×96 ms ≡ 9×32 ms etc.). Tests set explicit
 * thresholds so they document the machine, not the defaults.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector } from "../../src/turn/turn-detector.js";
import { mergeOptions } from "../../src/config.js";

const SAMPLE_RATE = 16000;
const SAMPLES = 512; // 32 ms per frame at 16 kHz

/** Build a synthetic VadFrame. */
function frame(prob) {
  const audio = new Float32Array(SAMPLES).fill(prob >= 0.6 ? 0.1 : 0.001);
  return {
    probability: prob,
    frame: audio,
    rms: prob >= 0.6 ? 0.05 : 0.001,
    durationMs: (SAMPLES / SAMPLE_RATE) * 1000, // 32
  };
}

/** Collect emitted events. */
function collect() {
  const events = { speechStarts: 0, turnEnds: [], interrupts: [] };
  return events;
}

function makeDetector(thresholds, events) {
  const d = new TurnDetector({ thresholds, sampleRate: SAMPLE_RATE });
  d.onSpeechStart = () => events.speechStarts++;
  d.onTurnEnd = (e) => events.turnEnds.push(e);
  d.onInterrupt = (i) => events.interrupts.push(i);
  return d;
}

const SPEECH = 0.95, SILENCE = 0.01, MID = 0.5;

test("t01: 2 noisy frames then silence → no onSpeechStart (confirm needs 3)", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 3 }, ev);
  d.onFrame(frame(SPEECH));
  d.onFrame(frame(SPEECH));
  for (let i = 0; i < 10; i++) d.onFrame(frame(SILENCE));
  assert.equal(ev.speechStarts, 0);
  assert.equal(ev.turnEnds.length, 0);
  assert.equal(d.state, "ready");
});

test("t02: 3 speech frames (confirm) then redemption → too short → no onTurnEnd", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 3, minSpeechMs: 250, redemptionMs: 650 }, ev);
  for (let i = 0; i < 3; i++) d.onFrame(frame(SPEECH)); // onset confirmed, all in pad
  assert.equal(ev.speechStarts, 1);
  for (let i = 0; i < 30; i++) d.onFrame(frame(SILENCE)); // adaptive 850 (hesitant) crossed at 27
  assert.equal(ev.turnEnds.length, 0, "turn must be discarded: speechMs 96 < minSpeechMs 250");
  assert.equal(d.state, "ready");
});

test("t03: 20 speech frames then long silence → one onTurnEnd with plausible audio", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 3, minSpeechMs: 250, redemptionMs: 650 }, ev);
  for (let i = 0; i < 20; i++) d.onFrame(frame(SPEECH));
  for (let i = 0; i < 25; i++) d.onFrame(frame(SILENCE));
  assert.equal(ev.speechStarts, 1);
  assert.equal(ev.turnEnds.length, 1);
  const e = ev.turnEnds[0];
  // 21st silence frame crosses redemption (21 × 32 = 672 ≥ 650):
  // audio = 3 confirm frames (via pad) + 17 speech + 21 silence = 41 frames
  assert.equal(e.audio.length, (20 + 21) * SAMPLES);
  assert.equal(e.durationMs, (20 + 21) * 32);
  assert.equal(e.truncated, false);
  assert.equal(e.afterInterrupt, false);
  assert.equal(d.state, "ready");
});

test("t04: interior pause of 4 silence frames mid-turn does NOT end the turn", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 3, minSpeechMs: 250, redemptionMs: 650 }, ev);
  for (let i = 0; i < 20; i++) d.onFrame(frame(SPEECH));
  for (let i = 0; i < 4; i++) d.onFrame(frame(SILENCE)); // 128 ms < 650 redemption
  assert.equal(ev.turnEnds.length, 0, "interior pause must not end the turn");
  for (let i = 0; i < 5; i++) d.onFrame(frame(SPEECH));
  for (let i = 0; i < 25; i++) d.onFrame(frame(SILENCE));
  assert.equal(ev.turnEnds.length, 1);
  // audio spans the whole turn incl. the interior pause: 20+4+5 speech + 21 silence
  assert.equal(ev.turnEnds[0].audio.length, (20 + 4 + 5 + 21) * SAMPLES);
});

test("t05: agent flag + speech → exactly one onInterrupt, zero onSpeechStart/onTurnEnd", () => {
  const ev = collect();
  const d = makeDetector({ bargeInConfirmFrames: 2, onsetConfirmFrames: 3 }, ev);
  d.setAgentSpeaking(true);
  for (let i = 0; i < 3; i++) d.onFrame(frame(SPEECH));
  assert.equal(ev.interrupts.length, 1, "one barge-in after 2 confirm frames");
  assert.equal(ev.speechStarts, 0, "interrupt must not emit onSpeechStart (rule 2)");
  assert.equal(ev.turnEnds.length, 0);
  assert.equal(d.state, "listening");
  assert.equal(d.afterInterrupt, true);
});

test("t06: agent flag + long silence/mid → zero events", () => {
  const ev = collect();
  const d = makeDetector({ bargeInConfirmFrames: 2 }, ev);
  d.setAgentSpeaking(true);
  for (let i = 0; i < 30; i++) d.onFrame(frame(SILENCE));
  for (let i = 0; i < 5; i++) d.onFrame(frame(MID));
  assert.equal(ev.interrupts.length, 0);
  assert.equal(ev.speechStarts, 0);
  assert.equal(ev.turnEnds.length, 0);
});

test("t07: interrupt then redemption-eligible silence → turn end only after disarm", () => {
  const ev = collect();
  const d = makeDetector(
    { bargeInConfirmFrames: 2, graceAfterInterruptMs: 500, redemptionMs: 650, minSpeechMs: 0 }, ev
  );
  d.setAgentSpeaking(true);
  for (let i = 0; i < 3; i++) d.onFrame(frame(SPEECH)); // interrupt
  for (let i = 0; i < 45; i++) d.onFrame(frame(SILENCE)); // suppressed turn end (adaptive 850 crossed at 27)
  assert.equal(ev.turnEnds.length, 0, "no turn end while the agent flag is set");
  d.setAgentSpeaking(false);
  assert.equal(ev.turnEnds.length, 1, "redemption-eligible turn flushes on disarm");
  assert.equal(ev.turnEnds[0].afterInterrupt, true);
  assert.equal(ev.speechStarts, 0);
});

test("t08: mid-zone probabilities make no confirm and no silence progress (hysteresis)", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 3, minSpeechMs: 250, redemptionMs: 650 }, ev);
  d.onFrame(frame(SPEECH));
  d.onFrame(frame(SPEECH)); // confirm at 2/3
  for (let i = 0; i < 10; i++) d.onFrame(frame(MID)); // resets confirm each time
  d.onFrame(frame(SPEECH)); // 1/3
  for (let i = 0; i < 30; i++) d.onFrame(frame(SILENCE));
  assert.equal(ev.speechStarts, 0, "mid frames must reset confirm progress");
  assert.equal(ev.turnEnds.length, 0);

  // listening-side hysteresis: mid frames neither silence-accumulate nor end turns
  const ev2 = collect();
  const d2 = makeDetector({ onsetConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 650 }, ev2);
  d2.onFrame(frame(SPEECH));
  d2.onFrame(frame(SPEECH));
  for (let i = 0; i < 10; i++) d2.onFrame(frame(MID)); // 320 ms of "mid" — no silence
  assert.equal(ev2.turnEnds.length, 0, "mid frames must not count toward redemption");
  for (let i = 0; i < 30; i++) d2.onFrame(frame(SILENCE)); // adaptive 850 crossed at 27
  assert.equal(ev2.turnEnds.length, 1, "turn ends only after real silence ≥ redemption");
  assert.equal(ev2.turnEnds[0].audio.length, (2 + 10 + 27) * SAMPLES, "mid audio stays in the turn");
});

test("t09: onset after silence → pad yields ≥ 200 ms of pre-speech audio", () => {
  const ev = collect();
  const d = makeDetector(
    { onsetConfirmFrames: 3, preSpeechPadMs: 200, redemptionMs: 650, minSpeechMs: 100 }, ev
  );
  for (let i = 0; i < 20; i++) d.onFrame(frame(SILENCE)); // 640 ms of lead-in
  for (let i = 0; i < 20; i++) d.onFrame(frame(SPEECH));  // onset at 3rd; 17 listening frames (640 ms speech → base redemption)
  for (let i = 0; i < 25; i++) d.onFrame(frame(SILENCE));
  assert.equal(ev.turnEnds.length, 1);
  const e = ev.turnEnds[0];
  // ring capacity = (200 + 3×32) ms = 296 ms = 4736 samples; turn frames = 17+21
  const turnFramesSamples = (17 + 21) * SAMPLES;
  assert.equal(e.audio.length, 4736 + turnFramesSamples);
  assert.ok(e.audio.length - turnFramesSamples >= 3200, "pad ≥ 200 ms = 3200 samples");
  // the first 200 ms of the audio are pre-speech silence, speech starts after
  const padRms = Math.sqrt(
    e.audio.subarray(0, 3200).reduce((s, v) => s + v * v, 0) / 3200
  );
  assert.ok(padRms < 0.01, "pad content is pre-speech audio, not speech");
});

test("t10: user options override every default", () => {
  // nested merge keeps untouched defaults
  const merged = mergeOptions({ thresholds: { redemptionMs: 100 } }, {
    thresholds: { onsetSpeechThreshold: 0.6, redemptionMs: 650 },
  });
  assert.equal(merged.thresholds.redemptionMs, 100);
  assert.equal(merged.thresholds.onsetSpeechThreshold, 0.6);

  // detector honors overrides end-to-end (hesitant short speech: base + 200,
  // clamped to the 350 floor — 150 + 200 = 350)
  const ev = collect();
  const d = makeDetector(
    { onsetConfirmFrames: 1, redemptionMs: 150, minSpeechMs: 0 }, ev
  );
  d.onFrame(frame(SPEECH)); // confirm 1 → immediate onset
  assert.equal(ev.speechStarts, 1);
  for (let i = 0; i < 11; i++) d.onFrame(frame(SILENCE)); // 352 ms ≥ clamped 350
  assert.equal(ev.turnEnds.length, 1);
});

test("t11: grace after interrupt — silence ignored for graceAfterInterruptMs", () => {
  const ev = collect();
  const d = makeDetector(
    { bargeInConfirmFrames: 2, graceAfterInterruptMs: 500, redemptionMs: 320, minSpeechMs: 0 }, ev
  );
  d.setAgentSpeaking(true);
  for (let i = 0; i < 3; i++) d.onFrame(frame(SPEECH)); // interrupt → grace armed
  d.setAgentSpeaking(false); // disarm immediately (silenceMs = 0 → no flush)
  for (let i = 0; i < 10; i++) d.onFrame(frame(SILENCE)); // 320 ms ≥ base redemption…
  assert.equal(ev.turnEnds.length, 0, "grace must block redemption right after interrupt");
  for (let i = 0; i < 30; i++) d.onFrame(frame(SILENCE)); // grace expires, then silence counts
  assert.equal(ev.turnEnds.length, 1, "turn ends once silence counts past grace");
});

test("t12: maxTurnMs force-ends the turn with truncated=true, then re-arms", () => {
  const ev = collect();
  const d = makeDetector({ onsetConfirmFrames: 1, maxTurnMs: 1000, minSpeechMs: 0 }, ev);
  d.onFrame(frame(SPEECH)); // onset
  for (let i = 0; i < 40; i++) d.onFrame(frame(SPEECH)); // 40×32 = 1280 ms > 1000
  assert.equal(ev.turnEnds.length, 1);
  assert.equal(ev.turnEnds[0].truncated, true);
  assert.equal(d.state, "listening", "continued speech re-arms a new turn");
  d.thresholds.maxTurnMs = 50000; // let the second turn end by redemption instead
  for (let i = 0; i < 20; i++) d.onFrame(frame(SPEECH)); // speechMs 640 ≥ 600 → base redemption
  for (let i = 0; i < 21; i++) d.onFrame(frame(SILENCE)); // 672 ≥ 650
  assert.equal(ev.turnEnds.length, 2);
  assert.equal(ev.turnEnds[1].truncated, false);
  assert.equal(d.state, "ready");
});
