/**
 * WP3 — facade wiring test with an injected mock engine (t13).
 * Proves the facade contract: lifecycle, state getter, event forwarding,
 * agent flag, degraded reporting — all in Node, no browser needed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSpeakOrNoSpeak } from "../../src/speak-or-no-speak.js";

const SAMPLES = 512, SAMPLE_RATE = 16000;
const SPEECH = 0.95, SILENCE = 0.01;

/** Minimal VadEngine double: records calls, replays frames on demand. */
class MockEngine {
  constructor() {
    this.frameCbs = [];
    this.errCbs = [];
    this.startedCount = 0;
    this.stoppedCount = 0;
    this.aecDegraded = false;
  }
  async start() { this.startedCount++; }
  stop() { this.stoppedCount++; }
  pause() {}
  resume() {}
  onFrame(cb) { this.frameCbs.push(cb); }
  onError(cb) { this.errCbs.push(cb); }
  emit(prob) {
    const f = {
      probability: prob,
      frame: new Float32Array(SAMPLES).fill(prob >= 0.6 ? 0.1 : 0.001),
      rms: prob >= 0.6 ? 0.05 : 0.001,
      durationMs: (SAMPLES / SAMPLE_RATE) * 1000,
    };
    this.frameCbs.forEach((cb) => cb(f));
  }
}

test("t13: facade lifecycle, state, events, agent flag, degraded", async () => {
  const engine = new MockEngine();
  const seen = {
    speechStarts: 0,
    turnEnds: [],
    interrupts: [],
    levels: [],
  };
  const sons = await createSpeakOrNoSpeak({
    engine,
    thresholds: {
      onsetConfirmFrames: 2, bargeInConfirmFrames: 2,
      minSpeechMs: 0, redemptionMs: 64, graceAfterInterruptMs: 0,
    },
    onSpeechStart: () => seen.speechStarts++,
    onTurnEnd: (e) => seen.turnEnds.push(e),
    onInterrupt: (i) => seen.interrupts.push(i),
    onLevel: (rms) => seen.levels.push(rms),
  });

  assert.equal(sons.state, "idle", "idle before start");
  assert.equal(engine.startedCount, 0, "factory must not touch the mic");

  await sons.start();
  assert.equal(sons.state, "ready", "ready after start");
  assert.equal(engine.startedCount, 1);

  // normal turn: 2 speech frames → onset; 11 silence frames (352 ms ≥ clamp
  // floor 350: tiny base 64 → hesitant 264 → clamped) → turn end
  engine.emit(SPEECH);
  engine.emit(SPEECH);
  assert.equal(seen.speechStarts, 1);
  assert.equal(sons.state, "listening", "state mirrors the detector");
  for (let i = 0; i < 11; i++) engine.emit(SILENCE);
  assert.equal(seen.turnEnds.length, 1);
  assert.equal(sons.state, "ready", "state returns after turn end");
  assert.equal(seen.levels.length, 13, "onLevel fired once per emitted frame");

  // agent flag: speech → interrupt (not speech start), turn end suppressed
  sons.setAgentSpeaking(true);
  engine.emit(SPEECH);
  engine.emit(SPEECH);
  assert.equal(seen.interrupts.length, 1, "barge-in fires onSpeechStart's job");
  assert.equal(seen.speechStarts, 1, "no extra speech start");
  for (let i = 0; i < 11; i++) engine.emit(SILENCE);
  assert.equal(seen.turnEnds.length, 1, "no turn end while agent speaks");
  sons.setAgentSpeaking(false);
  assert.equal(seen.turnEnds.length, 2, "redemption-eligible turn flushes on disarm");
  assert.equal(seen.turnEnds[1].afterInterrupt, true);

  // WP-E1 D2: degraded gained aecScope — the legacy mock engine (no aecScope
  // field) reports the honest "unknown".
  assert.deepEqual(sons.degraded, { aec: false, engine: "silero", aecScope: "unknown" });

  sons.stop();
  assert.equal(sons.state, "idle");
  assert.equal(engine.stoppedCount, 1);
});

test("t13b: engine errors reach onError; stop is idempotent", async () => {
  const engine = new MockEngine();
  const errors = [];
  const sons = await createSpeakOrNoSpeak({ engine, onError: (e) => errors.push(e) });
  await sons.start();
  engine.errCbs.forEach((cb) => cb({ code: "no-aec", message: "test warning" }));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "no-aec");
  sons.stop();
  sons.stop(); // idempotent
  assert.equal(engine.stoppedCount, 1);
});
