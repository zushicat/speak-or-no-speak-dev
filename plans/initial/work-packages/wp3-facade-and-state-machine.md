# WP3 — Facade + state machine (module core)

- **Status:** done (2026-10-20) — 26 unit tests green; live verified (streaming, AEC, green latency 277 ms, event flow); one semantic fix (D-WP3-1) proven by frame replay
- **Phase:** M2
- **Estimate:** 1 d
- **Depends on:** WP1 (engine streaming); WP2 (demo as verification surface)
- **Decisions applied:** D1 (plain JS + JSDoc types, unit-testable via `node --test`, zero deps)
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

The real module: `SpeakOrNoSpeak` facade + `TurnDetector` state machine that converts the frame-probability stream into the three events (`onSpeechStart`, `onTurnEnd`, `onInterrupt`). Pure logic — no `window`/`document` access — so it is unit-testable in Node with the built-in test runner. The demo (WP2) is refactored to use the facade and must behave identically afterwards.

## Deliverable files

```
src/types.js                # JSDoc typedefs = the typed contract
src/config.js               # defaults (§4.3 of master plan) + merge helper
src/turn/ring-buffer.js     # pre-speech pad ring buffer
src/turn/turn-detector.js   # state machine (pure)
src/speak-or-no-speak.js    # facade: lifecycle, engine wiring, agent flag
src/index.js                # public exports
test/unit/*.test.js         # node --test suite
```

## Steps

### 3.1 `src/types.js` — the contract (JSDoc `@typedef`s; D1 means no TS compile)

```js
/**
 * @typedef {Object} TurnEndEvent
 * @property {Float32Array} audio      16 kHz mono, includes pre-speech pad
 * @property {number} durationMs       speech + pad duration
 * @property {boolean} truncated       true if maxTurnMs force-ended the turn
 * @property {boolean} afterInterrupt  true if this turn started with a barge-in
 */

/**
 * @typedef {Object} InterruptInfo
 * @property {number} atMs             ms since agent-speaking mode armed
 */

/**
 * @typedef {"idle"|"ready"|"listening"} ModuleState
 *   ("agentSpeaking" is a *flag*, not a state — see behavior matrix below)
 *
 * @typedef {Object} Thresholds  (defaults in src/config.js)
 * @property {number} onsetSpeechThreshold     0.6
 * @property {number} negativeSpeechThreshold  0.35
 * @property {number} onsetConfirmFrames       3
 * @property {number} minSpeechMs              250
 * @property {number} redemptionMs             650   (adaptive from WP4)
 * @property {number} preSpeechPadMs           200
 * @property {number} bargeInConfirmFrames     2     (~150–190 ms at 96 ms frames)
 * @property {number} maxTurnMs                30000
 */
```

### 3.2 `src/config.js`

- `DEFAULTS` object holding exactly the values above, each with a one-line JSDoc purpose comment (traceable to master plan §4.3).
- `mergeOptions(user, defaults)` — shallow-with-nested-merge, no dependencies (~20 lines).
- **No `window` access** (config is used in Node tests).

### 3.3 `src/turn/ring-buffer.js`

- Fixed-capacity `Float32Array` ring sized `preSpeechPadMs * sampleRate / 1000` (= 3200 samples @16 kHz for 200 ms).
- API: `push(frame)`, `flush()` (returns accumulated pad and resets), `clear()`.
- Used to (a) not clip word onsets and (b) feed the turn buffer at onset.

### 3.4 `src/turn/turn-detector.js` — state machine

**Model:** one `state` ∈ {`READY`, `LISTENING`} + one boolean flag `agentSpeaking`. Effective behavior = state × flag:

| agentSpeaking | silence (prob ≤ negative) | speech (prob ≥ onset) | mid (in-between) |
|---|---|---|---|
| `false` | READY: count confirm frames → at `onsetConfirmFrames` → LISTENING + `onSpeechStart`. LISTENING: accumulate; silence ≥ redemption → **turn end** | progress confirm / reset silence | no state change (hysteresis) |
| `true` | stay put; **no turn ends**; no speech-start events | count interrupt-confirm frames → at `bargeInConfirmFrames` → **`onInterrupt`** → state=LISTENING (turn accumulation continues) | no state change |

Core loop pseudocode (implement as real code):

```js
onFrame(f) {
  if (paused) return;
  this.ring.push(f.frame);           // audio always buffered (cheap)
  const speech = f.probability >= T.onsetSpeechThreshold;
  const silent = f.probability <= T.negativeSpeechThreshold;

  if (this.agentSpeaking) {
    if (speech) this.interruptConfirm++;
    else if (silent) this.interruptConfirm = Math.max(0, this.interruptConfirm - 1);
    if (this.interruptConfirm >= T.bargeInConfirmFrames) {
      this.interruptConfirm = 0;
      this.emitInterrupt();            // → state stays/enters LISTENING, accumulation continues
    }
    return;                            // NO turn ends, NO speech starts while agent speaks
  }

  switch (this.state) {
    case READY:
      this.confirm = speech ? this.confirm + 1 : 0;
      if (this.confirm >= T.onsetConfirmFrames) this.enterListening();
      break;
    case LISTENING:
      if (silent) { this.silenceMs += f.durationMs; if (this.silenceMs >= T.redemptionMs) this.finishTurn(); }
      else        { this.silenceMs = 0; this.speechMs += f.durationMs; }
      break;
  }
}
```

Key rules to implement exactly:

1. **`finishTurn()`** (v1, no turn model): if `speechMs < minSpeechMs` → discard silently (no event), back to READY. Else emit `onTurnEnd({ audio, durationMs, truncated:false, afterInterrupt })` where `audio` = ring-pad + accumulated turn frames; state → READY.
2. **Interrupt does not emit `onSpeechStart`** — the interrupt event *is* the onset while the agent speaks. After an interrupt, state = LISTENING and the utterance keeps accumulating; the next turn end carries it (`afterInterrupt: true`).
3. **Agent flag contract:** the app must call `setAgentSpeaking(false)` once it stopped producing output. Until then, turn ends stay suppressed (document in README §Agent integration — app authors will get this wrong otherwise).
4. **Grace after interrupt:** for 500 ms post-interrupt, silence does not count toward redemption (avoids slicing a turn at "hey, sto—"). Implement as a timestamp check in `finishTurn()`/silence accumulation.
5. `pause()/resume()` freeze accumulation without dropping the ring buffer.
6. Every option is honored; no hidden constants.

### 3.5 `src/speak-or-no-speak.js` — facade

- `createSpeakOrNoSpeak(options)` async factory: merges options → constructs engine (WP1 adapter) + detector → wires `engine.onFrame` → `detector.onFrame`, `engine.onError` → `onError`.
- Public API exactly per master plan §4.1: `start/stop/setAgentSpeaking/state/degraded`.
- `setAgentSpeaking(true|false)` → sets flag, updates `state` getter, no other side effects.
- Keeps the engine's raw frame callback available internally for `onLevel`.

### 3.6 Unit tests (`node --test`, no test framework installed)

`test/unit/*.test.js` — each test feeds synthetic `VadFrame` sequences (prob + rms + frame samples) into a bare `TurnDetector` and asserts emitted events:

| # | Case | Assertion |
|---|---|---|
| t01 | 2 noisy frames then silence | no `onSpeechStart` (confirm needs 3) |
| t02 | 3 speech frames (≈ 288 ms) then silence → redemption | `speechMs < minSpeechMs` → **no** `onTurnEnd` |
| t03 | 20 speech frames, then 8 silence frames | one `onTurnEnd`, audio length ≈ (20+8)·1536 + pad, `durationMs` plausible |
| t04 | interior pause of 4 silence frames mid-turn | turn **not** ended, continues (full pause logic lands in WP4) |
| t05 | agent flag + 3 speech frames | exactly one `onInterrupt`, zero `onSpeechStart`, zero `onTurnEnd` |
| t06 | agent flag + long silence | zero events |
| t07 | interrupt then turn end while flag still set | turn end suppressed; fires only after `setAgentSpeaking(false)` |
| t08 | probabilities hovering between thresholds | no confirm progress, no silence progress (hysteresis) |
| t09 | onset after speech | ring buffer flush yields ≥ 200 ms of pre-speech audio |
| t10 | user options override every default | merged values in effect |

Run: `npm test` → `node --test test/unit/`.

### 3.7 Demo refactor

`demo/main.js` drops its naive heuristic and consumes the facade. WP2's acceptance checks must still pass unchanged (same colors, same latencies) — this is the regression gate.

## Acceptance criteria

- [x] `npm test` green with **26 cases** (t01–t12 detector + t13/t13b facade wiring + ring-buffer + config suites).
- [x] Demo consumes the facade (`demo/main.js` = UI mapping only, zero detection logic); WP2 colors/latency verified live (green flip 277–279 ms ≤ 300 ms bar; identical visual behavior).
- [x] `turn-detector.js`, `ring-buffer.js`, `config.js` import cleanly in Node (no `window`/`document` references — verified by the suites themselves running in Node).
- [x] Public API is JSDoc-complete (`src/types.js`); `src/index.js` is the only export surface.
- [x] Interrupt path does not emit `onSpeechStart`/`onTurnEnd` (t05, t07), grace-after-interrupt covered (t11).

## Results & deviations (fill-in from implementation)

| # | Finding | Resolution |
|---|---|---|
| D-WP3-1 | **Confirm-window speech must count toward `speechMs`.** With v5's 32 ms frames the confirm window is 288 ms of real speech; the plan's t02 formulation (post-confirm speech only, calibrated for 96 ms frames) silently discarded real short commands live — observed twice: dot went green, no `onTurnEnd`, stuck green. Offline replay of the recorded live frames reproduced it exactly (5 × `turn-discarded`). | `speechMs` now includes confirm-window speech (detector header documents D-WP3-1). Replay after fix: same frames → 5 complete `onTurnEnd`s (dur ≈ 1.2 s). All 26 tests still pass; t02's cough-discard semantics preserved (3 frames = 96 ms < 250 ms). With defaults, `minSpeechMs` becomes a second guard relevant for custom configs (e.g. smaller `onsetConfirmFrames`). |
| D-WP3-2 | Plan's frame-count thresholds (3 / 2) assume 96 ms frames. | Recalibrated defaults: `onsetConfirmFrames` 9 (288 ms), `bargeInConfirmFrames` 6 (≈192 ms) — same wall-clock windows at v5 rate (WP1 D-WP1-1); master plan §4.3 annotated. |
| D-WP3-3 | Ring sized only `preSpeechPadMs` would clip the confirmed onset frames (confirm window 288 ms > pad 200 ms). | Ring capacity = `preSpeechPadMs + onsetConfirmFrames × frameDuration`, lazily sized from the first frame's `durationMs`; t09 asserts ≥ 200 ms pre-speech pad. |
| D-WP3-4 | Facade `state` must mirror the *detector*, not the events. | Discarded turns return to "ready" without emitting `onTurnEnd`; the `state` getter reads `detector.state` directly. |
| D-WP3-5 | Facade needs an injectable engine for Node tests. | `options.engine` (any `VadEngine`) — mock-engine test t13/t13b proves lifecycle/state/events/agent-flag wiring without a browser. |

### Live verification log (2026-10-20, ego-browser Chromium 154)

1. Node: 26/26 tests green (`node --test`, zero test deps).
2. Live speech round A/B: streaming ✓ (31.2 Hz), AEC on ✓, green latency 277–279 ms ✓, 0 uncaught exceptions; short utterances wrongly discarded → **D-WP3-1 found and fixed**.
3. Replay proof: recorded live frames (6333) → before fix 5 discards / after fix 5 turns (dur 1.16–1.32 s).
4. Final live re-check of the dot cycling orange→green→orange after short commands: **pending** (last round had no speech at the mic — max prob 0.028); the demo page remains open for a quick manual pass.

## Risks

| Risk | Mitigation |
|---|---|
| vad-web doesn't pass raw frames (WP1 verification) | Fallback: turn audio from vad-web's `onSpeechEnd` segment; state machine timing unaffected (probabilities only) — document in WP1 results |
| Frame duration drift (audio clock vs. wall clock) | Use frame count × nominal duration; calibrate absolute latencies in WP6 against wall-clock timestamps |
| Threshold interplay confusing to debug | Detector optionally logs transition traces (behind `debug: true` option) |

## Deliverables

- Module core + test suite + refactored demo; updated master-plan traceability (§4.2 table matches implementation).
