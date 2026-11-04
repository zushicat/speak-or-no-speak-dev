/**
 * WP-E5 — the `halfDuplex` escape hatch (M6): while the agent flag is armed,
 * every frame is treated as non-speech — no barge-in, no interrupts; turn
 * accumulation continues and a redemption-eligible turn flushes on disarm
 * (rule 3). Un-armed behavior is unaffected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TurnDetector } from "../../src/turn/turn-detector.js";
import { DEFAULTS } from "../../src/config.js";

const RATE = 16000, FRAME = 512, FRAME_MS = 32;
const frame = (prob) => ({
  probability: prob,
  frame: new Float32Array(FRAME).fill(prob >= 0.6 ? 0.1 : 0.001),
  rms: prob >= 0.6 ? 0.05 : 0.001,
  durationMs: FRAME_MS,
});

test("halfDuplex: armed + sustained speech frames → no interrupt, no state change", () => {
  const det = new TurnDetector({
    halfDuplex: true,
    thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 },
  });
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  for (let i = 0; i < 20; i++) det.onFrame(frame(0.95)); // sustained "speech"
  assert.equal(interrupts, 0, "no barge-in while armed in half-duplex");
  assert.equal(det.state, "ready", "no state change from armed frames");
  assert.equal(det.interruptConfirm, 0);
});

test("halfDuplex: pending turn flushes correctly on disarm (rule 3)", async () => {
  const det = new TurnDetector({
    halfDuplex: true,
    thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 },
  });
  const turnEnds = [];
  det.onTurnEnd = (e) => turnEnds.push(e);
  // user turn starts un-armed
  det.onFrame(frame(0.95));
  det.onFrame(frame(0.95));
  assert.equal(det.state, "listening");
  const preTurnFrames = det.turnFrames.length;
  // agent arms; speech frames count as silence → silence grows
  det.setAgentSpeaking(true);
  for (let i = 0; i < 20; i++) det.onFrame(frame(0.95));
  assert.equal(turnEnds.length, 0, "no turn end while armed (matrix)");
  // disarm → the redemption-eligible turn flushes
  det.setAgentSpeaking(false);
  assert.equal(turnEnds.length, 1, "pending turn flushed on disarm");
  assert.equal(turnEnds[0].afterInterrupt, false, "no barge-in happened");
  assert.ok(turnEnds[0].audio.length >= preTurnFrames * FRAME, "turn audio preserved");
});

test("halfDuplex: un-armed behavior unaffected", () => {
  const det = new TurnDetector({
    halfDuplex: true,
    thresholds: { onsetConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 },
  });
  const starts = [];
  det.onSpeechStart = () => starts.push(1);
  det.onFrame(frame(0.95));
  det.onFrame(frame(0.95));
  assert.equal(det.state, "listening", "onset confirm works un-armed");
  assert.equal(starts.length, 1);
});

test("halfDuplex default off: armed speech still barge-ins (regression)", () => {
  const det = new TurnDetector({
    thresholds: { onsetConfirmFrames: 2, bargeInConfirmFrames: 2, minSpeechMs: 0, redemptionMs: 64 },
  });
  assert.equal(DEFAULTS.halfDuplex, false, "ships default-off");
  det.setAgentSpeaking(true);
  let interrupts = 0;
  det.onInterrupt = () => interrupts++;
  det.onFrame(frame(0.95));
  det.onFrame(frame(0.95));
  assert.equal(interrupts, 1, "normal barge-in behavior preserved");
});
