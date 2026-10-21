/**
 * `SpeakOrNoSpeak` — the public facade (WP3 §3.5, master plan §4.1).
 *
 * Wires a {@link VadEngine} (default: Silero VAD adapter) to the pure
 * `TurnDetector` and exposes the five public members: `start`, `stop`,
 * `setAgentSpeaking`, `state`, `degraded`. Events: `onSpeechStart`,
 * `onTurnEnd`, `onInterrupt`, `onLevel`, `onError` (from options).
 *
 * ### Agent integration contract (rule 3 — read this, app authors!)
 * While your app produces audio output (TTS etc.), call
 * `setAgentSpeaking(true)`. While the flag is set, NO turn ends and NO
 * speech starts are emitted; instead, confirmed user speech triggers
 * `onInterrupt` (barge-in). You MUST call `setAgentSpeaking(false)` once
 * your output stops — a turn that already reached redemption flushes at
 * that moment. Forgetting to disarm permanently silences turn detection.
 *
 * @module speak-or-no-speak
 */

import { SileroVadAdapter } from "./vad/silero-vad-adapter.js";
import { EnergyVad } from "./vad/energy-vad.js";
import { TurnDetector } from "./turn/turn-detector.js";
import { DEFAULTS, mergeOptions } from "./config.js";
import { ERROR_CODES, SpeakError } from "./errors.js";

/** @typedef {import("./types.js").SpeakOrNoSpeakOptions} SpeakOrNoSpeakOptions */
/** @typedef {import("./types.js").SpeakOrNoSpeak} SpeakOrNoSpeak */
/** @typedef {import("./types.js").ModuleState} ModuleState */

/**
 * Async factory: merges options, constructs engine + detector, wires the
 * frame stream. Does NOT access the microphone — that happens in `start()`.
 *
 * @param {SpeakOrNoSpeakOptions} [options]
 * @returns {Promise<SpeakOrNoSpeak>}
 */
export async function createSpeakOrNoSpeak(options = {}) {
  const opts = mergeOptions(options, DEFAULTS);

  /** @type {import("./vad/vad-engine.js").VadEngine} */
  let engine = options.engine ?? new SileroVadAdapter({ mic: opts.mic });
  /** which engine is actually running (WP7 degradation ladder) */
  let engineKind = options.engine ? "custom" : "silero";
  const detector = new TurnDetector({
    thresholds: opts.thresholds,
    debug: opts.debug,
    turnModel: opts.turnModel, // WP8: optional semantic end-of-turn model
  });

  let started = false;

  /** Wire an engine's callbacks into detector + user options. @private */
  const wireEngine = (eng) => {
    eng.onFrame((frame) => {
      detector.onFrame(frame);
      if (typeof opts.onLevel === "function") opts.onLevel(frame.rms);
    });
    eng.onError((err) => opts.onError?.(err));
  };

  const api = {
    /**
     * Open the mic and start streaming frames into the detector.
     * Degradation ladder (WP7): Silero fails to load → energy engine takes
     * over (one-time `engine-fallback` warning, `degraded.engine = "energy"`).
     * Mic/permission/context failures are fatal (no fallback can help).
     * @returns {Promise<void>}
     */
    async start() {
      if (started) return;
      detector.onSpeechStart = () => opts.onSpeechStart?.();
      detector.onTurnEnd = (event) => opts.onTurnEnd?.(event);
      detector.onInterrupt = (info) => opts.onInterrupt?.(info);

      try {
        wireEngine(engine);
        await engine.start();
      } catch (err) {
        const code = err?.code ?? err?.message;
        const fallbackEligible = code === ERROR_CODES.ENGINE_LOAD_FAILED
          || code === ERROR_CODES.CDN_UNAVAILABLE
          || code === ERROR_CODES.AUDIO_PIPELINE;
        // Never hijack a deliberately injected engine unless an explicit
        // fallback engine was provided (test/advanced hook).
        const canFallback = options.engine == null || options.energyEngine != null;
        if (!fallbackEligible || !canFallback) throw err;

        // 7.1: degrade to the energy engine — flagged, never silent.
        try { engine.stop(); } catch { /* noop */ }
        opts.onError?.({ code: ERROR_CODES.ENGINE_FALLBACK, message: "Silero engine unavailable — switched to the energy-based fallback (degraded noise robustness)." });
        engine = options.energyEngine ?? new EnergyVad({ mic: opts.mic });
        engineKind = "energy";
        wireEngine(engine);
        await engine.start();
      }
      started = true;
      // WP5 §5.4: mic track without active echo cancellation → stricter
      // barge-in gating (more confirm frames + rms-vs-playback-baseline).
      detector.noAecMode = engine.aecDegraded === true;
    },

    /** Stop the engine and release the microphone. Idempotent. */
    stop() {
      if (!started) return;
      engine.stop();
      detector.reset();
      started = false;
    },

    /**
     * Arm/disarm barge-in detection while the agent talks (see contract above).
     * @param {boolean} active
     */
    setAgentSpeaking(active) {
      detector.setAgentSpeaking(active);
    },

    /**
     * Mirrors the detector state — authoritative, because discarded turns
     * (too-short speech) return to "ready" without emitting an event.
     * @returns {ModuleState}
     */
    get state() {
      return started ? detector.state : "idle";
    },

    /** @returns {{ aec: boolean, engine: "silero" | "energy" }} */
    get degraded() {
      return {
        aec: engine.aecDegraded ?? false,
        engine: engineKind === "energy" ? "energy" : "silero",
      };
    },

    /** exposed for tests/advanced tooling — not part of the stable API */
    get _detector() {
      return detector;
    },
    get _engine() {
      return engine;
    },
  };

  return api;
}
