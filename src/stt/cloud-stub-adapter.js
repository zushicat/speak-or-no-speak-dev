/**
 * `CloudStubAdapter` — the shipped STT example (WP9 §9.2, option (a)).
 *
 * POSTs the turn audio as a 16-bit PCM WAV body (WP4's `encodeWav`) to a
 * configurable endpoint and expects `{ text, confidence? }` JSON back.
 *
 * ⚠️ **DEV EXAMPLE — add auth for production.** Never hardcode API keys in
 * app code: pass `endpoint` + `token` from YOUR configuration. A server-side
 * proxy keeps credentials out of the browser entirely.
 *
 * ~50 lines by design: swappable — implement `SttAdapter` (see stt-adapter.js)
 * for any backend (Whisper server, a managed STT API, …).
 *
 * @module stt/cloud-stub-adapter
 */

import { encodeWav } from "../wav-export.js";

/** @augments {SttAdapter} */
export class CloudStubAdapter {
  /**
   * @param {Object} options
   * @param {string} options.endpoint  POST target (required)
   * @param {string} [options.token]   sent as `Authorization: Bearer …` if set
   * @param {string} [options.language] default language hint
   */
  constructor(options = {}) {
    if (!options.endpoint) throw new Error("CloudStubAdapter requires an endpoint");
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.language = options.language;
  }

  /**
   * @param {Float32Array} audio     16 kHz mono turn audio
   * @param {{language?: string}} [opts]
   * @returns {Promise<import("./stt-adapter.js").Transcription>}
   */
  async transcribe(audio, opts = {}) {
    const headers = { "Content-Type": "audio/wav" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const language = opts.language ?? this.language;
    if (language) headers["X-Language"] = language;

    const body = encodeWav(audio, 16000); // Blob (browser) / Buffer (Node)
    const res = await fetch(this.endpoint, { method: "POST", headers, body });
    if (!res.ok) throw new Error(`STT endpoint responded ${res.status}`);
    const data = await res.json();
    return { text: String(data.text ?? ""), confidence: typeof data.confidence === "number" ? data.confidence : undefined };
  }
}
