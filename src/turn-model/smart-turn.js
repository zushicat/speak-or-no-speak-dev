/**
 * `SmartTurnModel` — the optional semantic end-of-turn model (WP8).
 *
 * Wraps `smart-turn-v3.2-cpu.onnx` (Whisper-Tiny backbone, 8 MB int8) behind
 * the `TurnModel` interface:
 *
 *     predictComplete(turnAudio: Float32Array): Promise<boolean>  // true = sentence done
 *
 * Pipeline: turn audio (16 kHz mono) → pad/truncate to 8 s (left-pad) →
 * zero-mean/unit-var → Whisper log-mel [80, 800] (whisper-features.js,
 * parity-verified vs the Python reference) → ORT Web inference → sigmoid
 * probability > 0.5 → complete.
 *
 * - The ORT runtime comes from the pinned CDN script (`window.ort`), the
 *   weights from `/vendor/` (gitignored; see README-advanced for the manual
 *   download step) or a URL.
 * - Lazy session init: the first evaluation pays the model load (~120 ms
 *   local). Load failure → predictComplete rejects → the detector fails open
 *   (emits the turn end).
 * - Runs ONLY at silence points (the state machine guarantees it) — the
 *   real-time frame budget is untouched.
 * - Measured on the reference machine: session load 120 ms, inference
 *   p50 ≈ 141 ms (single-threaded WASM; native ORT: 7 ms — see the spike
 *   report in plans/initial/wp8-decision.md).
 *
 * @module turn-model/smart-turn
 */

import { whisperFeatures } from "./whisper-features.js";

/** @typedef {import("../types.js").TurnModel} TurnModel */

export class SmartTurnModel {
  /**
   * @param {Object} [options]
   * @param {string} [options.modelUrl]   where to fetch the ONNX weights
   * @param {any} [options.ort]           the ORT namespace (defaults to window.ort)
   * @param {number} [options.threshold]  completion probability threshold (0.5)
   */
  constructor(options = {}) {
    this.modelUrl = options.modelUrl ?? "/vendor/smart-turn-v3.2-cpu.onnx";
    this.threshold = options.threshold ?? 0.5;
    this.session = null;
    this._initPromise = null;
    this._ort = options.ort ?? (typeof window !== "undefined" ? window.ort : null);
  }

  /** Load the model once; subsequent calls reuse the session. */
  async ensureSession() {
    if (this.session) return this.session;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        if (!this._ort?.InferenceSession) {
          throw new Error("ORT runtime unavailable (window.ort missing — is the CDN script loaded?)");
        }
        this.session = await this._ort.InferenceSession.create(this.modelUrl, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
        return this.session;
      })();
    }
    return this._initPromise;
  }

  /**
   * @param {Float32Array} turnAudio 16 kHz mono turn audio (any length)
   * @returns {Promise<boolean>} true = the sentence is complete
   */
  async predictComplete(turnAudio) {
    const session = await this.ensureSession();
    const features = whisperFeatures(turnAudio);
    const tensor = new this._ort.Tensor("float32", Float32Array.from(features), [1, 80, 800]);
    const results = await session.run({ input_features: tensor });
    const probability = results.logits.data[0];
    return probability > this.threshold;
  }
}
