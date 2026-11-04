/**
 * `TurnDetector` — the pure onset / turn-end / barge-in state machine
 * (WP3 core, endpointing refined in WP4).
 *
 * Model: one state (`"ready"` | `"listening"` | `"pause"`) × one boolean
 * `agentSpeaking` flag. `"pause"` is a SUB-state of listening: the turn is
 * still open, only the endpointing gets patient (master plan §4.2):
 *
 * | agentSpeaking | silence (≤ negative) | speech (≥ onset) | mid (between) |
 * |---|---|---|---|
 * | `false` | READY: count confirm frames → `onSpeechStart`. LISTENING: silence ≥ shortPauseMs → PAUSE; silence ≥ redemption → **turn end**. PAUSE: speech → LISTENING (turn continues); silence ≥ redemption → **turn end** | confirm / resume / accumulate | no state change (hysteresis) |
 * | `true`  | stay put; **no turn ends**; no speech-start events | count interrupt-confirm frames → **`onInterrupt`** → LISTENING (accumulation continues) | no state change |
 *
 * Key rules implemented (WP3 §3.4 + WP4):
 * 1. `finishTurn`: `speechMs < minSpeechMs` → discard silently; else emit
 *    `onTurnEnd({ audio, durationMs, truncated, afterInterrupt })`.
 *    **D-WP3-1:** `speechMs` INCLUDES the confirm-window speech — with v5's
 *    32 ms frames the confirm window is 288 ms of real speech; counting only
 *    post-confirm speech discarded real short commands live ("one" → green
 *    dot, no turn end). The plan's t02 discard semantics are preserved for
 *    genuinely short probability bursts (coughs): with defaults, any
 *    confirmed onset already carries ≥ 288 ms of counted speech, so
 *    `minSpeechMs` is a user-tunable second guard (e.g. smaller confirm).
 * 2. An interrupt NEVER emits `onSpeechStart` — it *is* the onset; the turn
 *    keeps accumulating and its end carries `afterInterrupt: true`.
 * 3. Agent flag contract lives in the facade/README: apps MUST call
 *    `setAgentSpeaking(false)` when their output ends; turn ends stay
 *    suppressed until then (a redemption-eligible turn flushes on disarm).
 * 4. Grace: for `graceAfterInterruptMs` after an interrupt, silence does not
 *    count toward redemption (avoids slicing the turn at "hey, sto—").
 * 5. `pause()/resume()` freeze accumulation without dropping the ring buffer.
 * 6. Every threshold comes from options — no hidden constants.
 * 7. WP4: the redemption window is ADAPTIVE — `redemptionFor()` derives it
 *    from the turn's rhythm stats (speechMs, interiorPauses, longestPauseMs)
 *    at every silence check; `thresholds.redemptionMs` is the BASE.
 *
 * Pure logic: no `window`/`document` access — unit-testable in Node (D1).
 *
 * @module turn-detector
 */

import { RingBuffer } from "./ring-buffer.js";
import { echoCorrelation } from "./echo-correlation.js";
import { DEFAULTS, mergeOptions } from "../config.js";

/** @typedef {import("../types.js").VadFrame} VadFrame */
/** @typedef {import("../types.js").Thresholds} Thresholds */

/**
 * Adaptive redemption window (WP4 §4.2).
 *
 * Patient when the user hesitates, snappy when they are fluent — the same
 * utterance rhythm humans use to decide "are they done?".
 *
 * @param {{speechMs: number, interiorPauses: number, longestPauseMs: number}} stats
 *   the CURRENT turn's rhythm stats
 * @param {number} [baseMs] the configured base window (thresholds.redemptionMs, 650)
 * @returns {number} redemption window in ms, clamped to [350, 1200]
 */
export function redemptionFor(stats, baseMs = DEFAULTS.thresholds.redemptionMs) {
  let ms = baseMs;                                                        // base
  if (stats.speechMs >= 2000 && stats.interiorPauses === 0) ms = baseMs - 200; // fluent long turn → snappy
  if (stats.interiorPauses >= 2 || stats.speechMs < 600) ms = baseMs + 200;    // hesitant turn → patient
  if (stats.longestPauseMs >= 800) ms = Math.max(ms, baseMs + 250);            // user pauses a lot
  return Math.min(1200, Math.max(350, ms));
}

/** Rolling rms baseline over the last second of agent-only playback (WP5 §5.4). */
class RmsBaseline {
  constructor(windowMs = 1000) {
    this.capacity = Math.max(1, Math.round(windowMs / 32)); // ~32 ms frames
    this.values = new Float32Array(this.capacity);
    this.pos = 0;
    this.filled = 0;
    this.sum = 0;
  }
  /** @param {number} rms */
  push(rms) {
    if (this.filled === this.capacity) this.sum -= this.values[this.pos];
    this.values[this.pos] = rms;
    this.sum += rms;
    this.pos = (this.pos + 1) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + 1);
  }
  /** mean rms of the window; 0 while it is still filling */
  mean() {
    return this.filled < Math.min(5, this.capacity) ? 0 : this.sum / this.filled;
  }
}

export class TurnDetector {
  /**
   * @param {Object} [options]
   * @param {Partial<Thresholds>} [options.thresholds]
   * @param {number} [options.sampleRate]   audio sample rate of frames (Hz)
   * @param {boolean} [options.debug]       record transition traces
   */
  constructor(options = {}) {
    const merged = mergeOptions(options, DEFAULTS);
    /** @type {Thresholds} */
    this.thresholds = { ...merged.thresholds, ...(options.thresholds ?? {}) };
    this.sampleRate = options.sampleRate ?? 16000;
    this.debug = options.debug ?? false;

    /** @type {"ready"|"listening"|"pause"} */
    this.state = "ready";
    this.agentSpeaking = false;

    this.confirm = 0;           // onset confirm counter (READY)
    this.confirmSpeechMs = 0;   // speech time inside the confirm window (D-WP3-1)
    this.pendingConfirmSpeechMs = 0; // confirm speech handed to a new turn at interrupt
    this.interruptConfirm = 0;  // barge-in confirm counter (agentSpeaking)
    this.silenceMs = 0;         // consecutive silence in current turn
    this.speechMs = 0;          // speech time in current turn (incl. confirm, D-WP3-1)
    this.turnMs = 0;            // total time in current turn (maxTurnMs guard)
    // WP4 rhythm stats (feed redemptionFor)
    this.interiorPauses = 0;    // PAUSE → LISTENING returns so far
    this.longestPauseMs = 0;    // longest interior pause so far
    this.agentSpeakingMs = 0;   // ms since the agent flag was armed (for atMs)
    this.graceRemainingMs = 0;  // post-interrupt grace countdown
    this.afterInterrupt = false;
    this.paused = false;
    /**
     * WP8: optional semantic end-of-turn model (`TurnModel` interface:
     * predictComplete(turnAudio) → Promise<boolean>). Runs ONLY at silence
     * points; redemption → evaluate → complete → emit, incomplete → the turn
     * continues. Fail-open on error/timeout (300 ms): the turn end emits.
     */
    this.turnModel = options.turnModel ?? null;
    /** @private model-evaluation state */
    this._evalPending = false;
    this._evalGeneration = 0;
    /**
     * WP5 §5.4: stricter barge-in gating without AEC. The facade sets this
     * from `engine.aecDegraded` after start(); apps may force it for testing.
     * Stricter = more confirm frames (≈ noAecBargeInConfirmMs) AND an rms
     * requirement (frame rms > noAecRmsFactor × rolling agent-playback mean).
     */
    this.noAecMode = false;
    /** @private rolling rms baseline while the agent flag is armed */
    this._rmsBaseline = new RmsBaseline(1000);
    /** @private audioMs timestamp of the first above-onset frame of the current confirm run */
    this._interruptVoiceAtMs = 0;

    /**
     * WP-E3 coherence echo gate (D9) — default OFF. Active only while the
     * agent flag is armed AND a reference is registered
     * (`pushEchoReference`); an echo-classified frame does not accumulate
     * interrupt-confirm. Un-probed frames inherit the last verdict.
     * @type {import("../types.js").EchoGateOptions}
     */
    this.echoGate = merged.echoGate;
    /** @private reference ring: (windowMs + maxDelayMs) worth of 16 kHz samples ≈ 12 k floats */
    this._echoRef = null;
    this._echoRefPos = 0;
    this._echoRefFill = 0;
    /** @private last probe verdict (inherited by un-probed frames) */
    this._echoVerdict = false;
    /** @private frame counter for the probe cadence */
    this._echoFrameCounter = 0;
    /** @private scratch buffer for the chronological reference read (allocated once) */
    this._echoScratch = null;

    /** @type {Float32Array|null} pre-speech + confirm-window audio, flushed at onset */
    this.pad = null;
    /** @type {Float32Array[]} turn audio frames accumulated while listening/pause */
    this.turnFrames = [];

    /** @type {RingBuffer|null} lazily sized on the first frame (needs frame duration) */
    this._ring = null;
    /** @private total audio time seen (debug traces) */
    this._audioMs = 0;
    /** @type {Array<{audioMs:number, event:string, detail?:number}>|null} debug transition traces */
    this.traces = this.debug ? [] : null;

    /** @type {(() => void)|null} */ this.onSpeechStart = null;
    /** @type {((e: import("../types.js").TurnEndEvent) => void) | null} */ this.onTurnEnd = null;
    /** @type {((info: import("../types.js").InterruptInfo) => void)|null} */ this.onInterrupt = null;
    /**
     * WP-E4: the voice gate's frame-level hook — a sync predicate consulted
     * in the armed branch (and in READY when suppressOnset is on). The gate
     * object exposes the LATEST rolling-window verdict (scoring runs async on
     * a cadence). Null = gate absent.
     * @type {{ isAgentVoice: (frame: VadFrame) => boolean }|null}
     */
    this._voiceGate = null;
  }

  /**
   * WP-E4: register the voice gate's frame-level hook (see 4.4 of the WP-E4
   * plan). The predicate must be sync and never throw (fail-open); it reads
   * the gate's latest rolling-window verdict.
   * @param {{ isAgentVoice: (frame: VadFrame) => boolean }|null} hooks
   */
  setVoiceGate(hooks) {
    this._voiceGate = hooks ?? null;
  }

  /**
   * Feed one frame. Audio is always buffered; probability drives the machine.
   * @param {VadFrame} f
   */
  onFrame(f) {
    if (this.paused) return;
    const T = this.thresholds;
    const durMs = f.durationMs;

    // Ring lazily sized to cover the pre-speech pad AND the whole onset
    // confirm window, so confirmed speech is never clipped (rule: pad is
    // `preSpeechPadMs` before the FIRST confirmed-speech sample).
    if (!this._ring) {
      const capacity = Math.ceil(
        ((T.preSpeechPadMs + T.onsetConfirmFrames * durMs) / 1000) * this.sampleRate
      );
      this._ring = new RingBuffer(capacity);
    }
    this._ring.push(f.frame);
    this._audioMs += durMs;

    // Grace countdown runs on every frame, flag or not (rule 4).
    if (this.graceRemainingMs > 0) {
      this.graceRemainingMs = Math.max(0, this.graceRemainingMs - durMs);
    }

    if (this.agentSpeaking) {
      this.agentSpeakingMs += durMs;
      // WP5 §5.4: baseline = rolling rms of agent-only playback — sampled
      // while no confirm run is in progress, so the user's voice never
      // pollutes the baseline.
      if (this.interruptConfirm === 0) this._rmsBaseline.push(f.rms);
      const baseline = this._rmsBaseline.mean();
      // Stricter gating without AEC: rms must exceed factor × playback mean
      // (the mean is 0 while the baseline fills → gate passes).
      const rmsGate = !this.noAecMode || f.rms > T.noAecRmsFactor * baseline;
      // WP-E3: echo-classified frames are NOT speech — they do not accumulate
      // interrupt-confirm (the rms gate stays orthogonal; either gate alone
      // can reject). Echo frames still feed the rolling baseline above — they
      // ARE playback.
      const echoHit = this.#echoGateVerdict(f);
      // WP-E4: agent-voice-similar frames (rolling-window verdict) are NOT
      // speech — same rejection semantics as the echo gate; either gate alone
      // can reject. The predicate is sync + fail-open (latest window verdict).
      const voiceHit = this._voiceGate ? (this._voiceGate.isAgentVoice?.(f) ?? false) : false;
      const speech = f.probability >= T.onsetSpeechThreshold && rmsGate && !echoHit && !voiceHit;
      const silent = f.probability <= T.negativeSpeechThreshold;
      const confirmNeed = this.noAecMode
        ? Math.max(T.bargeInConfirmFrames, Math.ceil(T.noAecBargeInConfirmMs / durMs))
        : T.bargeInConfirmFrames;
      if (speech) {
        if (this.interruptConfirm === 0) {
          // t_voice (5.2): start of the first above-onset frame, so that
          // latencyMs = confirmFrames × frameMs exactly.
          this._interruptVoiceAtMs = this._audioMs - durMs;
        }
        this.interruptConfirm++;
        this.confirmSpeechMs += durMs;
      } else if (silent) {
        this.interruptConfirm = Math.max(0, this.interruptConfirm - 1);
        if (this.interruptConfirm === 0) this.confirmSpeechMs = 0;
      }
      if (this.interruptConfirm >= confirmNeed) {
        const latencyMs = Math.round(this._audioMs - this._interruptVoiceAtMs); // t_event − t_voice
        this.interruptConfirm = 0;
        const transitioned = this.state !== "listening" && this.state !== "pause";
        if (transitioned) this.pendingConfirmSpeechMs = this.confirmSpeechMs;
        this.confirmSpeechMs = 0;
        this.#emitInterrupt({ latencyMs });
        // On the transition frame the audio is already inside the flushed
        // ring pad — pushing it again would duplicate it.
        if (!transitioned) {
          this.turnFrames.push(f.frame);
          this.turnMs += durMs;
        }
      } else if (this.state !== "ready") {
        // Accumulation continues while the agent speaks — but no turn ends
        // (matrix). A redemption-eligible turn flushes on disarm (rule 3).
        this.turnFrames.push(f.frame);
        this.turnMs += durMs;
        if (silent && this.graceRemainingMs <= 0) this.silenceMs += durMs;
        else if (!silent) { this.silenceMs = 0; this.speechMs += durMs; }
      }
      return;
    }

    switch (this.state) {
      case "ready": {
        // WP-E3 phase 2 (opt-in `suppressOnset`): reject echo in READY so
        // residual echo cannot start a turn un-armed. Default off — with a
        // working AEC reference (E2) the un-armed case is handled, and a
        // correlation false positive must never swallow real user speech.
        const echoHit = this.echoGate.suppressOnset ? this.#echoGateVerdict(f) : false;
        const voiceHit = this.echoGate.suppressOnset && this._voiceGate
          ? (this._voiceGate.isAgentVoice?.(f) ?? false)
          : false;
        if (f.probability >= T.onsetSpeechThreshold && !echoHit && !voiceHit) {
          this.confirm++;
          this.confirmSpeechMs += durMs;
        } else {
          this.confirm = 0;
          this.confirmSpeechMs = 0;
        }
        if (this.confirm >= T.onsetConfirmFrames) this.#enterListening();
        break;
      }
      case "listening": {
        this.turnFrames.push(f.frame);
        this.turnMs += durMs;
        if (f.probability <= T.negativeSpeechThreshold) {
          if (this.graceRemainingMs <= 0) {
            this.silenceMs += durMs;
            if (this.silenceMs >= redemptionFor(this.#rhythmStats(), T.redemptionMs)) {
              this.#finishTurnViaModel(); // TURN_CANDIDATE: model gate (or direct emit)
              break;
            }
            if (this.silenceMs >= T.shortPauseMs) this.#enterPause();
          }
        } else {
          // mid/speech frames count as speech continuation (hysteresis);
          // new speech cancels a pending model evaluation (WP8 §8.3) — the
          // next redemption re-runs it on the ENTIRE turn including new audio.
          if (this._evalPending) {
            this._evalGeneration++;
            this._evalPending = false;
            this.#trace("model-eval-cancelled");
          }
          this.silenceMs = 0;
          this.speechMs += durMs;
        }
        if (this.state !== "ready" && this.turnMs >= T.maxTurnMs) this.#finishTurn(true);
        break;
      }
      case "pause": {
        this.turnFrames.push(f.frame);
        this.turnMs += durMs;
        if (f.probability >= T.onsetSpeechThreshold) {
          // speech resumes: the interior pause is over — count it (rhythm stats)
          if (this._evalPending) {
            this._evalGeneration++;
            this._evalPending = false;
            this.#trace("model-eval-cancelled");
          }
          this.interiorPauses++;
          this.longestPauseMs = Math.max(this.longestPauseMs, this.silenceMs);
          this.silenceMs = 0;
          this.speechMs += durMs;
          this.state = "listening";
        } else if (f.probability <= T.negativeSpeechThreshold) {
          if (this.graceRemainingMs <= 0) {
            this.silenceMs += durMs;
            if (this.silenceMs >= redemptionFor(this.#rhythmStats(), T.redemptionMs)) {
              this.#finishTurnViaModel();
              break;
            }
          }
          // mid frames during a pause: hysteresis — stay in pause
        }
        if (this.state !== "ready" && this.turnMs >= T.maxTurnMs) this.#finishTurn(true);
        break;
      }
    }
  }

  /**
   * Arm/disarm barge-in detection. Disarming flushes a turn that already
   * reached redemption or maxTurn while the flag was set (rule 3).
   * @param {boolean} active
   */
  setAgentSpeaking(active) {
    const was = this.agentSpeaking;
    this.agentSpeaking = active;
    if (active && !was) {
      this.agentSpeakingMs = 0;
      this.interruptConfirm = 0;
    }
    if (!active && was && this.state !== "ready") {
      const T = this.thresholds;
      if (this.silenceMs >= redemptionFor(this.#rhythmStats(), T.redemptionMs) || this.turnMs >= T.maxTurnMs) {
        this.#finishTurn(false);
      }
    }
  }

  /** Freeze accumulation without dropping the ring buffer (rule 5). */
  pause() {
    this.paused = true;
  }

  /**
   * WP-E3: feed reference audio (the agent's render tap, via the facade's
   * `setAgentAudioReference`). Samples are resampled (box-average) to the
   * detector's rate and kept in a fixed-capacity ring of
   * `windowMs + maxDelayMs` (≈ 12 k floats at 16 kHz). Without a reference
   * feed the echo gate is a no-op — either signal alone is not enough (D9).
   * @param {Float32Array} samples  reference samples at `sourceSampleRate`
   * @param {number} [sourceSampleRate]  the tap's rate (default: detector rate)
   */
  pushEchoReference(samples, sourceSampleRate = this.sampleRate) {
    const g = this.echoGate;
    const cap = Math.ceil(((g.windowMs + g.maxDelayMs) / 1000) * this.sampleRate);
    if (!this._echoRef || this._echoRef.length !== cap) {
      this._echoRef = new Float32Array(cap);
      this._echoRefPos = 0;
      this._echoRefFill = 0;
    }
    const ratio = sourceSampleRate / this.sampleRate;
    if (ratio <= 1) {
      // same rate (or upsample-requested — treated as 1:1)
      this.#writeEchoRef(samples);
      return;
    }
    // box-average downsample, same math as the energy engine
    const groups = Math.floor(samples.length / ratio);
    for (let gr = 0; gr < groups; gr++) {
      const start = Math.floor(gr * ratio);
      const end = Math.min(samples.length, Math.floor((gr + 1) * ratio));
      let sum = 0;
      for (let i = start; i < end; i++) sum += samples[i];
      const v = sum / Math.max(1, end - start);
      this._echoRef[this._echoRefPos] = v;
      this._echoRefPos = (this._echoRefPos + 1) % cap;
      this._echoRefFill = Math.min(cap, this._echoRefFill + 1);
    }
  }

  /** @private write raw (already detector-rate) samples into the echo ring */
  #writeEchoRef(samples) {
    const cap = this._echoRef.length;
    for (let i = 0; i < samples.length; i++) {
      this._echoRef[this._echoRefPos] = samples[i];
      this._echoRefPos = (this._echoRefPos + 1) % cap;
      this._echoRefFill = Math.min(cap, this._echoRefFill + 1);
    }
  }

  /**
   * WP-E3: the echo verdict for this frame, honoring the probe cadence
   * (probe every `probeEveryFrames` frames; un-probed frames inherit the last
   * verdict — echo bursts are contiguous). Returns false whenever the gate is
   * off or no reference has been fed yet.
   * @private
   * @param {VadFrame} f
   * @returns {boolean} true = this frame is classified as echo
   */
  #echoGateVerdict(f) {
    const g = this.echoGate;
    if (!g.enabled) return false;
    this._echoFrameCounter++;
    const probe = (this._echoFrameCounter - 1) % g.probeEveryFrames === 0;
    if (!probe) return this._echoVerdict;
    if (!this._echoRef || this._echoRefFill < Math.ceil((g.windowMs / 1000) * this.sampleRate)) {
      this._echoVerdict = false; // reference still filling — no claim
      return false;
    }
    // chronological read into the reusable scratch buffer
    const cap = this._echoRef.length;
    if (!this._echoScratch || this._echoScratch.length !== cap) this._echoScratch = new Float32Array(cap);
    if (this._echoRefFill < cap) {
      this._echoScratch.set(this._echoRef.subarray(0, this._echoRefFill));
    } else {
      this._echoScratch.set(this._echoRef.subarray(this._echoRefPos), 0);
      this._echoScratch.set(this._echoRef.subarray(0, this._echoRefPos), cap - this._echoRefPos);
    }
    const { corr, delaySamples } = echoCorrelation(f.frame, this._echoScratch, {
      windowSamples: g.windowMs ? Math.ceil((g.windowMs / 1000) * this.sampleRate) : 250,
      maxDelaySamples: Math.ceil((g.maxDelayMs / 1000) * this.sampleRate),
      decimation: g.decimation,
      lagStride: g.lagStride,
    });
    this._echoVerdict = corr >= g.correlationThreshold;
    if (this._echoVerdict && this.traces) {
      this.traces.push({
        audioMs: Math.round(this._audioMs),
        event: "echo-gate-hit",
        detail: +corr.toFixed(3),
        corr: +corr.toFixed(3),
        delaySamples,
      });
      if (this.traces.length > 100) this.traces.shift();
    }
    return this._echoVerdict;
  }

  resume() {
    this.paused = false;
  }

  /** Reset all turn state (used on facade stop). */
  reset() {
    this.state = "ready";
    this.confirm = 0;
    this.confirmSpeechMs = 0;
    this.pendingConfirmSpeechMs = 0;
    this.interruptConfirm = 0;
    this.silenceMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
    this.interiorPauses = 0;
    this.longestPauseMs = 0;
    this.graceRemainingMs = 0;
    this.afterInterrupt = false;
    this.pad = null;
    this.turnFrames = [];
    this._evalPending = false;
    this._evalGeneration++;
    this._ring?.clear();
    // WP-E3: stale reference/verdict must not survive a stop/start cycle.
    this._echoVerdict = false;
    this._echoRefFill = 0;
    this._echoRefPos = 0;
  }

  /** @private current turn's rhythm stats for redemptionFor */
  #rhythmStats() {
    return {
      speechMs: this.speechMs,
      interiorPauses: this.interiorPauses,
      longestPauseMs: this.longestPauseMs,
    };
  }

  /** @private */
  #enterListening() {
    const T = this.thresholds;
    this.pad = this._ring.flush();
    this.turnFrames = [];
    this.state = "listening";
    this.confirm = 0;
    // speechMs includes the confirm-window speech: those frames ARE part of
    // the utterance (D-WP3-1). Without this, short real commands (< confirm
    // + 250 ms) were silently discarded and the demo indicator stuck green.
    this.speechMs = this.confirmSpeechMs;
    this.confirmSpeechMs = 0;
    this.silenceMs = 0;
    this.turnMs = 0;
    this.interiorPauses = 0;
    this.longestPauseMs = 0;
    this.afterInterrupt = false;
    this.#trace("onSpeechStart");
    this.onSpeechStart?.();
  }

  /** @private WP4: explicit interior-pause sub-state */
  #enterPause() {
    this.state = "pause";
    this.#trace("enterPause", this.silenceMs);
  }

  /**
   * Barge-in confirmed while the agent speaks. Never emits onSpeechStart
   * (rule 2); (re)starts turn accumulation from the ring pad.
   * @param {{latencyMs: number}} [measure] t_voice → t_event latency (WP5 §5.2)
   * @private
   */
  #emitInterrupt(measure = {}) {
    const T = this.thresholds;
    if (this.state !== "listening" && this.state !== "pause") {
      this.pad = this._ring.flush();
      this.turnFrames = [];
      this.state = "listening";
      this.speechMs = this.pendingConfirmSpeechMs; // D-WP3-1: confirm speech counts
      this.pendingConfirmSpeechMs = 0;
      this.silenceMs = 0;
      this.turnMs = 0;
      this.interiorPauses = 0;
      this.longestPauseMs = 0;
    } else {
      // resume from an interior pause into the interrupt turn
      if (this.state === "pause") {
        this.interiorPauses++;
        this.longestPauseMs = Math.max(this.longestPauseMs, this.silenceMs);
      }
      this.silenceMs = 0;
    }
    this.state = "listening";
    this.afterInterrupt = true;
    this.graceRemainingMs = T.graceAfterInterruptMs;
    this.#trace("onInterrupt", measure.latencyMs);
    this.onInterrupt?.({
      atMs: Math.round(this.agentSpeakingMs),
      latencyMs: measure.latencyMs ?? 0,
    });
  }

  /**
   * TURN_CANDIDATE step (WP8 §8.3): at redemption, consult the optional
   * semantic model. complete → emit; incomplete → the turn CONTINUES
   * (accumulation never stopped). Fail-open: timeout (300 ms) or a model
   * error → the turn end emits (the model must never block the flow).
   * Truncation and the agent-disarm flush bypass the model.
   * @param {boolean} [force]
   * @private
   */
  #finishTurnViaModel() {
    const T = this.thresholds;
    if (!this.turnModel || this._evalPending) {
      if (!this.turnModel) this.#finishTurn(false);
      return; // an evaluation is already pending — wait for it
    }
    const audioSnapshot = concatAudio(this.pad, this.turnFrames);
    const generation = this._evalGeneration;
    this._evalPending = true;
    this.#trace("model-eval-start", audioSnapshot.length);

    let settled = false;
    const settle = (complete) => {
      if (settled) return;
      settled = true;
      this._evalPending = false;
      if (this._evalGeneration !== generation) return; // cancelled by new speech
      if (complete) {
        this.#finishTurn(false);
      } else {
        // incomplete → the turn continues; reset the silence so the next
        // evaluation only runs after ANOTHER full redemption window
        // (bounds the evaluation cadence to ≈1/redemption window).
        this.silenceMs = 0;
        this.#trace("model-incomplete");
      }
    };

    const timeout = setTimeout(() => settle(true), T.modelTimeoutMs ?? 300);
    Promise.resolve(this.turnModel.predictComplete(audioSnapshot))
      .then((complete) => { clearTimeout(timeout); settle(Boolean(complete)); })
      .catch((err) => {
        clearTimeout(timeout);
        this.#trace("model-eval-error", String(err?.message ?? err));
        settle(true); // fail-open
      });
  }

  /**
   * End the current turn. Discards silently if the turn is too short to be
   * speech (rule 1); otherwise emits onTurnEnd with pad + accumulated audio.
   * @param {boolean} truncated
   * @private
   */
  #finishTurn(truncated) {
    this._evalPending = false;
    this._evalGeneration++;
    const T = this.thresholds;
    const wasAfterInterrupt = this.afterInterrupt;
    const speechMs = this.speechMs;
    // WP4: rhythm stats snapshot for the event (WP6 tuning input) — taken
    // BEFORE the reset below.
    const stats = {
      speechMs,
      interiorPauses: this.interiorPauses,
      longestPauseMs: this.longestPauseMs,
      turnMs: this.turnMs,
    };
    this.state = "ready";
    this.silenceMs = 0;
    this.speechMs = 0;
    this.turnMs = 0;
    this.interiorPauses = 0;
    this.longestPauseMs = 0;
    this.afterInterrupt = false;
    this.graceRemainingMs = 0;

    if (!truncated && speechMs < T.minSpeechMs) {
      this.pad = null;
      this.turnFrames = [];
      this.#trace("turn-discarded");
      return; // rule 1: no event
    }

    const audio = concatAudio(this.pad, this.turnFrames);
    this.pad = null;
    this.turnFrames = [];
    const event = {
      audio,
      durationMs: audio.length === 0 ? 0 : (audio.length / this.sampleRate) * 1000,
      truncated,
      afterInterrupt: wasAfterInterrupt,
      stats,
    };
    this.#trace("onTurnEnd", event.durationMs);
    this.onTurnEnd?.(event);
  }

  /** @private */
  #trace(event, detail) {
    if (!this.traces) return;
    this.traces.push({ audioMs: Math.round(this._audioMs), event, detail });
    if (this.traces.length > 100) this.traces.shift();
  }
}

/** @private */
function concatAudio(pad, frames) {
  const padLen = pad?.length ?? 0;
  let total = padLen;
  for (const f of frames) total += f.length;
  const out = new Float32Array(total);
  if (padLen) out.set(pad, 0);
  let off = padLen;
  for (const f of frames) {
    out.set(f, off);
    off += f.length;
  }
  return out;
}
