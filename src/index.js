/**
 * Public export surface of `speak-or-no-speak` — the ONLY module consumers
 * should import from (D4 package `speak-or-no-speak`).
 *
 * @module index
 */

/** The facade: `createSpeakOrNoSpeak(options)` → start/stop/setAgentSpeaking/state/degraded. */
export { createSpeakOrNoSpeak } from "./speak-or-no-speak.js";

/** Default Silero VAD engine adapter + energy fallback (advanced use). */
export { SileroVadAdapter } from "./vad/silero-vad-adapter.js";
export { EnergyVad, energyProbability } from "./vad/energy-vad.js";

/** Error taxonomy: SpeakError, stable codes, human-readable messages. */
export { SpeakError, ERROR_CODES, humanMessage } from "./errors.js";

/** WP8 (optional): semantic end-of-turn model (8 MB ONNX asset — see README). */
export { SmartTurnModel } from "./turn-model/smart-turn.js";

/** WP9: STT plug point — the interface + the shipped example adapter. */
export { SttAdapter } from "./stt/stt-adapter.js";
export { CloudStubAdapter } from "./stt/cloud-stub-adapter.js";

/** Pure turn state machine + adaptive redemption policy (advanced use / unit testing). */
export { TurnDetector, redemptionFor } from "./turn/turn-detector.js";

/** Turn audio → 16-bit PCM WAV (demo "save last turn", WP6 replay fixtures). */
export { encodeWav, encodeWavBytes } from "./wav-export.js";

/** Defaults + merge helper (advanced use). */
export { DEFAULTS, mergeOptions } from "./config.js";
