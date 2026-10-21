/**
 * WP7 — energy fallback engine + degradation-ladder tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EnergyVad, energyProbability } from "../../src/vad/energy-vad.js";
import { createSpeakOrNoSpeak } from "../../src/speak-or-no-speak.js";
import { ERROR_CODES } from "../../src/errors.js";

test("e01: energyProbability — absolute floor, ratio normalization, clamping", () => {
  assert.equal(energyProbability(0.004, 0.001), 0, "below the absolute floor → 0");
  assert.equal(energyProbability(0.001, 0.001), 0, "rms at the noise floor → 0");
  const nf = 0.002; // floor such that the ratio points sit above ABS_FLOOR 0.005
  // rms 3.2× floor → probability 0 (speech starts above 3.2× the floor)
  assert.equal(energyProbability(0.0064, nf), 0);
  // rms 6.4× floor → (6.4−3.2)/3.2 = 1.0
  assert.equal(energyProbability(0.0128, nf), 1);
  // rms 4.8× floor → 0.5
  assert.ok(Math.abs(energyProbability(0.0096, nf) - 0.5) < 1e-9);
  assert.equal(energyProbability(50, nf), 1, "clamped to 1");
});

test("e02: EnergyVad pump — synthetic chunks produce frames with adaptive probability", () => {
  const eng = new EnergyVad();
  eng.started = true; // test the pump without a mic
  // fake the context rate for deterministic resampling
  eng.ctx = { sampleRate: 48000 };
  const frames = [];
  eng.onFrame((f) => frames.push(f));

  // 10 chunks of near-silence (rms ~0.001): the floor adapts, probability 0
  for (let i = 0; i < 10; i++) {
    eng._handleAudioChunk(new Float32Array(4096).fill(0.0005));
  }
  const silentFrames = frames.slice();
  assert.ok(silentFrames.length > 0, "chunks produce 512-sample frames");
  assert.ok(silentFrames.every(f => f.probability === 0 || f.probability < 0.5), "silence → low probability");
  assert.ok(silentFrames.every(f => f.frame.length === 512));
  assert.ok(silentFrames.every(f => f.durationMs === 32));

  // loud speech-like burst: probability should jump high
  const before = frames.length;
  for (let i = 0; i < 6; i++) {
    eng._handleAudioChunk(new Float32Array(4096).fill(0.15));
  }
  const speechFrames = frames.slice(before);
  assert.ok(speechFrames.some(f => f.probability > 0.5), "loud burst → high probability");
  eng.stop();
});

test("e03: pause() suppresses frame emission; resume() restores it", () => {
  const eng = new EnergyVad();
  eng.started = true;
  eng.ctx = { sampleRate: 48000 };
  const frames = [];
  eng.onFrame((f) => frames.push(f));
  eng.pause();
  eng._handleAudioChunk(new Float32Array(4096).fill(0.15));
  const duringPause = frames.length;
  eng._handleAudioChunk(new Float32Array(4096).fill(0.15));
  assert.equal(frames.length, duringPause, "no frames while paused");
  eng.resume();
  eng._handleAudioChunk(new Float32Array(4096).fill(0.15));
  assert.ok(frames.length > duringPause, "frames resume");
});

test("e04: facade degradation ladder — engine-load-failed switches to the energy engine", async () => {
  /** Primary engine that fails exactly like a blocked CDN would. */
  class FailingSilero {
    constructor() { this.stopped = false; this.aecDegraded = false; }
    async start() {
      const err = new Error("CDN unreachable");
      err.code = ERROR_CODES.CDN_UNAVAILABLE;
      throw err;
    }
    stop() { this.stopped = true; }
    pause() {} resume() {}
    onFrame() {} onError() {}
  }
  /** Stub energy engine that starts fine and emits a couple of frames. */
  class WorkingEnergy {
    constructor() { this.frameCbs = []; this.aecDegraded = false; }
    async start() {
      this.frameCbs.forEach(cb => cb({ probability: 0.9, frame: new Float32Array(512), rms: 0.05, durationMs: 32 }));
    }
    stop() {} pause() {} resume() {}
    onFrame(cb) { this.frameCbs.push(cb); }
    onError() {}
  }

  const warnings = [];
  const sons = await createSpeakOrNoSpeak({
    engine: new FailingSilero(),
    energyEngine: new WorkingEnergy(),
    onError: (e) => warnings.push(e.code),
    onSpeechStart: () => {},
  });
  await sons.start();
  assert.equal(sons.degraded.engine, "energy", "degraded.engine reports the fallback");
  assert.ok(warnings.includes(ERROR_CODES.ENGINE_FALLBACK), "one-time engine-fallback warning emitted");
  assert.equal(sons.state, "ready");
});

test("e05: fatal errors (mic-denied) do NOT trigger the fallback", async () => {
  class MicDenied {
    constructor() { this.aecDegraded = false; }
    async start() {
      const err = new Error("denied");
      err.code = ERROR_CODES.MIC_DENIED;
      throw err;
    }
    stop() {} pause() {} resume() {}
    onFrame() {} onError() {}
  }
  const sons = await createSpeakOrNoSpeak({ engine: new MicDenied() });
  await assert.rejects(() => sons.start());
  assert.equal(sons.state, "idle");
});
