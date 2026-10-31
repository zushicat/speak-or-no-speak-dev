# Revision 3 Plan — Demo page: microphone toggle + background sounds

- **Date:** 2026-10-31 · **Status:** in progress — WP-R1–R4 complete 2026-10-31; WP-R5 pending
- **Input:** [rev-3.md](rev-3.md)
- **Branch:** `add_background_noises`
- **Scope guard:** demo page only (`index.html`, `demo/main.js`, `assets/`, README touch-up). `src/` is **not** changed; the facade already exposes `start()` / `stop()`.

---

## 0. Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Microphone button lifecycle | One persistent button, never hidden. Label toggles `Start microphone` ↔ `Stop microphone`, `aria-pressed` mirrors the state. `Stop` calls `sons.stop()` (releases the mic, resets the detector); `Start` opens a **new** facade. |
| D2 | Facade reuse | **Do not reuse** a stopped facade. Engine callbacks are accumulated in arrays (`src/vad/silero-vad-adapter.js:106-113`, `src/vad/energy-vad.js:66-69`), so a second `wireEngine()` on the same instance would deliver every frame twice. A fresh facade per start keeps the callback graph clean; the optional `SmartTurnModel` is cached separately (F10). |
| D3 | Assets location & naming | New repo-root `assets/` (outside `plans/`), five MP3s renamed to descriptive slugs (table §2.2), plus `sources.md` with provenance. Commit the MP3s (8.09 MB total / 7.7 MiB). |
| D4 | Background row visibility | **Always visible**, independent of the microphone. You can set the scene before starting the mic; background keeps playing after the mic stops. |
| D5 | Playback engine | A single `HTMLAudioElement` (`new Audio()`), `loop = true`, `preload = "auto"`, `volume = slider / 100`. No Web Audio graph in this revision (desktop target; iOS volume caveat in §6). |
| D6 | Toggle semantics | One button starts/stops. Changing the dropdown while playing switches tracks (stop → start). Volume applies live while playing. |
| D7 | VAD interaction | Background audio is **ambient noise, not agent output**: never call `setAgentSpeaking(true)` for it. It is expected to affect detection — that is the point of the feature. |
| D8 | Removals | Agent simulation (TTS utterance, volume select, start/stop buttons), `speechSynthesis` wiring, `agentLog`, `LONG_TEXT`, `agentArmed`, the WAV save link, and the demo's `encodeWav` import are all removed. The STT row stays. |
| D9 | Docs | `README.md` demo/layout sections updated, stale "TTS affects only the demo" limitation line corrected, `assets/sources.md` records provenance. `test/bundle-verify.*` is intentionally untouched (F9). |

---

## 1. Objective & scope

Make the demo page usable as a **noise-robustness test bench**:

1. The microphone can be started **and stopped** repeatedly from one permanent button.
2. A selected background MP3 can be started/stopped from one button, with a 50 %-default volume slider.
3. The agent simulation and the WAV save feature are gone.

**Deliverables**

1. `assets/` with the five renamed MP3s + `sources.md` (provenance).
2. `index.html` — persistent mic toggle, background-sound row, agent/save markup removed.
3. `demo/main.js` — mic start/stop state machine, background-audio controller; TTS/WAV code removed.
4. `README.md` — demo instructions, layout entry, stale TTS limitation corrected.
5. Browser verification of the acceptance list (§5).

**Out of scope**

- `src/` changes (the facade's `stop()` already releases the mic and resets the detector, `src/speak-or-no-speak.js:102-108`).
- `build/` regeneration — the demo imports `src/`, not the bundle; the bundle surface is unchanged.
- `test/bundle-verify.html` / `test/bundle-verify-main.js` — separate verification page, deliberately keeps its own agent/save controls (F9).
- STT behavior, new npm dependencies, volume/track persistence across reloads, mobile/iOS volume support.

---

## 2. Facts verified against the current tree

| # | Fact | Consequence |
|---|---|---|
| F1 | `index.html:35` renders the mic button; `demo/main.js:123` hides it (`button.hidden = true`). The agent row is `index.html:40-48`; the save link is `index.html:39`; their CSS is `index.html:19-20`. | Remove the hide call; replace the agent/save markup and CSS in place. |
| F2 | `demo/main.js` owns all demo wiring: `encodeWav` import (`:7`), save/agent handles (`:14-18`), `lastTurnUrl` (`:23`), agent log (`:48-50`), listeners (`:52-54`), `LONG_TEXT`/`agentArmed` (`:56-66`), WAV save (`:96-102`), `onInterrupt` TTS cancel (`:106-113`), agent functions (`:139-174`). | A focused rewrite of the mic/agent/save parts; `logLine`, `transcribeTurn`, `onError` stay. |
| F3 | Engines **append** frame/error callbacks (`silero-vad-adapter.js:106-113`, `energy-vad.js:66-69`). Re-wiring a reused facade would double-deliver frames. | Create a fresh facade on every `Start`; `stop()` the old one and drop the reference (D2). |
| F4 | `createSpeakOrNoSpeak()` is async and can throw before `start()` (e.g. Smart Turn setup). The current code awaits it **outside** the try block (`demo/main.js:83`, try starts `:120`). | Wrap facade creation **and** `start()` in one try/catch/finally so the button can never get stuck disabled. |
| F5 | `sons.stop()` is idempotent, stops the engine, releases the mic tracks and resets the detector (`src/speak-or-no-speak.js:102-108`). `state` returns `"idle"` afterwards. | The toggle can rely on `stop()`; no `src/` change needed. |
| F6 | The five MP3s in `plans/rev-3/assets/` are 0:12–2:00 long (table §2.2), total 8.09 MB (7.7 MiB). `sources.md` maps content names → original filenames. | Loop playback; copy + rename into `assets/`; keep the mapping in `assets/sources.md`. |
| F7 | `npm start` serves the repo root on `http://localhost:5173` (`package.json`), so root-relative `./assets/...` resolves from `index.html`. | Relative URLs `./assets/<slug>.mp3` are correct; no server change needed. |
| F8 | `encodeWav` remains a public export and is still used by `CloudStubAdapter` (`src/stt/cloud-stub-adapter.js:17,45`) and the bundle-verify page. | Remove only the **demo's** import/usage; leave `src/wav-export.js` and exports untouched. |
| F9 | `test/bundle-verify.html:40-44` has its own agent row + save link, and `test/bundle-verify-main.js:74-101,204-225` drives them; its mic lifecycle already does `stop() → sons = null → fresh facade` (`:149,212-225`). | Out of scope for editing; its `startMic`/`stopMic` pair is a working reference for the same fresh-facade pattern (D2). |
| F10 | `SmartTurnModel` lazily loads its ONNX session once and reuses it (`src/turn-model/smart-turn.js:49-63`). | Cache one `SmartTurnModel` in the demo across start/stop cycles instead of reloading the 8 MB asset on every start. |
| F11 | No test covers `index.html` / `demo/main.js` (`npm test` runs `node --test` over `test/unit` + `test/util`). | Demo changes cannot regress the suite; verification is browser-based (§5). |
| F12 | `README.md` run/layout/Safari sections described the pre-rev-3 demo. | Updated in WP-R4. |
| F13 | `npm start` uses Python's `SimpleHTTPRequestHandler`, which sends `Last-Modified` but no `Cache-Control`; a normal reload can reuse a cached `demo/main.js` while revalidating `index.html` — reproduced as the pre-WP-R3 `agentButton.addEventListener` null error at old `demo/main.js:53`. | Version the module URL (`?v=3`, bump when `demo/main.js` changes); a one-time hard reload clears the old entry. |

### 2.1 Target page layout

```
[ dot ]                       ← orange idle / green while speech is detected
press start                   ← mic status label
[ Start microphone ]          ← permanent toggle (text flips to "Stop microphone")
[ ] Smart Turn (+8 MB …)

[ Street Protest ▾ ] [ Start background sound ]  Volume [====|====] 50 %
                    ↑ select / toggle            ↑ range 0–100, live

[ ] transcribe turns   [ http://localhost:5175/transcribe ]
log…
```

The background row sits exactly where the agent row was, but is visible from page load (D4).

### 2.2 Asset mapping (copy source → runtime file)

| Dropdown label | Runtime file (`assets/`) | Original filename | Length | Size |
|---|---|---|---|---|
| Street Protest | `street-protest.mp3` | `abr029-public-protest-sound-effect-334561.mp3` | 1:59.6 | 3.83 MB |
| Crowd | `crowd.mp3` | `accentmodels-crowd-in-osaka-433469.mp3` | 0:20.0 | 0.64 MB |
| Street Sounds | `street-sounds.mp3` | `aman4u-street-sound-456586.mp3` | 0:56.6 | 1.81 MB |
| Playground | `playground.mp3` | `freesound_community-afternoon-recess-dewson-st-public-school-20099.mp3` | 1:11.1 | 1.42 MB |
| Street Sounds With People Talking | `street-sounds-people-talking.mp3` | `freesound_community-people-talking-at-street-market-102974.mp3` | 0:12.3 | 0.39 MB |

All five are 160–256 kbps MP3, 8.09 MB total (7.7 MiB). Loop them; the 12 s clip is intentionally short, so looping is required for a continuous bed.

---

## 3. Target behavior

### 3.1 Microphone toggle

| State | Button | Label (`#label`) | Dot | Mic |
|---|---|---|---|---|
| idle | `Start microphone`, `aria-pressed="false"`, enabled | `press start` | orange | released |
| starting | `Start microphone`, disabled | `starting…` | orange | opening |
| running | `Stop microphone`, `aria-pressed="true"`, enabled | `not listening` / `listening` | orange / green | live |
| failed | `Start microphone`, enabled | `press start` | orange | released |

- `toggleMicrophone()` guards against re-entry (`micBusy`), then either calls `stopMicrophone()` or awaits `startMicrophone()`.
- `startMicrophone()`: reads `?noaec`, the Smart Turn checkbox, builds the facade with cached `SmartTurnModel`, awaits `start()`, stores `sons`, sets the button to `Stop microphone`, reveals `#sttRow`, shows `no-aec` / `engine-fallback` warnings exactly as today.
- `stopMicrophone()`: `sons.stop()`, drop the reference and `window.__sons`, remove `.listening`, reset label/button/`dbg`, clear `errEl`, re-enable the Smart Turn checkbox.
- Failure path: if creation or `start()` throws, call `stop()` defensively, restore `Start microphone`, keep the `onError` message.
- The Smart Turn checkbox is disabled while the mic runs (the model is bound at facade creation); it is re-enabled on stop. The cached model is reused on the next start (F10).

### 3.2 Background sound

| State | Button | Select | Slider |
|---|---|---|---|
| idle | `Start background sound`, `aria-pressed="false"` | enabled | enabled |
| starting | disabled | disabled | enabled |
| playing | `Stop background sound`, `aria-pressed="true"` | enabled (change switches track) | enabled (live) |
| error | `Start background sound` | enabled | enabled; error in log |

- One `HTMLAudioElement`; `loop = true`; `volume = Number(slider.value) / 100`.
- `startBackground()`: set `src` only when the track changed, reset `currentTime`, apply volume, `await play()`. `play()` rejection (autoplay policy, decode error) reverts the button and logs the error.
- `stopBackground()`: `pause()`, `currentTime = 0`, revert the button.
- `change` while playing: `stopBackground()` then `startBackground()`.
- `input` on the slider: update `audio.volume` and the `50 %` readout immediately.
- Default slider value is `50`; default volume is therefore `0.5`.
- Background audio is **not** routed through `setAgentSpeaking` and does not touch the detector (D7).
- `pagehide` hardening: `stopMicrophone()` + `stopBackground()` so navigation does not leave the mic open and a bfcache restore starts idle.

### 3.3 Target markup (`index.html`)

```html
<button id="start" aria-pressed="false">Start microphone</button>
<label style="font-size:13px; display:block; margin-top:8px">
  <input type="checkbox" id="smartTurn"> Smart Turn (+8 MB, semantic end-of-turn)
</label>
<div id="err"></div>
<div id="dbg"></div>

<div id="bgRow">
  <select id="bgSound" aria-label="Background sound">
    <option value="./assets/street-protest.mp3">Street Protest</option>
    <option value="./assets/crowd.mp3">Crowd</option>
    <option value="./assets/street-sounds.mp3">Street Sounds</option>
    <option value="./assets/playground.mp3">Playground</option>
    <option value="./assets/street-sounds-people-talking.mp3">Street Sounds With People Talking</option>
  </select>
  <button id="bgToggle" aria-pressed="false">Start background sound</button>
  <label for="bgVolume">Volume <output id="bgVolumeValue" for="bgVolume">50 %</output></label>
  <input id="bgVolume" type="range" min="0" max="100" step="1" value="50">
</div>

<div id="sttRow" hidden class="row">…</div>
<div id="log"></div>
```

CSS: remove `#save` and `#agentRow` rules (`index.html:19-20`), add:

```css
#bgRow { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px;
         justify-content: center; align-items: center; }
#bgRow label { font-size: 13px; }
#bgRow input[type="range"] { width: 110px; accent-color: #93c5fd; }
#bgRow output { display: inline-block; min-width: 3.2em; text-align: right; }
```

No native `controls` on the audio element (it is not in the DOM; created via `new Audio()`), so the page's own button/slider remain the only controls.

### 3.4 `demo/main.js` structure after the change

```
imports          createSpeakOrNoSpeak, humanMessage, SmartTurnModel
                 CloudStubAdapter (STT — unchanged)
DOM handles      #start, #label, #err, #dbg, #smartTurn, #sttRow, #transcribe,
                 #sttEndpoint, #log, #bgSound, #bgToggle, #bgVolume, #bgVolumeValue
mic state        sons | null, micRunning, micBusy
bg state         bgAudio (new Audio), bgPlaying, bgBusy, bgTrack
helpers          logLine, transcribeTurn, onError   (unchanged)
bg helpers       syncBgVolume, rewindBackground, setBgUi, startBackground, stopBackground
mic helpers      toggleMicrophone, startMicrophone, stopMicrophone
listeners        #start → toggleMicrophone
                 #bgToggle → start/stop background
                 #bgSound change → switch if playing
                 #bgVolume input → syncBgVolume
                 bgAudio error → logLine
                 pagehide → stopMicrophone + stopBackground
facade callbacks onSpeechStart → dot/label
                 onTurnEnd → label + dbg duration + transcribe (no WAV)
                 onInterrupt → dbg/log only (no speechSynthesis)
                 onLevel → noop
                 onError → onError
```

### 3.5 Event wiring details

- `onSpeechStart`: `document.body.classList.add("listening")`; label `listening`.
- `onTurnEnd`: remove `.listening`; label `not listening`; keep the `turn: N s` debug line and `(truncated)` / `(after interrupt)` suffixes; call `transcribeTurn(e.audio)`; **no** `encodeWav` / blob / link code.
- `onInterrupt`: keep a `dbg` + `logLine` line (`barge-in after … ms, latency … ms`) for completeness, but drop `speechSynthesis.cancel()` and `disarmAgent()`; with no agent arming in the demo this handler is dormant.
- `onError`: unchanged.

---

## 4. Work packages

### WP-R1 — Copy and rename the audio assets
1. `mkdir -p assets`.
2. Copy + rename the five MP3s exactly per §2.2 (keep the originals in `plans/rev-3/assets/` untouched).
3. Copy `plans/rev-3/assets/sources.md` → `assets/sources.md`; rewrite it as the mapping table in §2.2 with the Pixabay provenance note and the "verify license before public redistribution" caveat.
4. Add `"assets/"` to `package.json` → `files` (the demo is already listed; the assets should ship with it). No dependency or script change.
5. Verify each file is served: `curl -sI http://localhost:5173/assets/<slug>.mp3` → `200` + `Content-Type: audio/mpeg`.

Acceptance: all five runtime files exist, sizes match §2.2, `sources.md` maps every runtime file to its original.

**Status:** done 2026-10-31 — five byte-identical copies in `assets/`, `assets/sources.md` written, `package.json` `files` updated; all five URLs serve `200` with `Content-Type: audio/mpeg`; `npm test` 67/67 green.

### WP-R2 — `index.html`: permanent mic button + background row
1. Remove the `<a id="save" …>` line (`index.html:39`).
2. Replace `#agentRow` (`index.html:40-48`) with the `#bgRow` block (§3.3) in the same position.
3. Add `aria-pressed="false"` to `#start`; leave its text as `Start microphone` (JS owns the label).
4. Remove the `#save` and `#agentRow` CSS rules (`index.html:19-20`); add the `#bgRow` rules (§3.3).
5. Leave the CDN tags, `#dot`, `#label`, Smart Turn, `#err`, `#dbg`, `#sttRow`, `#log`, and the module script path untouched; add `?v=3` to the module URL as a cache-buster (F13).

Acceptance: markup parses with the expected IDs; mic button visible from the start; background controls visible; no `#agent*` / `#save` / `#ttsVol` nodes remain. Runtime check is deferred to WP-R3 because `demo/main.js` still binds the removed nodes until then.

**Status:** done 2026-10-31 (markup + CSS) — all five `./assets/...` option values resolve to files; `#start` has `aria-pressed="false"` and no `hidden`; `#bgRow` has the five options, toggle, `50 %` output, and `value="50"` slider; `#sttRow` still hidden; page served `200`. Follow-up: the module URL gained `?v=3` after a stale cached `demo/main.js` reproduced the pre-WP-R3 `agentButton` null error on a normal reload (F13).

### WP-R3 — `demo/main.js`: remove agent/WAV, add toggle + background controller
1. Delete `encodeWav` import (`:7`); keep `createSpeakOrNoSpeak`, `humanMessage`, `SmartTurnModel`.
2. Delete the save/agent DOM handles (`:14-18`), `lastTurnUrl` (`:23`), `agentLog` (`:48-50`), agent listeners (`:53-54`), `LONG_TEXT` (`:56-63`), `agentArmed` (`:66`), `simulateAgent` / `stopAgent` / `disarmAgent` (`:139-174`).
3. Delete the WAV block in `onTurnEnd` (`:96-102`); keep the duration debug line and `transcribeTurn`.
4. Simplify `onInterrupt` to a `dbg` + `logLine` report (no `speechSynthesis`, no agent disarm).
5. Update the file header comment (no TTS simulation).
6. Add the background controller (§3.2/§3.5) with `new Audio()`, `loop`, live volume, track switching, error logging, and `pagehide` cleanup.
7. Refactor `startMic` into `toggleMicrophone` / `startMicrophone` / `stopMicrophone` per §3.1; move facade creation **inside** the try/catch; cache `SmartTurnModel`; disable the Smart Turn checkbox while running; never set `button.hidden`.
8. Keep `logLine`, `transcribeTurn`, `onError`, and the STT row behavior unchanged.

Acceptance: `node --check demo/main.js` passes; no references to `agent`, `save`, `ttsVol`, `speechSynthesis`, `encodeWav`, `lastTurnUrl`, `LONG_TEXT` remain in `demo/`; mic cycles cleanly 3×; background cycles cleanly 5×.

**Status:** done 2026-10-31 — `node --check` and `npm test` (67/67) green; no stale agent/TTS/WAV references. Browser: five background cycles, volume `50→60→50`, live track switch (Crowd → Playground), three mic cycles with `frameCallbacks.length === 1` on each start, mic stop → track `ended` + `window.__sons === null`, background survives mic stop, `pagehide` resets both to idle, 0 exceptions / 0 console errors.

### WP-R4 — Docs touch-up
1. `README.md` run-the-demo section: mention the background-sound row, the `assets/` folder, and that the mic button now stops the mic.
2. `README.md` layout: add `assets/` (background-noise MP3s; see `assets/sources.md`).
3. `README.md` Known limitations → Safari bullet: drop the now-stale "TTS affects only the demo" clause; keep the AudioWorklet/Safari and iOS notes.
4. No `README-BUNDLE.md` change (bundle behavior is untouched).

**Status:** done 2026-10-31 — README run/layout/Safari sections updated; `assets/` documented; no stale TTS-demo wording remains; `README-BUNDLE.md` untouched.

### WP-R5 — Browser verification
Serve with `npm start`, verify §5 in Chromium (and Safari if available) using the session browser automation or manual click-through. Record pass/fail per check.

---

## 5. Acceptance checks

| # | Check | Pass criterion |
|---|---|---|
| A1 | Test suite | `npm test` fully green; `git diff --stat` shows no `src/` change. |
| A2 | Static removal | `grep -rn "Simulate agent\|ttsVol\|agentRow\|lastTurnUrl\|encodeWav\|speechSynthesis" index.html demo/` returns nothing; `node --check demo/main.js` passes. |
| A3 | Assets served | All five `curl -sI http://localhost:5173/assets/<slug>.mp3` return `200` with `audio/mpeg`. |
| A4 | Mic toggle | Start → button `Stop microphone`, mic indicator on; Stop → `Start microphone`, indicator off, label `press start`; three start/stop cycles work; after each start `__sons._engine.frameCallbacks.length === 1`. |
| A5 | Background toggle | Each of the five options plays audibly; `Stop background sound` silences it; button text/`aria-pressed` track state. |
| A6 | Volume | Slider defaults to `50` and shows `50 %`; moving it changes loudness live while playing; `0` is silent, `100` is full. |
| A7 | Track switch | Changing the dropdown while playing switches to the new track without leaving two playing. |
| A8 | Independence | Background plays with the mic idle, and keeps playing after the mic stops; stopping the mic never stops the background. |
| A9 | VAD under noise | With background audio playing and the mic on, speech/turn events still fire; the demo never enters an "agent speaking" state (no `setAgentSpeaking`). |
| A10 | Removed features | No agent/save UI, no TTS, no WAV download; no console errors on load/start/stop. |
| A11 | Docs | README demo/layout text matches the shipped page; `assets/sources.md` present. |

---

## 6. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | Reusing a stopped facade duplicates frames (F3) | Fresh facade per start; old one stopped and dropped (D2). |
| R2 | `audio.play()` rejects (autoplay policy, missing codec) | `await play()` inside try/catch; revert button, log the error, keep the page usable. |
| R3 | 8.09 MB of MP3s in git | Commit them (D3); if you prefer a lean repo, gitignore `assets/*.mp3` and add a fetch step — see §8. |
| R4 | Background noise causes false turns | Expected and useful for testing; document it in the README. Use headphones or `?noaec=1` to compare AEC on/off. |
| R5 | Wrong asset path → 404 | Root-relative `./assets/…` values; curl check (A3). |
| R6 | Double-click race on either toggle | `micBusy` / `bgBusy` guards + `disabled` during async work. |
| R7 | Removing agent simulation loses the barge-in demo | Barge-in remains covered by `test/unit/wp5-barge-in.test.js` and `test/unit/turn-detector.test.js`; the demo is now a noise-robustness bench. |
| R8 | iOS Safari ignores `HTMLMediaElement.volume` | Desktop demo target; note in README/plan; upgrade to a `GainNode` later if mobile volume matters. |
| R9 | Pixabay license restricts standalone redistribution | Keep `assets/sources.md` provenance and confirm the repo's distribution model before publishing (§8). |

---

## 7. Execution order

`WP-R1` (assets) → `WP-R2` (markup) → `WP-R3` (wiring) → `WP-R5` (A1–A11) → `WP-R4` (docs last, so they describe the verified page) → final diff review.

---

## 8. Open points — defaults applied unless you object

1. **Commit the MP3s** (default: yes, §2.2). Alternative: gitignore them and add a `assets/fetch.sh` — say the word.
2. **Rename to descriptive slugs** (default: yes, §2.2). Alternative: keep the original Pixabay filenames.
3. **Background row always visible** (default: yes, D4). Alternative: reveal it only after the mic starts, like the old agent row.
4. **Loop the tracks** (default: yes, D5). Alternative: play once and auto-revert the button on `ended`.
5. **Stop mic leaves background playing** (default: yes, D4). Alternative: stop both together.
6. **Cache `SmartTurnModel` across starts** (default: yes, F10). Alternative: rebuild per start (re-downloads/re-inits the 8 MB session each cycle).
