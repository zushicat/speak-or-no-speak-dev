# WP9 — STT plug point (optional)

- **Status:** done (2026-10-21) — interface + example adapter + demo wiring verified live (spoken turn → 💬 log line; failure path → logged error, detection untouched); 66/66 tests
- **Phase:** M6
- **Estimate:** 0.5–1 d
- **Depends on:** WP3 (turn-end audio exists)
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

Make the "content" upgrade (analysis §3 D/E, the user's original STT idea) trivial for integrators — **strictly outside the real-time loop**. The module hands over turn audio; any transcription can consume it. Detection behavior must be completely independent of STT.

## Steps

### 9.1 Interface (`src/stt/stt-adapter.js`)

```js
/**
 * @typedef {Object} Transcription
 * @property {string} text
 * @property {number} [confidence]
 */

/** @interface SttAdapter */
// transcribe(audio: Float32Array /*16 kHz mono*/, opts?: {language?: string}): Promise<Transcription>
```

Contract (documented + asserted in code review):
- Called **only** from `onTurnEnd` audio — never fed live frames.
- Failures must never affect detection events (wrap in try/catch at the demo level; the module itself doesn't even own the call).
- The module ships **no** STT engine — adapters are user-supplied.

### 9.2 Example adapter: `src/stt/web-speech-adapter.js`

Zero-dependency example using the Web Speech API in one-shot mode on the buffered audio… note: `SpeechRecognition` consumes a *live* mic stream, not buffers — so this example replays through a **hidden loopback**: play the turn audio via a muted `AudioContext` → capture via `getUserMedia` is not possible for synth output.

**Decision (record at implementation):** ship one of —
- **(a) cloud-stub adapter** (recommended): `fetch(POST, endpoint)` with raw PCM/WAV body (WP4's `encodeWav`), configurable URL; ~40 lines; works everywhere, clearly marked "dev example, add auth for production"; or
- **(b) live Web Speech adapter**: starts a `SpeechRecognition` session in parallel with listening and harvests the *final result matching the turn window*; Chromium-only, server-backed (MDN: not Baseline), zero audio plumbing.

Recommendation: **(a)** for the repo example, with (b) described in the README as the zero-backend option including its privacy caveat.

### 9.3 Demo wiring

- Toggle "transcribe turns" in the demo; on `onTurnEnd` → adapter → append `text` line to the event log (timestamped).
- Failure path: error line in log, detection continues untouched (prove by pointing the stub at an unreachable endpoint).

### 9.4 README section "Adding transcription"

- Show the adapter interface + both options (cloud stub / Web Speech caveats).
- Reiterate the hard rule: no STT in the real-time path (analysis §3 D verdict — right idea, wrong layer).

## Acceptance criteria

- [x] Spoken turn → text appears in the demo log via the example adapter — **verified live**: 4 × `💬 "(stub) recognized turn audio" (90%)` timestamped lines via the local stub (`demo/stt-stub-server.py`, CORS, WAV-body-aware).
- [x] Adapter failure (unreachable endpoint) → `STT failed: Failed to fetch` logged, **zero impact** on detection (frames flowing, state clean, verified with the live pipeline).
- [x] Adapter ≤ ~50 lines and swappable (`CloudStubAdapter`, ~45 lines); the `SttAdapter` interface + the `Transcription` typedef documented in `src/stt/stt-adapter.js`.
- [x] README section complete ("Adding transcription": the cloud stub + the Web Speech option with its Chromium-only/privacy caveats + the hard rule).

## Results & deviations

| # | Finding | Resolution |
|---|---|---|
| D-WP9-1 | **Decision per §9.2: option (a) shipped** — the cloud-stub adapter (WAV POST, configurable endpoint/token); (b) the live Web Speech adapter documented in the README (not shipped: Chromium-only, server-backed, privacy caveat). |
| D-WP9-2 | The demo's endpoint field got a working default (`http://localhost:5175/transcribe`) — the empty-field case was a silent no-op that confused the first live round. The silent-return remains correct (STT off = no log), but the demo now works out of the box with the stub running. |
| D-WP9-3 | A demo bug surfaced during verification: `sttRow` was referenced without a declaration → the post-start block died with a ReferenceError every start (silently caught). Fixed; the hardened lesson: the module's fresh-code verification needs a **hard reload** (`Page.reload {ignoreCache: true}`) — normal reloads served a stale cached module during debugging. |

## Risks

| Risk | Mitigation |
|---|---|
| Example adapter invites hardcoding keys in apps | Stub reads endpoint+token from options with loud doc comment; never from repo defaults |
| Web Speech path chosen for convenience despite caveats | Recommendation is (a); (b) documented with explicit privacy/browser-support warnings |

## Deliverables

- `SttAdapter` interface + example adapter + demo toggle + README section.
