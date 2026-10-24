# WP2 — Demo `index.html`: listening indicator

- **Status:** done (2026-10-20) — Chrome verified via automation incl. live speech; Safari manual pass pending
- **Phase:** M1
- **Estimate:** 0.5 d
- **Depends on:** WP1 (engine streaming); parallel to WP3
- **Decisions applied:** D1 (zero-build), D2 (**green = "speech detected"**, orange = "not listening")
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

The user's requested test page: a super-simple page showing **"listening" (green)** vs **"not listening" (orange)** via a plain div, used to validate the detector throughout the project. No frameworks, no CSS files, no build step — one HTML file + one module.

## Behavior specification

| App state | Trigger | Indicator |
|---|---|---|
| before start | page load | gray dot, label "press start", Start button visible |
| ready / silence | engine streaming, `prob ≤ onset` | **orange** dot, "not listening" |
| speech detected | sustained `prob > onset` (WP3 state `LISTENING`; naive in this WP) | **green** dot, "listening" |
| turn finished | `onTurnEnd` | back to orange; log line with duration |
| error | `onError` | red-ish error line under the button, state stays orange |

CSS transition 150 ms on the dot's background so flips read clearly. Debug line (small, low-opacity) shows the live probability — invaluable during calibration; keep it.

## Files

### `index.html` (~55 lines, complete reference)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Speak Or No Speak — demo</title>
<style>
  body { font-family: system-ui, sans-serif; display: grid; place-items: center;
         min-height: 100vh; margin: 0; background: #14161a; color: #eee; }
  .card { text-align: center; }
  #dot { width: 120px; height: 120px; border-radius: 50%; margin: 0 auto 16px;
         background: #f59e0b; transition: background 150ms; }
  body.listening #dot { background: #22c55e; }
  #label { font-size: 28px; }
  button { margin-top: 24px; padding: 10px 20px; font-size: 16px;
           border-radius: 8px; border: 0; cursor: pointer; }
  #err { color: #f87171; min-height: 20px; margin-top: 8px; }
  #dbg { opacity: .45; font-size: 12px; margin-top: 12px; }
</style>
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
</head>
<body>
  <div class="card">
    <div id="dot"></div>
    <div id="label">press start</div>
    <button id="start">Start microphone</button>
    <div id="err"></div>
    <div id="dbg"></div>
  </div>
  <script type="module" src="./demo/main.js"></script>
</body>
</html>
```

### `demo/main.js` (sketch — final wiring depends on WP3 availability)

- On `#start` click: create engine (WP1 adapter, or facade once WP3 lands), call `start()`.
- Map to indicator:
  - speech onset (naive here: `probability > 0.6` sustained over 2 frames; from WP3 on: `onSpeechStart`) → `document.body.classList.add('listening')`, label "listening".
  - silence/redemption → remove class, label "not listening".
  - `onTurnEnd` → console + dbg line: `turn: 1.8 s`.
  - `onFrame` → `#dbg.textContent = prob.toFixed(2)`.
  - `onError` → `#err` with human-readable message (mic denied / CDN blocked / insecure context).
- After WP3, this file must contain **no detection logic** — only UI mapping. That is a hard review rule (demo = integration surface).

## Acceptance criteria

- [x] Page goes **green within ~0.3 s** of speech onset — **measured 2 ms** from first frame p > 0.6 (2-frame confirm adds ≤ 64 ms; frames are 32 ms, see WP1 D-WP1-1).
- [ ] Returns to **orange ~0.5–0.9 s** after speech stops — **naive WP2 version returns instantly** (flips at the first frame ≤ 0.6). Redemption window is WP3 scope; re-check this criterion after WP3.
- [ ] Quick successive speech ("go — go — go") keeps the dot green — **naive version flickers once** (90 ms green → ~190 ms orange → green again). Expected per Risks; re-check after WP3.
- [x] Start button → mic permission prompt → no console errors (0 uncaught exceptions); denial shows a readable message ("Microphone access was denied…") and the button returns to a usable retry state (bug found & fixed during verification).
- [x] No CSS/JS assets beyond the two CDN scripts + our ES modules; `index.html` = 35 lines.
- [ ] Verified in Chrome and Safari. **Chrome: verified** (automation + live speech). **Safari: pending** manual pass.
- [x] This page is the standing verification surface for WP3–WP7 (each WP re-checks its criteria here).

## Manual test checklist (record results)

| Check | Chrome | Safari |
|---|---|---|
| green flip latency feels instant (< 0.3 s) | ✅ measured 2 ms class-flip after onset frame (+CSS 150 ms fade) | pending |
| orange recovery after silence (~0.7 s) | ❌ instant with naive logic — WP3 redemption pending | pending |
| noise (typing, music) does NOT turn it green | ⚠️ brief green bursts (90–280 ms) from transients during quiet; sustained speech-like probs 0.8–0.98. WP3 confirm window (~288 ms) + minSpeechMs will reject | pending |
| mic denial error message shown | ✅ "Microphone access was denied. Allow mic access for this site and reload the page." (simulated via patched getUserMedia; button usable for retry) | pending |

### Verification log (2026-10-20, ego-browser Chromium 154)

1. Load: CDN globals present, 0 console errors, orange dot, label "press start".
2. Start: label "not listening", dot orange `rgb(245,158,11)`, dbg prob updating, button hidden; mic AEC/NS/AGC confirmed again.
3. Denial (simulated): readable message in `#err`, state stays orange — **bug found: button stayed disabled / label stuck at "starting…" — fixed** (catch branch now restores retry state).
4. Scripted speech window (75 s, 2533 frames traced): green latency 2 ms; 12 green/12 orange flips; "go—go—go" flicker observed as predicted by the Risks table; transient noise bursts in quiet tail recorded for WP3 calibration context.

## Risks

| Risk | Mitigation |
|---|---|
| Naive threshold flickers green on noise in this WP | Acceptable — WP3's confirm-frames logic replaces it; do not tune the naive version |
| CDN scripts blocked | WP1 vendor fallback |

## Deliverables

- Final `index.html` + `demo/main.js` (UI mapping only), recorded manual test results.
