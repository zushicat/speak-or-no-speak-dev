# WP8 — Smart Turn end-of-turn model experiment (conditional)

- **Status:** done (2026-10-21) — **D3 gate: GO** (user instruction + the s3 hesitation-split evidence) · spike GO (threaded WASM: inference p95 48 ms; single-threaded borderline 151 ms) · feature-extraction parity 8.8e-6 vs the Python reference · integration shipped (TurnModel + TURN_CANDIDATE + fail-open guard) · **62/62 tests** · **decision: ADOPT as optional module behind `turnModel`** — see [wp8-decision.md](../wp8-decision.md)
- **Phase:** M5 (optional)
- **Estimate:** 2–3 d if green-lit (incl. 2 h spike timebox)
- **Depends on:** WP3–WP6 (harness corpus + baseline metrics are the A/B reference)
- **Master plan:** [plan-initial.md](../plan-initial.md) · Model: [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) · Weights: [HF smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3)

## Objective

Decide with data whether a semantic end-of-turn model (Smart Turn v3.2: Whisper-Tiny backbone, ~8 M params, **8 MB int8**, 23 languages, audio-native PCM input, ~10–100 ms inference server-side) earns its asset weight in the browser — it is the principled fix for premature turn-ends on "um, I can't seem to, um…".

## Gate (before starting)

M3 review answers: **is the silence-only baseline's premature-turn-end rate (WP6 metric) high enough to hurt UX?**
- If < ~2–3 % → WP8 likely not worth +8 MB → mark rejected-by-default, keep the interface.
- If ≥ ~5 % or users complain in practice → proceed.

## Steps

### 8.1 Spike (timebox: 2 h — hard stop)

- Download `smart-turn-v3` ONNX int8 weights (8 MB) → `/vendor/` (gitignored) or direct HF URL in dev.
- Load via `ort.InferenceSession` (the CDN ORT from WP1 already available) in a Worker.
- Feed a synthetic 8 s @16 kHz buffer; log: session creation time, inference time.
- **Go criteria:** inference p95 ≤ 150 ms on the dev machine AND model load ≤ 5 s. Miss → stop, write rejection note, keep WP9 as the content path.

### 8.2 Preprocessing (per model README)

- Input: 16 kHz mono PCM, up to 8 s.
- Pad at the **beginning** with zeros so the actual audio ends at the buffer end (shorter turns are left-padded).
- Turn longer than 8 s → truncate from the start (keep the most recent 8 s).
- I/O shapes discovered during the spike; pin them in `src/turn-model/smart-turn.js` header docs.

### 8.3 Integration via the `TurnModel` interface

```js
/**
 * @interface TurnModel
 * predictComplete(turnAudio: Float32Array): Promise<boolean>  // true = sentence done
 */
```

- Wiring point: the `TURN_CANDIDATE` step of the state machine (WP3 §4.2). v1 emits turn end directly at redemption; with a model: redemption → *evaluate* → complete → emit; incomplete → back to LISTENING (accumulation continues).
- Per README guidance: if new speech arrives during evaluation → cancel the pending evaluation and re-run on the **entire** turn including new audio (never evaluate fragments).
- Runs **only** at silence points — never during speech — so the real-time budget is untouched.
- Timeout guard: if prediction takes > 300 ms, fall back to emitting turn end (never let the model block the flow).

### 8.4 A/B evaluation on the WP6 corpus

| Metric | Baseline (silence only) | + Smart Turn | Δ |
|---|---|---|---|
| premature turn-end rate | | | |
| turn-end latency p50/p95 (complete turns) | | | |
| added wall-clock latency at silence | n/a | | |
| asset size | ~0 (this feature) | +8 MB | |
| CPU spike at silence points | baseline | measured | |

Replay all WP6 scenarios offline (frame streams) with the model step mocked-in where possible, plus live runs for the hesitant-speech scenarios (3, and new ones recorded specifically: "I can't seem to, um…", credit-card-style number sequences).

### 8.5 Go/no-go report → `plans/initial/wp8-decision.md`

Adopt criteria (all must hold): premature-turn-ends reduced ≥ 50 % vs baseline **and** added latency ≤ 150 ms p95 **and** total asset budget ≤ 10 MB.
Outcome options: (a) adopt as optional module behind `turnModel` option, (b) reject with numbers, (c) defer until smarter integration (e.g. run on server for app-integrator deployments).

## Acceptance criteria (if green-lit)

- [x] Spike report with timings (8.1) — **GO**: load 120–800 ms (≤ 5 s ✓); inference p95 48.3 ms threaded / 151 ms single-threaded (≤ 150 ms — met with COOP/COEP, borderline without). Full report: [wp8-decision.md](../wp8-decision.md).
- [x] A/B table filled; recommendation written (adopt-as-optional with conditions).
- [x] Adopted: `turnModel` option in the facade ✓, demo toggle (Smart Turn checkbox) ✓, unit tests with mocked models (m01–m07: complete/incomplete/cancel/timeout/error/bypass/regression) ✓ — **62/62 suite green**.
- [x] The `TurnModel` interface + the `modelTimeoutMs` threshold documented in types/config.

## Results & deviations

| # | Finding | Resolution |
|---|---|---|
| D-WP8-1 | **The plan's "audio-native PCM input" premise was WRONG** — the model consumes Whisper log-mel features `[batch, 80, 800]` (chunk_length=8). | Full JS Whisper feature extractor implemented (`src/turn-model/whisper-features.js`): left-pad/truncate → zero-mean/unit-var → reflect-pad → Hann frames → **Bluestein chirp-z rfft(400)** (non-power-of-2!) → slaney mel → Whisper normalization. **Parity vs the Python reference: 8.8e-6 max diff.** |
| D-WP8-2 | The blog's "12 ms CPU" is native ORT; browser WASM single-threaded ≈ 146 ms — the adopt bar (≤ 150 ms added) only passes with **threaded WASM (COOP/COEP headers: p95 48.3 ms)**. | Documented as an adoption condition; without the headers the 300 ms timeout guard degrades gracefully to baseline (never worse). |
| D-WP8-3 | The ego-lite (hardened) browser **never TurboFan-optimizes** the hot FFT loops (flat ~225 ms warmup curve; Node: 25 ms). | The allocation-free rewrite (cached Bluestein buffers + precomputed FFT(b)) recovered 7×; the timeout guard covers the rest. On full-JIT browsers the pipeline runs at ~76 ms p95. |
| D-WP8-4 | The first Bluestein implementation had 3 bugs (NaN-poisoned chirp wraparound, swapped conjugation, stale cached-buffer tails) — each caught by the parity check. | Fixed + the parity check kept as the regression (the FFT wrapper is exported for unit tests). |
| D-WP8-5 | An "incomplete" verdict would re-trigger evaluation on EVERY silent frame (hot loop). | Silence resets on incomplete → the next evaluation only after another full redemption window (cadence ≈ 1/850 ms). |

## Risks

| Risk | Mitigation |
|---|---|
| Model is Python-ecosystem; ONNX graph may expect specific runtime ops | Spike first; ORT Web opset coverage check; abort criteria are explicit |
| HF download blocked in restricted networks | Cache in `/vendor/` (gitignored); document manual download step |
| CPU spike at silence on low-end machines | Inference in Worker + timeout guard (8.3); measure in 8.4 |
| Model disagrees with user intent (says "incomplete" on finished commands) | It's a boolean gate, not authority: app can disable via option; calibration scenario set includes short commands |

## Deliverables

- Spike report, A/B numbers, decision doc; optionally the integrated `src/turn-model/smart-turn.js`.
