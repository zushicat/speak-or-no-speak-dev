/**
 * `SileroVadAdapter` — Silero VAD v5 via `@ricky0123/vad-web` (WP1, D1 zero-build).
 *
 * Loaded from pinned CDN `<script>` tags (see index.html); this adapter reads the
 * `window.vad` global **only here** — the single choke point for a later npm/
 * bundler migration (T7 dual-mode) or the WP7 energy fallback.
 *
 * ### API verification vs the WP1 sketch (docs.vad.ricky0123.com @ 0.0.31 + bundle inspection)
 * - **`stream` option does not exist** in 0.0.31 → we pass our constrained
 *   MediaStream via the documented `getStream` override instead (docs:
 *   "override … to provide your own stream"). Our AEC constraints therefore
 *   apply to the exact stream the engine consumes.
 * - **`frameSamples` is accepted but undocumented** — bundle: `processorOptions =
 *   {...processorOptions, frameSamples: o}`, default 1536. We pass 1536
 *   explicitly and verify the delivered frame length at runtime.
 * - **`model: "v5"` must be passed explicitly** — the 0.0.31 default is
 *   `"legacy"`, and this project targets Silero v5 (plan T1).
 * - `onFrameProcessed(probs, frame)` is a documented `MicVAD.new` option; the
 *   frame parameter is documented as provided.
 *
 * ### Runtime-verified findings (WP1 acceptance)
 * - `onFrameProcessed` frame param provided: **yes** (verified 2026-10-20, Chrome)
 * - frame length: **512 samples → 32.0 ms** at 16 kHz, measured 31.99 frames/s —
 *   the frame size is **model-derived** in 0.0.31 (`legacy ? 1536 : 512` in the
 *   bundle) and the `frameSamples` OPTION IS IGNORED for MicVAD. The plan §2/§4.3
 *   "1536 ≈ 96 ms" assumption holds only for the legacy model; with Silero v5
 *   (T1) frames are 32 ms — WP3 must recalibrate frame-count thresholds
 *   (e.g. onsetConfirmFrames 3×96 ms → ~9×32 ms for the same 288 ms window).
 * - audio-capture strategy (plan 1.3.3): frames ARE provided → WP3 buffers turn
 *   audio from frames; vad-web's own `onSpeechEnd` segmentation stays unwired.
 * - **AudioWorklet can hang** (`audioWorklet.addModule` never resolves — observed
 *   in automation Chromium 154/2026-10-20; known to also happen in old Safari and
 *   embedded webviews). Mitigation: `MicVAD.new()` is timeout-guarded (8 s) and
 *   retried with vad-web's documented legacy path `processorType: "ScriptProcessor"`,
 *   which needs no worklet module load. The effective processor type is exposed
 *   as `processorTypeUsed` ("audio-worklet" | "script-processor").
 * - Mic track: 48 kHz native; vad-web runs a default (device-rate) AudioContext
 *   and resamples to 16 kHz internally; AEC/NS/AGC all active on the track.
 *
 * @module silero-vad-adapter
 */

import { VadEngine } from "./vad-engine.js";
import { ERROR_CODES, SpeakError } from "../errors.js";

/** vad-web dist base — also where the worklet bundle + silero_vad_v5.onnx live. */
const VAD_WEB_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
/** onnxruntime-web dist base — WASM files (+ .mjs bindings) for ORT 1.22.0. */
const ORT_WEB_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

/** Expected frame size: 1536 samples @ 16 kHz ≈ 96 ms (plan §2, T1). */
const FRAME_SAMPLES = 1536;
const SAMPLE_RATE = 16000;
/** MicVAD.new must resolve within this window or we retry the legacy processor path. */
const VAD_NEW_TIMEOUT_MS = 8000;

/** Default mic constraints — browser AEC is the E1 echo-safety groundwork (plan §8). */
const AEC_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** RMS loudness of a float32 mono frame, 0..1. */
function computeRms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/**
 * @augments {VadEngine}
 */
export class SileroVadAdapter extends VadEngine {
  /**
   * @param {Object} [options]
   * @param {MediaTrackConstraints} [options.mic]  overrides merged over the
   *        AEC defaults (echoCancellation/noiseSuppression/autoGainControl on)
   */
  constructor(options = {}) {
    super();
    this.micConstraints = { ...AEC_CONSTRAINTS, ...(options.mic ?? {}) };
    /** @type {FrameCallback[]} */
    this.frameCallbacks = [];
    /** @type {ErrorCallback[]} */
    this.errorCallbacks = [];
    /** @type {any|null} */
    this.vad = null;
    /** @type {MediaStream|null} */
    this.stream = null;
    /** @type {MediaTrackSettings|null} — mic track settings captured at start() */
    this.micSettings = null;
    /** true if the mic track reports echoCancellation !== true (WP5 gating input) */
    this.aecDegraded = false;
    /** "audio-worklet" | "script-processor" — which capture path actually works */
    this.processorTypeUsed = null;
    /** runtime finding: does the engine deliver raw frames? (plan 1.3.3 decision) */
    this.frameParamProvided = null;
    this.started = false;
    this.paused = false;
    this._firstFrameResolve = null;
  }

  /** @param {FrameCallback} cb */
  onFrame(cb) {
    this.frameCallbacks.push(cb);
  }

  /** @param {ErrorCallback} cb */
  onError(cb) {
    this.errorCallbacks.push(cb);
  }

  /** @private */
  _emitError(code, message) {
    const err = { code, message };
    for (const cb of this.errorCallbacks) cb(err);
  }

  /** @private */
  _emitFrame(frame) {
    for (const cb of this.frameCallbacks) cb(frame);
  }

  /**
   * MicVAD.new with a timeout guard: first attempt uses vad-web's default
   * processor ("auto" → AudioWorklet); on timeout (worklet module load hang) or
   * error, retries with `processorType: "ScriptProcessor"` (no worklet needed).
   * @private
   * @param {{MicVAD: {new(options: any): Promise<any>}}} vadLib the resolved library (CDN global or npm module)
   * @returns {Promise<any>} the MicVAD instance
   */
  async _newVadWithFallback(vadLib) {
    const attempt = async (processorType) => {
      const options = {
        model: "v5", // Silero v5 (plan T1) — 0.0.31 default is "legacy"
        getStream: async () => this.stream,
        baseAssetPath: VAD_WEB_BASE,
        onnxWASMBasePath: ORT_WEB_BASE,
        frameSamples: FRAME_SAMPLES, // accepted-but-undocumented; default 1536 anyway
        onFrameProcessed: (probs, frame) => {
          this.frameParamProvided = frame != null;
          const raw = frame ?? null;
          const out = {
            probability: probs.isSpeech,
            frame: raw,
            rms: raw ? computeRms(raw) : 0,
            durationMs: raw ? (raw.length / SAMPLE_RATE) * 1000 : (FRAME_SAMPLES / SAMPLE_RATE) * 1000,
          };
          if (this._firstFrameResolve) {
            this._firstFrameResolve();
            this._firstFrameResolve = null;
          }
          if (!this.paused) this._emitFrame(out);
        },
      };
      if (processorType) options.processorType = processorType;

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new SpeakError(ERROR_CODES.ENGINE_LOAD_FAILED, `vad-new-timeout (${processorType ?? "auto"})`)), VAD_NEW_TIMEOUT_MS)
      );
      return Promise.race([vadLib.MicVAD.new(options), timeout]);
    };

    try {
      const vad = await attempt(); // default: AudioWorklet via "auto"
      this.processorTypeUsed = "audio-worklet";
      return vad;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[sons] MicVAD.new default processor failed/hung — retrying with ScriptProcessor:", err?.message);
      const vad = await attempt("ScriptProcessor");
      this.processorTypeUsed = "script-processor";
      return vad;
    }
  }

  /**
   * Open the mic with AEC constraints and start Silero inference.
   * Resolves when the first frame is emitted (interface contract); rejects
   * (and reports via onError) if no frames arrive within 5 s.
   *
   * Dual-mode library resolution (WP7 §7.5):
   * 1. `window.vad` present (pinned CDN `<script>` tags) → zero-build mode;
   * 2. else dynamic `import("@ricky0123/vad-web")` → bundler/npm consumers;
   * 3. both fail → `cdn-unavailable` error → the FACADE switches to the
   *    energy fallback engine (degraded.engine = "energy").
   * @returns {Promise<void>}
   */
  async start() {
    // Guard (plan 1.3.6): module must stay importable in Node and fail soft
    // in the browser when the CDN scripts did not load.
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      this._emitError(ERROR_CODES.INSECURE_CONTEXT, "SileroVadAdapter requires a browser environment.");
      throw new SpeakError(ERROR_CODES.INSECURE_CONTEXT, "SileroVadAdapter requires a browser environment.");
    }

    // 1. CDN globals (zero-build, D1)
    let vadLib = typeof window.vad?.MicVAD?.new === "function" ? window.vad : null;
    // 2. npm/bundler mode: the package resolves via the bundler or node_modules
    if (!vadLib) {
      try {
        vadLib = await import("@ricky0123/vad-web");
      } catch {
        /* mode 2 unavailable — zero-build page without CDN */
      }
    }
    if (!vadLib?.MicVAD?.new) {
      this._emitError(
        ERROR_CODES.CDN_UNAVAILABLE,
        "VAD library unavailable — neither the pinned CDN scripts (window.vad) nor the @ricky0123/vad-web package could be loaded."
      );
      throw new SpeakError(ERROR_CODES.CDN_UNAVAILABLE, "VAD library unavailable (CDN + npm import)");
    }

    try {
      // 1. Mic with AEC constraints (plan 1.3.1) — our stream, not vad-web's default.
      if (!navigator.mediaDevices?.getUserMedia) {
        const msg = "Microphone API unavailable — this page is not running in a secure context (serve via http://localhost, never file://).";
        this._emitError(ERROR_CODES.INSECURE_CONTEXT, msg);
        throw new SpeakError(ERROR_CODES.INSECURE_CONTEXT, msg);
      }
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints });
      const track = this.stream.getAudioTracks()[0];
      this.micSettings = track.getSettings();
      // eslint-disable-next-line no-console
      console.log("[sons] mic settings:", this.micSettings);
      if (this.micSettings.echoCancellation !== true) {
        // Interim warning code; facade switches to stricter barge-in gating in WP5.
        this.aecDegraded = true;
        this._emitError(
          ERROR_CODES.NO_AEC,
          `echoCancellation is not active on the mic track (settings: ${JSON.stringify(this.micSettings)})`
        );
      }

      // 2. Instantiate vad-web 0.0.31 with OUR stream (getStream override — the
      //    documented way to pass a stream; `stream` itself is not an option).
      //    Timeout-guarded: if the AudioWorklet path hangs (addModule never
      //    resolves — seen in automation Chromium, old Safari, webviews), retry
      //    with the documented ScriptProcessor legacy path.
      const firstFrame = new Promise((resolve) => {
        this._firstFrameResolve = resolve;
      });
      this.vad = await this._newVadWithFallback(vadLib);

      // 5. Our state machine (WP3) owns turn events — vad-web's internal
      //    segmentation (onSpeechStart/onSpeechEnd) stays unwired by design.
      this.vad.start();
      this.started = true;
      this.paused = false;

      // Interface contract: resolve when the first frame is emitted.
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("vad-no-frames")), 5000)
      );
      await Promise.race([firstFrame, timeout]);
    } catch (err) {
      if (err instanceof SpeakError) {
        this.stop();
        throw err; // already emitted with its taxonomy code
      }
      if (err && err.name === "NotAllowedError") {
        this._emitError(ERROR_CODES.MIC_DENIED, "Microphone permission denied.");
        throw new SpeakError(ERROR_CODES.MIC_DENIED, "Microphone permission denied.", err);
      }
      if (err && err.name === "NotFoundError") {
        this._emitError(ERROR_CODES.MIC_NOT_FOUND, "No microphone found on this device.");
        throw new SpeakError(ERROR_CODES.MIC_NOT_FOUND, "No microphone found", err);
      }
      if (err && err.message === "vad-no-frames") {
        this._emitError(ERROR_CODES.VAD_NO_FRAMES, "Engine started but no frames arrived within 5 s.");
        throw new SpeakError(ERROR_CODES.VAD_NO_FRAMES, "no frames within 5 s", err);
      }
      this._emitError(ERROR_CODES.ENGINE_LOAD_FAILED, `MicVAD init/start failed: ${err?.message ?? err}`);
      throw new SpeakError(ERROR_CODES.ENGINE_LOAD_FAILED, "MicVAD init/start failed", err);
    }
  }

  /** Stop the engine and release the microphone. */
  stop() {
    try {
      this.vad?.pause(); // default pauseStream stops the tracks
    } catch {
      /* already torn down */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.vad = null;
    this.started = false;
    this.paused = false;
  }

  /**
   * Pause frame emission. vad-web's default pause stops the mic tracks; its
   * default resume creates a new stream with standard constraints — which match
   * ours exactly (AEC_CONSTRAINTS), so pause/resume keeps AEC active. WP3/WP5
   * may swap in track.enable toggling if real-time pause semantics matter.
   */
  pause() {
    if (this.started && !this.paused) {
      this.paused = true;
      try {
        this.vad?.pause();
      } catch {
        /* noop */
      }
    }
  }

  resume() {
    if (this.started && this.paused) {
      this.paused = false;
      try {
        this.vad?.start();
      } catch {
        /* noop */
      }
    }
  }
}
