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
import {
  AEC_CONSTRAINTS,
  AEC_SCOPE,
  classifyAecScope,
  endedFallbackConstraints,
  isAllStyleRequest,
} from "./aec-scope.js";

/** vad-web dist base — also where the worklet bundle + silero_vad_v5.onnx live. */
const VAD_WEB_BASE = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
/** onnxruntime-web dist base — WASM files (+ .mjs bindings) for ORT 1.22.0. */
const ORT_WEB_BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/";

/** Expected frame size: 1536 samples @ 16 kHz ≈ 96 ms (plan §2, T1). */
const FRAME_SAMPLES = 1536;
const SAMPLE_RATE = 16000;
/** MicVAD.new must resolve within this window or we retry the legacy processor path. */
const VAD_NEW_TIMEOUT_MS = 8000;
/**
 * D4 ended-stream window: a track opened with an "all"-style request that
 * ends by itself within ~3 s of the request (macOS 15+ without the OS
 * *Screen & System Audio Recording* permission — Chromium 479234114) triggers
 * exactly one fallback re-request. The healthy path pays no extra latency —
 * the decision point is the end of the pipeline build (see
 * `_openMicAndBuildVad`).
 */
const ENDED_WINDOW_MS = 3000;

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
    /**
     * Classified AEC scope of the (last opened) mic track — WP-E1 D2/D3.
     * Honest label: "all" | "remote-only" | "unknown" | "none"; `null` before
     * the first start().
     * @type {import("./aec-scope.js").AecScope|null}
     */
    this.aecScope = null;
    /**
     * Derived boolean (WP-E1): true iff the scope is "none" — the facade and
     * the energy engine read this (F3 back-compat).
     */
    this.aecDegraded = false;
    /** "running" | "paused" | "stopped" — mic intent; gates the ended guard
     *  (vad.pause() stops the tracks, which must not look like a D4 death). */
    this._micIntent = "stopped";
    /** @type {MediaStreamTrack|null} — the live mic track (ended guard target) */
    this._track = null;
    /** true once the D4 fallback re-request was used in the current start() */
    this._aecFallbackUsed = false;
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
   * Capture the mic track settings and classify the AEC scope (WP-E1 D2/D3).
   * Keeps `aecDegraded` as the derived `scope === "none"` boolean (F3), and
   * warns honestly: `no-aec` for "none", `aec-scope-limited` for "unknown"
   * (the browser-decided `true` we cannot verify — precisely the leaking
   * Chromium default).
   * @private
   */
  _classifyMicSettings() {
    this.micSettings = this._track.getSettings();
    // eslint-disable-next-line no-console
    console.log("[sons] mic settings:", this.micSettings);
    this.aecScope = classifyAecScope(this.micSettings, this.micConstraints.echoCancellation);
    this.aecDegraded = this.aecScope === AEC_SCOPE.NONE;
    if (this.aecScope === AEC_SCOPE.NONE) {
      this._emitError(
        ERROR_CODES.NO_AEC,
        `echoCancellation is not active on the mic track (settings: ${JSON.stringify(this.micSettings)})`
      );
    } else if (this.aecScope === AEC_SCOPE.UNKNOWN) {
      this._emitError(
        ERROR_CODES.AEC_SCOPE_LIMITED,
        `echoCancellation reported as browser-decided "true" — its scope could not be verified ` +
        `(settings: ${JSON.stringify(this.micSettings)})`
      );
    }
  }

  /**
   * D4 runtime guard: the track ended while the mic was supposed to be
   * running (NOT via pause/stop — those stop tracks by design). No retry
   * post-start (plan D4): warn once and report the honest "unknown" scope;
   * frames have stopped, the app sees the warning.
   * @private
   * @param {MediaStreamTrack} track
   */
  _attachRuntimeEndedGuard(track) {
    track.addEventListener("ended", () => {
      if (this._micIntent !== "running") return;
      this.aecScope = AEC_SCOPE.UNKNOWN;
      this._emitError(
        ERROR_CODES.AEC_SCOPE_FALLBACK,
        "Mic track ended by itself at runtime — AEC scope is now unknown and frames have stopped."
      );
    });
  }

  /**
   * Open the mic (D1 constraints), classify the AEC scope and build the
   * MicVAD pipeline — with the D4 ended-stream fallback (plan D4): a track
   * opened with an "all"-style request that ends by itself within
   * {@link ENDED_WINDOW_MS} of the request (macOS 15+ without the OS
   * *Screen & System Audio Recording* permission — Chromium 479234114) is
   * re-requested ONCE with the browser default (`echoCancellation: true`),
   * with a one-time `aec-scope-fallback` warning; the re-classified scope is
   * honestly "unknown". If the retry's track also dies within the window, the
   * failure surfaces as-is (a mic that dies twice is not an AEC problem).
   *
   * The healthy path pays no extra startup latency: the ended probe runs
   * concurrently with the pipeline build and is only decided at its end.
   *
   * @private
   * @param {{MicVAD: {new(options: any): Promise<any>}}} vadLib the resolved library (CDN global or npm module)
   * @returns {Promise<any>} the ready-to-start MicVAD instance
   */
  async _openMicAndBuildVad(vadLib) {
    const isAllStyle = isAllStyleRequest(this.micConstraints.echoCancellation);
    let constraints = this.micConstraints;
    for (let attempt = 0; ; attempt++) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      const track = stream.getAudioTracks()[0];
      this.stream = stream;
      this._track = track;
      const requestedAt = performance.now();
      let endedDuringBuild = false;
      const onEnded = () => { endedDuringBuild = true; };
      track.addEventListener("ended", onEnded);
      try {
        this._classifyMicSettings();
        const vad = await this._newVadWithFallback(vadLib);
        track.removeEventListener("ended", onEnded);

        // D4 decision point: did the track die within the window while the
        // pipeline was being built?
        const diedInWindow = endedDuringBuild && performance.now() - requestedAt <= ENDED_WINDOW_MS;
        if (diedInWindow && this._micIntent === "running") {
          if (attempt === 0 && isAllStyle) {
            // Exactly one fallback re-request with the browser default.
            this._aecFallbackUsed = true;
            this._emitError(
              ERROR_CODES.AEC_SCOPE_FALLBACK,
              "System-wide echo cancellation was not available (OS permission) — " +
              "fell back to the browser default (one-time re-request)."
            );
            stream.getTracks().forEach((t) => t.stop());
            constraints = endedFallbackConstraints(this.micConstraints.echoCancellation);
            continue;
          }
          // The retry (or a non-"all" request) died too — a mic that dies
          // twice is not an AEC problem: surface as audio-pipeline.
          throw new SpeakError(
            ERROR_CODES.AUDIO_PIPELINE,
            "Mic track ended by itself during start — not an AEC-scope problem."
          );
        }

        this._attachRuntimeEndedGuard(track);
        return vad;
      } catch (err) {
        track.removeEventListener("ended", onEnded);
        if (err instanceof SpeakError && err.code === ERROR_CODES.AUDIO_PIPELINE) throw err;
        const diedInWindow = endedDuringBuild && performance.now() - requestedAt <= ENDED_WINDOW_MS;
        if (diedInWindow && this._micIntent === "running") {
          if (attempt === 0 && isAllStyle) {
            // The pipeline build failed on a self-ended "all" track → D4
            // retry (once) instead of surfacing an engine error.
            this._aecFallbackUsed = true;
            this._emitError(
              ERROR_CODES.AEC_SCOPE_FALLBACK,
              "System-wide echo cancellation was not available (OS permission) — " +
              "fell back to the browser default (one-time re-request)."
            );
            stream.getTracks().forEach((t) => t.stop());
            constraints = endedFallbackConstraints(this.micConstraints.echoCancellation);
            continue;
          }
          throw new SpeakError(
            ERROR_CODES.AUDIO_PIPELINE,
            "Mic track ended by itself during start — not an AEC-scope problem.",
            err
          );
        }
        throw err;
      }
    }
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
      // 1. Mic with AEC constraints (D1: widest scope as an *ideal*) — our
      //    stream, not vad-web's default.
      if (!navigator.mediaDevices?.getUserMedia) {
        const msg = "Microphone API unavailable — this page is not running in a secure context (serve via http://localhost, never file://).";
        this._emitError(ERROR_CODES.INSECURE_CONTEXT, msg);
        throw new SpeakError(ERROR_CODES.INSECURE_CONTEXT, msg);
      }
      this._micIntent = "running";
      this._aecFallbackUsed = false;

      // Interface contract: resolve when the first frame is emitted. Created
      // before the pipeline build so a D4 retry re-resolves the same promise.
      const firstFrame = new Promise((resolve) => {
        this._firstFrameResolve = resolve;
      });

      // D1+D4: open the mic, classify the scope, build the capture pipeline —
      // with the bounded ended-stream fallback (see _openMicAndBuildVad).
      // 2. Instantiate vad-web 0.0.31 with OUR stream (getStream override — the
      //    documented way to pass a stream; `stream` itself is not an option).
      //    Timeout-guarded: if the AudioWorklet path hangs (addModule never
      //    resolves — seen in automation Chromium, old Safari, webviews), retry
      //    with the documented ScriptProcessor legacy path.
      this.vad = await this._openMicAndBuildVad(vadLib);

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
    this._micIntent = "stopped"; // before stopping tracks — the ended guard must ignore this
    try {
      this.vad?.pause(); // default pauseStream stops the tracks
    } catch {
      /* already torn down */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this._track = null;
    this.vad = null;
    this._aecFallbackUsed = false;
    this.started = false;
    this.paused = false;
  }

  /**
   * Pause frame emission. vad-web's default pause stops the mic tracks; its
   * default resume creates a new stream with standard constraints — which
   * matched the boolean AEC defaults exactly (WP3/WP5). With the D1
   * `{ideal:"all"}` constraint the resumed stream is vad-web's own, so the
   * scope after a pause/resume cycle is NOT renegotiated in WP-E1 (recorded
   * as a known limitation). The mic-intent flag keeps the D4 ended guard from
   * misreading a deliberate pause as a track death.
   */
  pause() {
    if (this.started && !this.paused) {
      this.paused = true;
      this._micIntent = "paused"; // before vad.pause() — it stops the tracks
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
      this._micIntent = "running";
      try {
        this.vad?.start();
      } catch {
        /* noop */
      }
    }
  }
}
