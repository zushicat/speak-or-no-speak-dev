/**
 * Zero-dependency 16-bit PCM WAV encoder (WP4 §4.5).
 *
 * Primary debugging tool for turn audio: the demo wires `onTurnEnd` audio
 * into a "Save last turn (.wav)" download; the WP6 calibration harness will
 * reuse it for replay fixtures; embedding apps can export turns too.
 * Pure byte building — no deps (D1).
 *
 * Path note (D-WP4-1): the WP4 plan placed this in `test/util/`, but the demo
 * imports it in the browser and it must not drag `node:test` into a page —
 * so the encoder lives in `src/` and its tests in `test/util/`.
 *
 * @module wav-export
 */

/**
 * Encode mono Float32 samples as a 16-bit PCM WAV file.
 * @param {Float32Array} samples  values in [-1, 1] (clamped)
 * @param {number} [sampleRate]   default 16000
 * @returns {ArrayBuffer} complete WAV file bytes (RIFF header + data)
 */
export function encodeWavBytes(samples, sampleRate = 16000) {
  const dataLen = samples.length * 2; // 16-bit → 2 bytes/sample
  const buffer = new ArrayBuffer(44 + dataLen);
  const view = new DataView(buffer);

  const writeStr = (offset, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLen, true);      // file size - 8
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);               // fmt chunk size (PCM)
  view.setUint16(20, 1, true);                // audio format: PCM
  view.setUint16(22, 1, true);                // channel count: mono
  view.setUint32(24, sampleRate, true);       // sample rate
  view.setUint32(28, sampleRate * 2, true);   // byte rate = rate × 2 bytes
  view.setUint16(32, 2, true);                // block align
  view.setUint16(34, 16, true);               // bits per sample
  writeStr(36, "data");
  view.setUint32(40, dataLen, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true); // little-endian int16
    off += 2;
  }
  return buffer;
}

/**
 * Encode as a downloadable Blob (browser) — falls back to Buffer in Node
 * (Node ≥ 18 ships a global Blob; both paths covered).
 * @param {Float32Array} samples
 * @param {number} [sampleRate]
 * @returns {Blob | Buffer}
 */
export function encodeWav(samples, sampleRate = 16000) {
  const bytes = encodeWavBytes(samples, sampleRate);
  if (typeof Blob !== "undefined") return new Blob([bytes], { type: "audio/wav" });
  return Buffer.from(bytes);
}
