# Calibration notes — WP6 (2026-10-20)

Tuning log format per WP6 §6.3: `value → value · scenario · observed metric · rationale`.

## Environment

- Machine: macOS (user's Mac), mic: internal, 48 kHz track → 16 kHz internal; AEC/NS/AGC on.
- Browser under test: ego-lite Chromium 154 (automation); recordings via the harness page.
- Frame reality: Silero v5 → 512 samples @ 16 kHz = **32 ms/frame** (WP1 D-WP1-1).

## Recordings (test/recordings/, gitignored)

| Recording | Duration | Speech? | Events | Marks |
|---|---|---|---|---|
| s1-short-commands | 33.7 s | yes (2 turns) | 2 starts, 1 end | script-timed |
| s2-fluent | 18.6 s | yes (2 turns) | 2 starts, 2 ends | script-timed |
| s3-hesitant | 17.5 s | yes (2 turns) | 2 starts, 2 ends | script-timed |
| s5-music-synth | 60 s | no (faint music audible, p95Rms 0.009) | **0 events** | — |
| s6-typing-synth | 60 s | no (clear typing clicks, p95Rms 0.043) | **0 events** | — |
| s7-agent-noise | 60 s | no (loud noise, p95Rms 0.128, prob max 0.431) | **0 events** | — |
| s8-speak-over-agent | 36 s | yes, over noise | **75 interrupts** | flag timeline recorded |
| s9-distance-2m | 33.7 s | yes, ~2 m (2 turns) | 2 starts, 1 end | script-timed |

Pending manual: s4 (real TV/dialogue), s10 (headphones control), Safari/Edge columns.

## Tuning decisions

| Change | Scenario | Observed metric | Rationale |
|---|---|---|---|
| **none** (0.6 stays) | s7-agent-noise | noise prob max 0.431 vs onset 0.6 | Comfortable 0.17 margin; no false onset in 60 s. |
| **none** (9 confirm frames stays) | s1/s2/s3/s9 | onset p50 **247 ms**, p95 **280 ms** (n=8, signal-based) | Bar: p95 ≤ 300 ms — met. Reducing confirm frames would trade noise-robustness for ~30 ms. |
| **none** (6 barge-in frames stays) | s8 | interrupt p50 **192 ms**, p95 **192 ms** (n=75) | Bar: p50 ≤ 250 ms — met with margin. |
| **none** (adaptive redemption unchanged) | s5/s6/s7 | false onsets **0/min** over 3 min audible noise | Bar ≤ 1/min — met. Typing/music/noise all rejected; echo (browser-played) fully cancelled (prob p95 ≈ 0). |
| **none** (maxTurnMs 30000 stays) | s8 | truncation only at 30 s | No long-monologue data yet; unit-tested (t12). |

**Verdict: the WP3–WP5 defaults pass every measurable bar on this machine/room — frozen unchanged.**

## Observations for future tuning (not applied — insufficient data)

1. **Hesitant thinking pauses ≥ 850 ms split turns** (s3: "okay … hmm … let me think … go now" became 2 turns). A dedicated `hesitantRedemptionMs` (or a longer patient window, e.g. 1000–1100 ms) is a candidate — but longer windows delay every short-utterance turn end ("go" already ends at ~850 ms vs the 0.8 s protocol bar, D-WP4-2). Needs more recordings before touching.
2. **Script-timed ground-truth marks are ±2 s** — mark-based onset/turn-end latencies are unusable in absolute terms; the signal-based metric (event − first frame of the above-onset run, capped at the previous event) is the reliable one. Real human-timed marks would improve turn-end/premature metrics.
3. **Single-word turn-end latency vs the 0.8 s bar** (D-WP4-2): the hesitant branch (base+200 = 850) applies to short speech. If the bar matters, split "short single-word turn" (snappy ~650) from "hesitant mid-utterance" (patient) — requires utterance-shape classification, defer.
4. Noise-prob margin 0.431 vs 0.6 onset: if a future engine/room pushes noise-prob higher, the first knob is `onsetConfirmFrames` (9 → 10-12), NOT the threshold (keep 0.6 hysteresis structure).

## Regression workflow

- Record scenarios via `http://localhost:5173/test/harness.html` (Start microphone → name → ● Record → speak (green banner prompts) → ■ Stop).
- Replay offline: `Replay ALL → metrics` in the browser, or `node test/harness/replay.js test/recordings/*.json` in Node.
- Any threshold/engine change → replay ALL → compare the aggregate table against this document.
