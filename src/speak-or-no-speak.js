/**
 * `SpeakOrNoSpeak` — the public facade (WP3 §3.5, master plan §4.1).
 *
 * Wires a {@link VadEngine} (default: Silero VAD adapter) to the pure
 * `TurnDetector` and exposes the public members: `start`, `stop`,
 * `setAgentSpeaking`, `setAgentAudioRouted`, `state`, `degraded`. Events:
 * `onSpeechStart`, `onTurnEnd`, `onInterrupt`, `onLevel`, `onError` (from
 * options).
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
import { AEC_SCOPE, strictGatingActive } from "./vad/aec-scope.js";
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
  /**
   * D5/D6: the app declares "my agent audio plays through a cancelable route"
   * (see `setAgentAudioRouted`). Feeds the stricter-gating rule; reset on stop().
   */
  let agentAudioRouted = false;

  /**
   * The engine's honest AEC scope (WP-E1). Engines that carry `aecScope`
   * (Silero adapter + energy engine, post WP-E1) report it directly; injected
   * legacy engines without it report "unknown" — we cannot verify what they
   * cancel, and D3/D5 make "unknown" the safe default.
   * @private
   */
  const scopeOf = (eng) => {
    if (eng && typeof eng.aecScope === "string") return eng.aecScope;
    return AEC_SCOPE.UNKNOWN;
  };

  /**
   * Apply the D5 stricter-gating rule to the detector (WP-E1 §1.5.3).
   * Engines without `aecScope` keep the WP5 back-compat rule
   * (`aecDegraded === true`) so injected custom engines behave unchanged.
   * @private
   */
  const applyNoAecMode = () => {
    if (engine && typeof engine.aecScope === "string") {
      detector.noAecMode = strictGatingActive(
        engine.aecScope,
        agentAudioRouted,
        opts.strictGating
      );
    } else {
      detector.noAecMode = engine?.aecDegraded === true;
    }
  };

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
      // WP-E1 D5 (replaces the WP5 §5.4 plain `engine.aecDegraded` read): the
      // mic's honest AEC scope × the agent-audio route × the strictGating
      // option decide whether the detector runs its stricter barge-in gating
      // (more confirm frames + rms-vs-playback-baseline).
      applyNoAecMode();
    },

    /** Stop the engine and release the microphone. Idempotent. */
    stop() {
      if (!started) return;
      engine.stop();
      detector.reset();
      started = false;
      // D5: the route declaration is per-session — a fresh start re-applies it.
      agentAudioRouted = false;
    },

    /**
     * Arm/disarm barge-in detection while the agent talks (see contract above).
     * @param {boolean} active
     */
    setAgentSpeaking(active) {
      detector.setAgentSpeaking(active);
    },

    /**
     * WP-E1 D5/D6: declare whether the app's agent audio currently plays
     * through a cancelable route (`createAgentAudioRoute()` — WP-E2). While a
     * route is active, "unknown"/"remote-only" scopes no longer force the
     * stricter barge-in gating (Chromium's AEC then has a real reference).
     * Reset by `stop()`.
     * @param {boolean} active
     */
    setAgentAudioRouted(active) {
      agentAudioRouted = active === true;
      if (started) applyNoAecMode();
    },

    /**
     * Mirrors the detector state — authoritative, because discarded turns
     * (too-short speech) return to "ready" without emitting an event.
     * @returns {ModuleState}
     */
    get state() {
      return started ? detector.state : "idle";
    },

    /**
     * Degrade report (WP-E1 D2): `aec` keeps its meaning (true = no usable
     * cancellation = scope "none") for back-compat; `aecScope` is the honest
     * scope label ("all" | "remote-only" | "unknown" | "none").
     * @returns {{ aec: boolean, engine: "silero" | "energy", aecScope: import("./types.js").AecScope }}
     */
    get degraded() {
      return {
        aec: engine.aecDegraded ?? false,
        engine: engineKind === "energy" ? "energy" : "silero",
        aecScope: scopeOf(engine),
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
