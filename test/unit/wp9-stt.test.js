/** WP9 — STT plug point tests: the example adapter's fetch mechanics (mocked fetch). */
import test from "node:test";
import assert from "node:assert/strict";
import { CloudStubAdapter } from "../../src/stt/cloud-stub-adapter.js";

test("s01: transcribe POSTs a WAV body and parses {text, confidence}", async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => ({ text: "hello world", confidence: 0.87 }),
    };
  };
  try {
    const adapter = new CloudStubAdapter({ endpoint: "https://stt.example/transcribe", token: "secret" });
    const audio = new Float32Array(16000); // 1 s
    const result = await adapter.transcribe(audio, { language: "en-US" });
    assert.equal(result.text, "hello world");
    assert.equal(result.confidence, 0.87);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://stt.example/transcribe");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["Content-Type"], "audio/wav");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
    assert.equal(calls[0].init.headers["X-Language"], "en-US");
    // the body is a WAV (Blob in Node ≥ 18): RIFF magic + size
    const body = calls[0].init.body;
    assert.ok(typeof Blob !== "undefined" && body instanceof Blob);
    const bytes = new Uint8Array(await body.arrayBuffer());
    assert.equal(String.fromCharCode(...bytes.subarray(0, 4)), "RIFF");
    assert.equal(bytes.length, 44 + 16000 * 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("s02: HTTP error → rejects with a descriptive message", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const adapter = new CloudStubAdapter({ endpoint: "https://stt.example/x" });
    await assert.rejects(() => adapter.transcribe(new Float32Array(1600)), /503/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("s03: missing endpoint → constructor throws", () => {
  assert.throws(() => new CloudStubAdapter({}));
});

test("s04: the module never calls STT — detection independence by construction", async () => {
  // The facade's public surface has no STT wiring: create + run a turn with
  // an adapter present in scope but never passed in — events fire untouched.
  const { createSpeakOrNoSpeak } = await import("../../src/index.js");
  class MockEngine {
    constructor() { this.frameCbs = []; this.aecDegraded = false; }
    async start() {}
    stop() {} pause() {} resume() {}
    onFrame(cb) { this.frameCbs.push(cb); }
    onError() {}
    emit(prob) { this.frameCbs.forEach(cb => cb({ probability: prob, frame: new Float32Array(512), rms: 0.01, durationMs: 32 })); }
  }
  const engine = new MockEngine();
  let turnEnds = 0;
  const sons = await createSpeakOrNoSpeak({
    engine,
    thresholds: { onsetConfirmFrames: 2, shortPauseMs: 250, redemptionMs: 64, minSpeechMs: 0, graceAfterInterruptMs: 0, modelTimeoutMs: 50 },
    onTurnEnd: () => turnEnds++,
  });
  await sons.start();
  engine.emit(0.95); engine.emit(0.95);
  for (let i = 0; i < 11; i++) engine.emit(0.01);
  assert.equal(turnEnds, 1, "detection events flow without any STT involvement");
});
