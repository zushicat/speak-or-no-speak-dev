/**
 * Demo wiring — UI MAPPING ONLY (WP3/WP4/WP5/WP9). Contains NO detection
 * logic: all onset/turn/barge-in decisions live in the facade's TurnDetector;
 * this file maps facade events → DOM, toggles the microphone, and plays an
 * ambient background track for noise-robustness testing.
 */
import { createSpeakOrNoSpeak, humanMessage, SmartTurnModel, createAgentAudioRoute } from "../src/index.js";
import { CloudStubAdapter } from "../src/stt/cloud-stub-adapter.js";
import { encodeWav } from "../src/wav-export.js";

const button = document.getElementById("start");
const label = document.getElementById("label");
const errEl = document.getElementById("err");
const dbg = document.getElementById("dbg");
const smartTurn = document.getElementById("smartTurn");
const transcribeToggle = document.getElementById("transcribe");
const sttEndpoint = document.getElementById("sttEndpoint");
const sttMode = document.getElementById("sttMode");
const sttModel = document.getElementById("sttModel");
const sttApiKey = document.getElementById("sttApiKey");
const sttRow = document.getElementById("sttRow");
const logEl = document.getElementById("log");
const bgSound = document.getElementById("bgSound");
const bgToggle = document.getElementById("bgToggle");
const bgVolume = document.getElementById("bgVolume");
const bgVolumeValue = document.getElementById("bgVolumeValue");
const voice = document.getElementById("voice");
const voiceSrc = document.getElementById("voiceSrc");
const ttsVoice = document.getElementById("ttsVoice");
const voiceNote = document.getElementById("voiceNote");

let sons = null;
let micRunning = false;
let micBusy = false;

/** Cached across start/stop cycles — the ONNX session loads once. */
let smartTurnModel = null;

// Computer voice (rev-9) — start/stop button + voice-source select.
const synth = window.speechSynthesis;
const utterance = new SpeechSynthesisUtterance("Hello. I am happy that you talk to me. Tell me about your day. What have you been up to?");

let voiceRunning = false;
let route = null;        // created at mic start (user gesture), stopped at mic stop
let routedSource = null; // active AudioBufferSourceNode (loop mode)
let voiceBuffer = null;  // decoded agent-voice-sample.wav (decoded once)

/** One looping media element for the ambient background bed. */
const bgAudio = new Audio();
bgAudio.loop = true;
bgAudio.preload = "auto";
let bgPlaying = false;
let bgBusy = false;
let bgTrack = "";

/** Timestamped event log (WP9 demo: transcription results + errors). */
function logLine(text, isError = false) {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${text}`;
  logEl.prepend(line);
  while (logEl.children.length > 20) logEl.lastChild.remove();
}

// ---------------------------------------------------------------------------
// rev-11: real STT backends — the mode select picks the request shape:
//   stub   → CloudStubAdapter: raw WAV body → { text, confidence? } JSON
//   openai → OpenAiCompatibleSttAdapter (below): multipart form-data with
//            `file` + `model`, for OpenAI-style /v1/audio/transcriptions
//            endpoints (LM Studio, Groq, OpenAI, …)
// ---------------------------------------------------------------------------

/**
 * Demo-local adapter (plan rev-11 D1/D3): POSTs the turn audio as
 * multipart/form-data — `file` = 16 kHz mono WAV, `model` when set — with
 * `Authorization: Bearer …` when a key is set; parses `{ text }` JSON back
 * with a plain-text fallback. Same contract as the `SttAdapter` plug point.
 */
class OpenAiCompatibleSttAdapter {
  constructor(options = {}) {
    if (!options.endpoint) throw new Error("OpenAiCompatibleSttAdapter requires an endpoint");
    this.endpoint = options.endpoint;
    this.model = options.model;
    this.token = options.token;
  }

  async transcribe(audio) {
    const form = new FormData();
    form.append("file", encodeWav(audio, 16000), "turn.wav");
    if (this.model) form.append("model", this.model);
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    // No manual Content-Type — the browser must add the multipart boundary.
    const res = await fetch(this.endpoint, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`STT endpoint responded ${res.status}`);
    const type = res.headers.get("Content-Type") ?? "";
    const data = type.includes("json") ? await res.json() : { text: (await res.text()).trim() };
    return {
      text: String(data.text ?? ""),
      confidence: typeof data.confidence === "number" ? data.confidence : undefined,
    };
  }
}

/** Adapter factory from the current UI values (null = nothing configured). */
function buildSttAdapter() {
  const endpoint = sttEndpoint.value.trim();
  if (!endpoint) return null;
  const token = sttApiKey.value.trim() || undefined;
  if (sttMode.value === "openai") {
    return new OpenAiCompatibleSttAdapter({
      endpoint,
      model: sttModel.value.trim() || undefined,
      token,
    });
  }
  return new CloudStubAdapter({ endpoint, token });
}

/** Network-level rejections ("Failed to fetch") mean an unreachable server or
 *  missing CORS in practice — name the likely cause (plan rev-11 §5). */
function sttFailureMessage(mode, err) {
  const base = `STT failed (${mode}): ${err.message}`;
  return err instanceof TypeError
    ? `${base} — unreachable, or CORS not enabled on the STT server?`
    : base;
}

/** WP9: STT strictly outside the real-time loop — called from onTurnEnd only,
 *  fire-and-forget with a catch; failures never touch detection events. */
function transcribeTurn(audio) {
  if (!transcribeToggle.checked) return;
  let adapter;
  try {
    adapter = buildSttAdapter();
  } catch (err) {
    logLine(`STT setup failed: ${err.message}`, true);
    return;
  }
  if (!adapter) return;
  const mode = sttMode.value; // captured: a mid-flight mode switch logs the serving mode
  adapter.transcribe(audio)
    .then((t) => logLine(`💬 "${t.text}"${t.confidence !== undefined ? ` (${(t.confidence * 100).toFixed(0)}%)` : ""} · ${mode}`))
    .catch((err) => logLine(sttFailureMessage(mode, err), true));
}

// rev-11 D6: the model field only applies to the OpenAI-compatible backend.
function syncSttUi() {
  sttModel.disabled = sttMode.value !== "openai";
}

// rev-11 D7: STT settings persistence — dev-demo convenience; the API key
// lives in this browser's localStorage (same caveat class as the adapter
// docstrings: never do this in production).
const STT_SETTINGS_KEY = "sons.stt";

function saveSttSettings() {
  try {
    localStorage.setItem(STT_SETTINGS_KEY, JSON.stringify({
      mode: sttMode.value,
      endpoint: sttEndpoint.value,
      model: sttModel.value,
      apiKey: sttApiKey.value,
    }));
  } catch { /* private mode / quota — persistence is best-effort */ }
}

let sttSaveTimer = 0;
function scheduleSttSave() {
  clearTimeout(sttSaveTimer);
  sttSaveTimer = setTimeout(saveSttSettings, 300);
}

function restoreSttSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STT_SETTINGS_KEY) ?? "null");
    if (!saved) return;
    if (saved.mode === "stub" || saved.mode === "openai") sttMode.value = saved.mode;
    if (typeof saved.endpoint === "string") sttEndpoint.value = saved.endpoint;
    if (typeof saved.model === "string") sttModel.value = saved.model;
    if (typeof saved.apiKey === "string") sttApiKey.value = saved.apiKey;
  } catch { /* corrupt JSON → keep markup defaults */ }
}

restoreSttSettings();
syncSttUi();
sttMode.addEventListener("change", syncSttUi);
for (const el of [sttMode, sttEndpoint, sttModel, sttApiKey]) {
  el.addEventListener("input", scheduleSttSave);
  el.addEventListener("change", scheduleSttSave);
}

// ---------------------------------------------------------------------------
// Background sound (ambient noise — deliberately NOT setAgentSpeaking: it is
// supposed to reach the detector so the demo can be tested under noise).
// ---------------------------------------------------------------------------

/** Map the 0–100 slider to the media element's linear 0–1 volume. */
function syncBgVolume() {
  const percent = Number(bgVolume.value);
  bgAudio.volume = percent / 100;
  bgVolumeValue.textContent = `${percent} %`;
}

/** Rewind only when metadata is available: setting currentTime at
 *  readyState HAVE_NOTHING throws in Chromium. */
function rewindBackground() {
  if (bgAudio.readyState > 0) bgAudio.currentTime = 0;
}

function setBgUi(playing) {
  bgPlaying = playing;
  bgToggle.textContent = playing ? "Stop background sound" : "Start background sound";
  bgToggle.setAttribute("aria-pressed", String(playing));
}

async function startBackground() {
  if (bgPlaying || bgBusy) return;
  const src = bgSound.value;
  if (!src) return;
  bgBusy = true;
  bgToggle.disabled = true;
  bgSound.disabled = true;
  try {
    if (bgTrack !== src) {
      bgTrack = src;
      bgAudio.src = src;
    }
    rewindBackground();
    syncBgVolume();
    await bgAudio.play();
    setBgUi(true);
    // logLine(`🔊 background: ${bgSound.selectedOptions[0]?.textContent ?? src}`);
  } catch (err) {
    setBgUi(false);
    logLine(`Background sound failed: ${err?.message ?? err}`, true);
  } finally {
    bgBusy = false;
    bgToggle.disabled = false;
    bgSound.disabled = false;
  }
}

function stopBackground() {
  bgAudio.pause();
  rewindBackground();
  setBgUi(false);
}

// ---------------------------------------------------------------------------
// Microphone start/stop toggle
// ---------------------------------------------------------------------------

async function toggleMicrophone() {
  if (micBusy) return;
  if (micRunning) {
    stopMicrophone();
    return;
  }
  micBusy = true;
  button.disabled = true;
  try {
    await startMicrophone();
  } finally {
    micBusy = false;
    button.disabled = false;
  }
}

async function startMicrophone() {
  errEl.textContent = "";
  label.textContent = "starting…";

  // WP5 §5.4: `?noaec=1` forces echoCancellation off to exercise the
  // no-AEC fallback branch on any machine.
  const forceNoAec = new URLSearchParams(location.search).has("noaec");
  const mic = forceNoAec ? { echoCancellation: false } : undefined;

  // WP8: optional semantic end-of-turn model (checkbox; +8 MB asset). One
  // instance is cached so start/stop cycles do not reload the ONNX session.
  if (smartTurn.checked && !smartTurnModel) smartTurnModel = new SmartTurnModel();

  let instance = null;
  try {
    instance = await createSpeakOrNoSpeak({
      mic,
      turnModel: smartTurn.checked ? smartTurnModel : undefined,
      onSpeechStart: () => {
        document.body.classList.add("listening");
        label.textContent = "listening";
      },
      onTurnEnd: (e) => {
        document.body.classList.remove("listening");
        label.textContent = "not listening";
        // turn-finished log line (WP2 behavior spec)
        dbg.textContent = `turn: ${(e.durationMs / 1000).toFixed(1)} s` +
          (e.truncated ? " (truncated)" : "") + (e.afterInterrupt ? " (after interrupt)" : "");
        transcribeTurn(e.audio); // WP9 plug point — never affects detection
      },
      // S3 (WP5): kept for completeness; the demo no longer drives TTS.
      onInterrupt: (info) => {
        dbg.textContent = `interrupt after ${info.atMs} ms (latency ${info.latencyMs} ms)`;
        logLine(`barge-in after ${info.atMs} ms (latency ${info.latencyMs} ms)`);
      },
      onLevel: () => { },
      onError: onError,
      debug: false,
    });
    await instance.start();
    sons = instance;
    window.__sons = instance; // debug handle (tooling)
    micRunning = true;
    button.textContent = "Stop microphone";
    button.setAttribute("aria-pressed", "true");
    smartTurn.disabled = true;
    sttRow.hidden = false;
    label.textContent = "not listening";
    if (forceNoAec || instance.degraded.aec) {
      errEl.textContent = humanMessage("no-aec");
    }
    if (instance.degraded.engine === "energy") {
      errEl.textContent = humanMessage("engine-fallback");
    }

    // WP-E2: cancelable agent-audio route — created HERE inside the mic-start
    // click (user gesture, R2), reused while the mic runs, stopped on mic
    // stop. Fail-soft (R3): plain playback + stricter gating stay active if
    // the loopback cannot be built. `?routemode=` forces loopback|direct (D7).
    try {
      const forced = new URLSearchParams(location.search).get("routemode");
      route = await createAgentAudioRoute(forced ? { mode: forced } : {});
      instance.setAgentAudioRouted(true);
      instance.setAgentAudioReference(route);
      voiceNote.textContent = ` · route: ${route.mode}`;
    } catch (routeErr) {
      route = null;
      errEl.textContent += ` · agent-audio route failed: ${routeErr?.message ?? routeErr}`;
    }
  } catch (err) {
    // onError may already have rendered the message; otherwise show it here.
    try { instance?.stop(); } catch { /* already torn down */ }
    sons = null;
    window.__sons = null;
    micRunning = false;
    button.textContent = "Start microphone";
    button.setAttribute("aria-pressed", "false");
    smartTurn.disabled = false;
    label.textContent = "press start";
    if (!errEl.textContent) {
      errEl.textContent = err?.code
        ? humanMessage(err.code)
        : `Error: ${err?.message ?? err}`;
    }
  }
}

function stopMicrophone() {
  try {
    sons?.setAgentAudioRouted(false); // D5: route declaration is per-session
  } catch { /* already torn down */ }
  try {
    sons?.stop();
  } catch (err) {
    logLine(`stop failed: ${err?.message ?? err}`, true);
  }
  sons = null;
  window.__sons = null;
  micRunning = false;
  document.body.classList.remove("listening");
  button.textContent = "Start microphone";
  button.setAttribute("aria-pressed", "false");
  smartTurn.disabled = false;
  label.textContent = "press start";
  dbg.textContent = "";
  errEl.textContent = "";
  voiceNote.textContent = "";
  stopComputerVoice();
  const r = route;
  route = null;
  r?.stop().catch(() => { /* teardown is best-effort */ });
}

function onError(err) {
  errEl.textContent = humanMessage(err.code) ?? `Error (${err.code}): ${err.message}`;
  // eslint-disable-next-line no-console
  console.error("[sons] onError:", err);
}

// ---------------------------------------------------------------------------
// Computer voice — two sources (WP-E2):
//   speechSynthesis: today's default; NOT cancelable on Chrome/Edge
//     without `echoCancellation: "all"` + OS permission (F7 — cannot be
//     captured into the AEC reference).
//   audio buffer (routed): plays demo/agent-voice-sample.wav through the
//     cancelable agent-audio route (createAgentAudioRoute) — the browser
//     classifies it as "remote participant" audio and cancels it (D6/D8).
//   voice dropdown (ttsVoice): the system TTS voices from
//     speechSynthesis.getVoices() — applies to the synth source only.
// ---------------------------------------------------------------------------

function setVoiceUi(running) {
  voiceRunning = running;
  voice.textContent = running ? "Stop computer voice" : "Start computer voice";
  voice.setAttribute("aria-pressed", String(running));
}

async function ensureVoiceBuffer() {
  if (voiceBuffer) return voiceBuffer;
  const res = await fetch("agent-voice-sample.wav");
  if (!res.ok) throw new Error(`voice sample fetch failed (${res.status})`);
  const ab = await res.arrayBuffer();
  const decodeCtx = new AudioContext(); // one-off decode (route ctx is private by contract)
  try { voiceBuffer = await decodeCtx.decodeAudioData(ab); }
  finally { decodeCtx.close().catch(() => { }); }
  return voiceBuffer;
}

async function playRoutedVoice() {
  if (!route) throw new Error("route not ready — start the microphone first (the route is created in that click)");
  const buffer = await ensureVoiceBuffer();
  const src = route.input.context.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.connect(route.input); // the ONLY wiring (D8) — never also to ctx.destination
  src.start();
  routedSource = src;
}

function stopRoutedVoice() {
  try { routedSource?.stop(); } catch { /* already stopped */ }
  routedSource = null;
}

function stopComputerVoice() {
  setVoiceUi(false);
  synth.cancel();
  stopRoutedVoice();
}

async function toggleComputerVoice() {
  if (voiceRunning) {
    stopComputerVoice();
    return;
  }
  setVoiceUi(true);

  if (voiceSrc.value === "routed") {
    try {
      await playRoutedVoice();
    } catch (err) {
      setVoiceUi(false);
      errEl.textContent = `Routed voice failed: ${err?.message ?? err}`;
    }
  } else {
    applySelectedVoice(utterance);
    synth.speak(utterance);
  }
}

/** Apply the TTS voice picked in the voice dropdown (unset = system
 *  default). The utterance must get the SpeechSynthesisVoice OBJECT —
 *  looked up from the live getVoices() list at speak time. */
function applySelectedVoice(u) {
  const selected = ttsVoice.value
    ? synth.getVoices().find((v) => v.voiceURI === ttsVoice.value)
    : null;
  u.voice = selected ?? null;
  u.lang = selected ? selected.lang : ""; // "" = user-agent default language
}

/** Populate the voice dropdown from speechSynthesis.getVoices() — the
 *  list arrives async in Chrome (voiceschanged) and can change; the
 *  user's choice survives repopulation. */
function populateTtsVoices() {
  const voices = synth.getVoices();
  if (!voices.length) return;
  const previous = ttsVoice.value;
  ttsVoice.textContent = "";
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "system default";
  ttsVoice.appendChild(defaultOption);
  for (const v of voices) {
    const option = document.createElement("option");
    option.value = v.voiceURI;
    option.textContent = `${v.name} (${v.lang})`;
    ttsVoice.appendChild(option);
  }
  if ([...ttsVoice.options].some((o) => o.value === previous)) ttsVoice.value = previous;
}
populateTtsVoices();
synth.addEventListener("voiceschanged", populateTtsVoices);
utterance.addEventListener("end", (event) => {
  setVoiceUi(false);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

button.addEventListener("click", toggleMicrophone);
voice.addEventListener("click", toggleComputerVoice);

bgToggle.addEventListener("click", () => {
  if (bgPlaying) stopBackground();
  else startBackground();
});

bgSound.addEventListener("change", () => {
  if (!bgPlaying) return;
  stopBackground();
  startBackground();
});

bgVolume.addEventListener("input", syncBgVolume);
syncBgVolume();

bgAudio.addEventListener("error", () => {
  setBgUi(false);
  logLine(`Background sound failed to load: ${bgAudio.error?.message ?? "unknown media error"}`, true);
});

// Release the mic and stop audio when the page is left (reload / bfcache).
window.addEventListener("pagehide", () => {
  stopMicrophone();
  stopBackground();
});
