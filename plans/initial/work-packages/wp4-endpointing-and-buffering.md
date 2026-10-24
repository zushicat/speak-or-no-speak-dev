# WP4 — Endpointing refinement + turn audio quality

- **Status:** done (2026-10-20) — 41/41 unit tests green (15 new); adaptive redemption + PAUSE live in the detector; WAV export wired into the demo; live manual protocol pending a user round
- **Phase:** M2
- **Estimate:** 1 d
- **Depends on:** WP3
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

Make S2 ("is the sentence done?") behave like a human listener: short thinking pauses must not end the turn, hesitant speech gets longer grace, fluent speech gets snappier response — and `onTurnEnd` audio must be complete and unclipped (pre-speech pad, correct length, exportable for listening).

## Steps

### 4.1 Explicit PAUSE sub-state (interior pauses)

Replace the flat "silenceMs accumulation" in LISTENING with an explicit sub-state so pause logic is readable and testable:

```
LISTENING ── silence ≥ shortPauseMs (250) ──► PAUSE
PAUSE     ── speech                    ──► LISTENING   (turn continues; silenceMs=0)
PAUSE     ── silence ≥ redemptionMs    ──► finishTurn()
LISTENING ── silence ≥ redemptionMs    ──► finishTurn()   (silence that never paused)
```

- Interior pauses **shorter** than `redemptionMs` never end the turn; they only cost "rhythm" statistics used by 4.2.
- Update the state table in the master plan §4.2 with the PAUSE row.
- New unit tests: pause of ~350 ms mid-utterance → turn continues; pause ≥ redemption → turn ends.

### 4.2 Adaptive redemption window

Pure function, unit-tested:

```js
/**
 * @param {{speechMs:number, interiorPauses:number, longestPauseMs:number}} stats
 * @returns {number} redemption window in ms
 */
function redemptionFor(stats) {
  let ms = 650;                                    // base
  if (stats.speechMs >= 2000 && stats.interiorPauses === 0) ms = 450; // fluent long turn → snappy
  if (stats.interiorPauses >= 2 || stats.speechMs < 600) ms = 850;    // hesitant turn → patient
  if (stats.longestPauseMs >= 800) ms = Math.max(ms, 900);            // user pauses a lot
  return clamp(ms, 350, 1200);
}
```

- Computed at each silence-check from the current turn's stats.
- Rationale comments inline (traceable to analysis §5 "adaptive length" and calibration in WP6).
- Unit tests for each branch + clamping.

### 4.3 Pre-speech pad verification

- Ring buffer (WP3) flush at onset must contribute ~200 ms of audio **before** the confirmed onset.
- Listening test: export the turn (4.5) and confirm the first word is intact (no "…o" instead of "go").

### 4.4 Max turn length

- `maxTurnMs` (30 s): force `finishTurn({ truncated: true })` — protects memory and gives the app a defined cutoff for long monologues. Test included.

### 4.5 `test/util/wav-export.js` — zero-dependency WAV encoder

- `encodeWav(Float32Array samples, sampleRate=16000) → Blob` (browser) / `Buffer` (Node) — 16-bit PCM WAV header + data (~30 lines, well-documented).
- Demo gains a small "save last turn" link: `onTurnEnd` audio → downloadable `.wav`. This is the primary debugging tool for onset clipping, pad length, and later calibration listening.

### 4.6 Manual protocol

The utterance matrix and its recorded results live in the
["Manual protocol" results table](#manual-protocol-record-results-here) below (filled during implementation).

## Acceptance criteria

- [x] Utterance-with-pauses produces a single turn end (p01); single word ends promptly — **see D-WP4-2 below**.
- [x] `redemptionFor()` unit-tested per branch (r01–r06: base, fluent, hesitant ×2, long-pause, precedence, clamping) + PAUSE transitions tested (p01–p05: enter, resume, end-from-pause, adaptive timing, mid-hysteresis) + WAV encoder (header/PCM/clamp/sample-rate) + facade pause-state mapping (t13 covers state mirroring; "pause" maps to public "listening").
- [x] Exported WAVs: encoder verified byte-level (RIFF/fmt/data, PCM round-trip incl. clamping, 48 kHz header); demo exposes "Save last turn (.wav)"; **ear-check of a real turn pending the user round**.
- [x] Truncation case works and is flagged (t12: `truncated: true`, then re-arms; second turn ends normally by redemption).
- [x] Master plan §4.2 updated with the PAUSE row (adaptive redemption noted).

## Results & deviations

| # | Finding | Resolution |
|---|---|---|
| D-WP4-1 | `wav-export.js` was planned for `test/util/`, but the demo imports it **in the browser** — and a `test/`-placed module cannot drag `node:test` imports into a page. Also, Node's test runner auto-executes any `.js` under `test/`. | Encoder lives in `src/wav-export.js` (apps can export turns too); its tests in `test/util/wav-export.test.js`. |
| D-WP4-2 | **Adaptive "hesitant" rule vs the plan's own "go < 0.8 s" protocol bar conflict:** a single word has `speechMs < 600` → hesitant window = 850 ms → turn end ≈ 0.85–0.9 s after the word — over the 0.8 s bar. | Implemented the plan's function literally (it is the specified policy; WP6 tunes from data before values freeze — see Risks). Flagged for WP6: consider splitting "short single-word turn" (snappy) from "hesitant mid-utterance" (patient). |
| D-WP4-3 | Tiny `redemptionMs` option values (e.g. 64 in fast tests) hit the clamp floor: hesitant → base+200 → clamped to 350. | Documented behavior: effective window ∈ [350, 1200] regardless of base; tests adjusted. |
| D-WP4-4 | `TurnEndEvent` now carries `stats` (`speechMs`, `interiorPauses`, `longestPauseMs`, `turnMs`) — the rhythm snapshot taken before the state reset. | Extension of the event payload (WP6 tuning input; needed to make pause stats assertable/testable at all). |

## Manual protocol (record results here)

| Utterance | Expected | Result |
|---|---|---|
| "okay … (2 s pause) … hmm, let me think … go" | exactly **one** `onTurnEnd`, fired after "go", `durationMs` covers whole utterance | pending live pass (unit-proven by p01/p04: interior pauses keep the turn open) |
| "go" (single word) | `onTurnEnd` < 0.8 s after the word | pending live pass — expected ≈ 0.85–0.9 s per D-WP4-2 |
| "one two three (pause 0.3 s) four five" | one turn, pause counted as interior | pending live pass (unit-proven by p01/p03) |
| 35 s continuous monologue | turn end at ~30 s with `truncated: true` | ✅ unit-verified (t12) — live 35 s monologue impractical in automation |
| Exported wav of a short command | first word intact, ~200 ms leading pad | pending live pass — encoder byte-verified; pad logic unit-proven (t09) |

## Risks

| Risk | Mitigation |
|---|---|
| Adaptive rules feel wrong for a specific user/app | All windows stay overridable via options; WP6 tunes from data before values are frozen |
| PAUSE state interacts with agent-speaking flag | Agent branch (WP3) is checked **before** the state switch — covered by t05/t07 regression |

## Deliverables

- Refined `turn-detector.js` (+ `redemptionFor`), WAV export util, demo "save last turn", extended test suite, updated master-plan transition table.
