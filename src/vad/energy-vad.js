/**
 * `EnergyVad` — the degraded fallback engine (WP7 §7.1).
 *
 * Same `VadEngine` interface as the Silero adapter, but pure signal
 * processing: RMS vs an adaptive noise floor (slow exponential min-tracker).
 * By contract this mode is *degraded* — noise-blind compared to Silero — and
 * never chosen silently: the facade flips to it only on `engine-load-failed`
 * and reports `degraded.engine = "energy"` + a one-time `engine-fallback`
 * warning.
 *
 * Pipeline (worklet-free on purpose — `audioWorklet.addModule` can hang,
 * see WP1 D-WP1-5): getUserMedia → AudioContext → ScriptProcessor(4096) →
 * rate-adaptive downsample to 16 kHz → 512-sample frames → probability.
 *
 * Probability model (plan §7.1, from analysis §3 A):
 *     noiseFloor = min(noiseFloor × 1.0005 + 1e-6, rms)   // slow rise, fast drop
 *     probability = clamp((rms − noiseFloor·3.2) / (noiseFloor·3.2), 0, 1)
 *     rms < 0.005 → probability = 0                        // absolute floor
 *
 * @module energy-vad
 */

import { VadEngine } from "./vad-engine.js";
import { DEFAULTS, mergeOptions } from "../config.js";
import { ERROR_CODES, SpeakError, humanMessage } from "../errors.js";

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 512;
const ABS_FLOOR = 0.005;
const RISE_FACTOR = 1.0005;
const RISE_EPS = 1e-6;
const SPEECH_RATIO = 3.2;

/** Pure probability computation (unit-testable without a mic). */
export function energyProbability(rms, noiseFloor) {
  if (rms < ABS_FLOOR) return 0;
  const ref = noiseFloor * SPEECH_RATIO;
  if (ref <= 0) return rms > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, (rms - ref) / ref));
}

export class EnergyVad extends VadEngine {
  /**
   * @param {Object} [options]
   * @param {MediaTrackConstraints} [options.mic]
   */
  constructor(options = {}) {
    super();
    const merged = mergeOptions(options, DEFAULTS);
    this.micConstraints = { ...merged.mic, ...(options.mic ?? {}) };
    /** @type {FrameCallback[]} */ this.frameCallbacks = [];
    /** @type {ErrorCallback[]} */ this.errorCallbacks = [];
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.sourceNode = null;
    this.started = false;
    this.paused = false;
    this.noiseFloor = 0.001; // initial guess; adapts within ~1 s
    this._inBuf = new Float32Array(0);
    this._frameBuf = new Float32Array(FRAME_SAMPLES);
    this._frameFill = 0;
  }

  /** @param {FrameCallback} cb */
  onFrame(cb) { this.frameCallbacks.push(cb); }

  /** @param {ErrorCallback} cb */
  onError(cb) { this.errorCallbacks.push(cb); }

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
   * Open the mic and start the pump. Throws SpeakError on failure.
   * @returns {Promise<void>}
   */
  async start() {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      this._emitError(ERROR_CODES.INSECURE_CONTEXT, humanMessage(ERROR_CODES.INSECURE_CONTEXT));
      throw new SpeakError(ERROR_CODES.INSECURE_CONTEXT, "EnergyVad requires a browser environment.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this._emitError(ERROR_CODES.INSECURE_CONTEXT, humanMessage(ERROR_CODES.INSECURE_CONTEXT));
      throw new SpeakError(ERROR_CODES.INSECURE_CONTEXT, "mediaDevices unavailable (insecure context?)");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints });
      const track = this.stream.getAudioTracks()[0];
      const settings = track.getSettings();
      if (settings.echoCancellation !== true) {
        this.aecDegraded = true;
        this._emitError(ERROR_CODES.NO_AEC, humanMessage(ERROR_CODES.NO_AEC));
      }
      this.ctx = new AudioContext();
      await this.ctx.resume();
      this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessor: deprecated but universally supported and immune to
      // the AudioWorklet module-load hang (WP1 D-WP1-5).
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => this._handleAudioChunk(e.inputBuffer.getChannelData(0));
      // keep the node alive: ScriptProcessor needs a connected destination
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.sourceNode.connect(this.node);
      this.node.connect(sink);
      sink.connect(this.ctx.destination);
      this.started = true;
    } catch (err) {
      if (err instanceof SpeakError) throw err;
      if (err?.name === "NotAllowedError") {
        this._emitError(ERROR_CODES.MIC_DENIED, humanMessage(ERROR_CODES.MIC_DENIED));
        throw new SpeakError(ERROR_CODES.MIC_DENIED, "getUserMedia denied", err);
      }
      if (err?.name === "NotFoundError") {
        this._emitError(ERROR_CODES.MIC_NOT_FOUND, humanMessage(ERROR_CODES.MIC_NOT_FOUND));
        throw new SpeakError(ERROR_CODES.MIC_NOT_FOUND, "no mic", err);
      }
      this._emitError(ERROR_CODES.AUDIO_PIPELINE, `EnergyVad start failed: ${err?.message ?? err}`);
      throw new SpeakError(ERROR_CODES.AUDIO_PIPELINE, "EnergyVad start failed", err);
    }
  }

  /**
   * Feed one raw audio chunk (ctx-rate mono). Internal, public for tests:
   * downsample → 512-sample frames → probability → onFrame.
   * @param {Float32Array} chunk
   */
  _handleAudioChunk(chunk) {
    if (!this.started) return;
    // append to the leftover buffer
    const total = this._inBuf.length + chunk.length;
    const buf = new Float32Array(total);
    buf.set(this._inBuf, 0);
    buf.set(chunk, this._inBuf.length);

    const ratio = (this.ctx?.sampleRate ?? 48000) / TARGET_RATE;
    const groups = Math.floor(total / ratio);
    const used = Math.floor(groups * ratio);
    // downsample: box-average each ratio-sized group
    for (let g = 0; g < groups; g++) {
      const start = Math.floor(g * ratio);
      const end = Math.min(total, Math.floor((g + 1) * ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += buf[i];
      const sample = sum / Math.max(1, end - start);
      this._frameBuf[this._frameFill++] = sample;
      if (this._frameFill === FRAME_SAMPLES) {
        this._frameFill = 0;
        this._emitResampledFrame(this._frameBuf);
      }
    }
    this._inBuf = buf.slice(used);
  }

  /** @private */
  _emitResampledFrame(samples) {
    const frame = samples.slice();
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    // noise-floor tracker: slow rise, immediate drop (plan §7.1)
    this.noiseFloor = Math.min(this.noiseFloor * RISE_FACTOR + RISE_EPS, rms);
    const probability = energyProbability(rms, this.noiseFloor);
    if (!this.paused) {
      this._emitFrame({
        probability,
        frame,
        rms,
        durationMs: (frame.length / TARGET_RATE) * 1000, // 32 ms
      });
    }
  }

  /** Stop the engine and release the microphone. */
  stop() {
    try {
      this.node && (this.node.onaudioprocess = null, this.node.disconnect());
      this.sourceNode?.disconnect();
    } catch { /* already torn down */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    try {
      this.ctx?.close();
    } catch { /* noop */ }
    this.node = null;
    this.sourceNode = null;
    this.stream = null;
    this.ctx = null;
    this.started = false;
    this.paused = false;
  }

  /** Pause: mute the track (pipeline stays warm; silent frames → prob 0). */
  pause() {
    if (this.started && !this.paused) {
      this.paused = true;
      this.stream?.getAudioTracks().forEach((t) => { t.enabled = false; });
    }
  }

  resume() {
    if (this.started && this.paused) {
      this.paused = false;
      this.stream?.getAudioTracks().forEach((t) => { t.enabled = true; });
    }
  }
}
