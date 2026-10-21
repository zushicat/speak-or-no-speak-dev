/** WP4 — WAV encoder tests (header fields, PCM round-trip, clamping). */
import test from "node:test";
import assert from "node:assert/strict";
import { encodeWavBytes, encodeWav } from "../../src/wav-export.js";

test("wav header: RIFF/fmt/data fields for 16 kHz mono", () => {
  const bytes = encodeWavBytes(new Float32Array(1600), 16000); // 100 ms
  const view = new DataView(bytes);
  const tag = (o, len) => String.fromCharCode(...new Uint8Array(bytes, o, len));
  assert.equal(tag(0, 4), "RIFF");
  assert.equal(tag(8, 4), "WAVE");
  assert.equal(tag(12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1);          // PCM
  assert.equal(view.getUint16(22, true), 1);          // mono
  assert.equal(view.getUint32(24, true), 16000);      // sample rate
  assert.equal(view.getUint16(34, true), 16);         // bits
  assert.equal(tag(36, 4), "data");
  assert.equal(view.getUint32(40, true), 3200);       // 1600 samples × 2 B
  assert.equal(view.getUint32(4, true), 36 + 3200);   // riff size
  assert.equal(bytes.byteLength, 44 + 3200);
});

test("pcm samples: full-scale values and clamping round-trip", () => {
  const bytes = encodeWavBytes(Float32Array.from([0.5, -0.5, 1.0, -1.0, 1.5]), 16000);
  const view = new DataView(bytes);
  assert.equal(view.getInt16(44, true), Math.round(0.5 * 0x7fff));
  assert.equal(view.getInt16(46, true), -Math.round(0.5 * 0x8000));
  assert.equal(view.getInt16(48, true), 0x7fff);
  assert.equal(view.getInt16(50, true), -0x8000);
  assert.equal(view.getInt16(52, true), 0x7fff, "out-of-range clamps to full scale");
});

test("other sample rates land in the header (48 kHz)", () => {
  const bytes = encodeWavBytes(new Float32Array(480), 48000);
  const view = new DataView(bytes);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint32(28, true), 96000);      // byte rate
});

test("encodeWav returns a Blob where available", () => {
  const out = encodeWav(new Float32Array(8), 16000);
  if (typeof Blob !== "undefined") {
    assert.ok(out instanceof Blob);
    assert.equal(out.type, "audio/wav");
  } else {
    assert.ok(Buffer.isBuffer(out));
  }
});
