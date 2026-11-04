/**
 * WP-E1 — honest AEC scope: classifier table, constraint negotiation
 * (D1/D2/D3), D4 fallback constraints, D5 stricter-gating rule, and the
 * facade's degraded/`noAecMode` wiring — all pure Node (no browser).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AEC_SCOPE,
  AEC_CONSTRAINTS,
  classifyAecScope,
  isAllStyleRequest,
  endedFallbackConstraints,
  strictGatingActive,
} from "../../src/vad/aec-scope.js";
import { DEFAULTS, mergeOptions } from "../../src/config.js";
import { ERROR_CODES, humanMessage } from "../../src/errors.js";
import { SileroVadAdapter } from "../../src/vad/silero-vad-adapter.js";
import { createSpeakOrNoSpeak } from "../../src/speak-or-no-speak.js";

const SAMPLES = 512, SAMPLE_RATE = 16000;

/** Minimal VadEngine double WITH the WP-E1 aecScope field. */
class ScopedMockEngine {
  constructor(aecScope) {
    this.frameCbs = [];
    this.errCbs = [];
    this.startedCount = 0;
    this.stoppedCount = 0;
    this.aecScope = aecScope;
    this.aecDegraded = aecScope === AEC_SCOPE.NONE; // derived, as the real engines do
  }
  async start() { this.startedCount++; }
  stop() { this.stoppedCount++; }
  pause() {}
  resume() {}
  onFrame(cb) { this.frameCbs.push(cb); }
  onError(cb) { this.errCbs.push(cb); }
}

/** VadEngine double WITHOUT aecScope — the legacy/injected-engine shape. */
class LegacyMockEngine extends ScopedMockEngine {
  constructor(aecDegraded) {
    super(undefined);
    this.aecScope = undefined;
    this.aecDegraded = aecDegraded;
  }
}

// --------------------------------------------------------------- 1. classifier

test("classifyAecScope: value table (D2/D3)", () => {
  assert.equal(classifyAecScope({ echoCancellation: "all" }), AEC_SCOPE.ALL);
  assert.equal(classifyAecScope({ echoCancellation: "remote-only" }), AEC_SCOPE.REMOTE_ONLY);
  assert.equal(classifyAecScope({ echoCancellation: true }), AEC_SCOPE.UNKNOWN);
  assert.equal(classifyAecScope({ echoCancellation: false }), AEC_SCOPE.NONE);
  assert.equal(classifyAecScope({}), AEC_SCOPE.NONE, "missing key → none");
  assert.equal(classifyAecScope(null), AEC_SCOPE.NONE, "no settings → none");
  assert.equal(classifyAecScope(undefined), AEC_SCOPE.NONE);
  assert.equal(classifyAecScope({ echoCancellation: "yes" }), AEC_SCOPE.NONE, "unexpected value → none");
});

test("classifyAecScope: the requested value never changes the classification (getSettings can lie)", () => {
  for (const requested of [true, false, undefined, { ideal: "all" }, { exact: "all" }]) {
    assert.equal(classifyAecScope({ echoCancellation: true }, requested), AEC_SCOPE.UNKNOWN);
    assert.equal(classifyAecScope({ echoCancellation: "all" }, requested), AEC_SCOPE.ALL);
    assert.equal(classifyAecScope({ echoCancellation: false }, requested), AEC_SCOPE.NONE);
  }
});

// ------------------------------------------------- 2. constraint shape (D1)

test("AEC_CONSTRAINTS + DEFAULTS.mic: {ideal:'all'} as an ideal, NS/AGC on, mono", () => {
  assert.deepEqual(AEC_CONSTRAINTS.echoCancellation, { ideal: "all" });
  assert.equal(AEC_CONSTRAINTS.noiseSuppression, true);
  assert.equal(AEC_CONSTRAINTS.autoGainControl, true);
  assert.equal(AEC_CONSTRAINTS.channelCount, 1);
  // single source of truth: DEFAULTS.mic must stay in sync with the engines
  assert.deepEqual(DEFAULTS.mic, AEC_CONSTRAINTS);
});

test("mergeOptions: user primitive beats the {ideal:'all'} object; object overrides merge recursively", () => {
  const off = mergeOptions({ mic: { echoCancellation: false } }, DEFAULTS);
  assert.equal(off.mic.echoCancellation, false, "user `false` wins (D1 back-compat)");

  const remote = mergeOptions({ mic: { echoCancellation: { ideal: "remote-only" } } }, DEFAULTS);
  assert.deepEqual(remote.mic.echoCancellation, { ideal: "remote-only" });

  const untouched = mergeOptions({}, DEFAULTS);
  assert.deepEqual(untouched.mic.echoCancellation, { ideal: "all" }, "default stays {ideal:'all'}");
});

// --------------------------------------------------- 3. D4 fallback decision

test("isAllStyleRequest + endedFallbackConstraints (D4)", () => {
  assert.equal(isAllStyleRequest({ ideal: "all" }), true);
  assert.equal(isAllStyleRequest({ exact: "all" }), true);
  assert.equal(isAllStyleRequest(true), false);
  assert.equal(isAllStyleRequest(false), false);
  assert.equal(isAllStyleRequest(undefined), false);

  const fallback = endedFallbackConstraints({ ideal: "all" });
  assert.ok(fallback, "all-style request → fallback constraints");
  assert.equal(fallback.echoCancellation, true, "fallback = browser default");
  assert.equal(fallback.noiseSuppression, true);
  assert.equal(fallback.autoGainControl, true);
  assert.equal(fallback.channelCount, 1);

  assert.equal(endedFallbackConstraints(true), null, "boolean request → no AEC fallback");
  assert.equal(endedFallbackConstraints(false), null);
  assert.equal(endedFallbackConstraints(undefined), null);
});

// ------------------------------------------------------ 4. D5 gating rule

test("strictGatingActive: auto matrix (scope × routed)", () => {
  const auto = "auto";
  assert.equal(strictGatingActive("none", false, auto), true, "none → stricter");
  assert.equal(strictGatingActive("none", true, auto), true, "none → stricter even routed");
  assert.equal(strictGatingActive("unknown", false, auto), true, "unknown, unrouted → stricter");
  assert.equal(strictGatingActive("unknown", true, auto), false, "unknown + active route → normal");
  assert.equal(strictGatingActive("remote-only", false, auto), true);
  assert.equal(strictGatingActive("remote-only", true, auto), false);
  assert.equal(strictGatingActive("all", false, auto), false, "all → normal gating");
  assert.equal(strictGatingActive("all", true, auto), false);
  assert.equal(strictGatingActive(undefined, false, auto), true, "missing scope → safe default (unknown)");
});

test("strictGatingActive: on/off overrides", () => {
  assert.equal(strictGatingActive("all", true, "on"), true, "on forces stricter");
  assert.equal(strictGatingActive("none", false, "off"), false, "off forces normal");
});

// --------------------------------------- 5. facade: degraded + D5 wiring

test("facade degraded: {aec, engine, aecScope} per scope (D2)", async () => {
  const unknown = await createSpeakOrNoSpeak({ engine: new ScopedMockEngine("unknown") });
  await unknown.start();
  assert.deepEqual(unknown.degraded, { aec: false, engine: "silero", aecScope: "unknown" });

  const none = await createSpeakOrNoSpeak({ engine: new ScopedMockEngine("none") });
  await none.start();
  assert.deepEqual(none.degraded, { aec: true, engine: "silero", aecScope: "none" });

  const all = await createSpeakOrNoSpeak({ engine: new ScopedMockEngine("all") });
  await all.start();
  assert.deepEqual(all.degraded, { aec: false, engine: "silero", aecScope: "all" });
});

test("facade D5: noAecMode = scope × routed × strictGating (auto)", async () => {
  const engine = new ScopedMockEngine("unknown");
  const sons = await createSpeakOrNoSpeak({ engine });
  await sons.start();
  assert.equal(sons._detector.noAecMode, true, "unknown + unrouted → stricter");

  sons.setAgentAudioRouted(true);
  assert.equal(sons._detector.noAecMode, false, "route active → normal gating (R5)");

  sons.setAgentAudioRouted(false);
  assert.equal(sons._detector.noAecMode, true, "route withdrawn → stricter again");
  sons.stop();

  const allEngine = new ScopedMockEngine("all");
  const allSons = await createSpeakOrNoSpeak({ engine: allEngine });
  await allSons.start();
  assert.equal(allSons._detector.noAecMode, false, "all → normal, even unrouted");
  allSons.setAgentAudioRouted(true);
  assert.equal(allSons._detector.noAecMode, false, "all + routed → normal");
  allSons.stop();

  const noneEngine = new ScopedMockEngine("none");
  const noneSons = await createSpeakOrNoSpeak({ engine: noneEngine });
  await noneSons.start();
  assert.equal(noneSons._detector.noAecMode, true, "none → stricter");
  noneSons.setAgentAudioRouted(true);
  assert.equal(noneSons._detector.noAecMode, true, "none → stricter even routed");
  noneSons.stop();
});

test("facade D5: strictGating on/off overrides beat the scope", async () => {
  const on = await createSpeakOrNoSpeak({ engine: new ScopedMockEngine("all"), strictGating: "on" });
  await on.start();
  assert.equal(on._detector.noAecMode, true, "on → stricter regardless of scope");
  on.stop();

  const off = await createSpeakOrNoSpeak({ engine: new ScopedMockEngine("none"), strictGating: "off" });
  await off.start();
  assert.equal(off._detector.noAecMode, false, "off → normal regardless of scope");
  off.stop();
});

test("facade: stop() resets the route declaration; legacy engines keep the WP5 rule", async () => {
  const engine = new ScopedMockEngine("unknown");
  const sons = await createSpeakOrNoSpeak({ engine });
  await sons.start();
  sons.setAgentAudioRouted(true);
  assert.equal(sons._detector.noAecMode, false);
  sons.stop();
  await sons.start();
  assert.equal(sons._detector.noAecMode, true, "route declaration reset by stop()");

  const legacy = new LegacyMockEngine(false); // aecDegraded=false, no aecScope
  const legacySons = await createSpeakOrNoSpeak({ engine: legacy });
  await legacySons.start();
  assert.equal(legacySons._detector.noAecMode, false, "legacy engine, aecDegraded=false → WP5 rule (false)");
  assert.equal(legacySons.degraded.aecScope, "unknown", "legacy engine reports honest unknown");
  assert.equal(legacySons.degraded.aec, false);

  const legacyBad = new LegacyMockEngine(true);
  const legacyBadSons = await createSpeakOrNoSpeak({ engine: legacyBad });
  await legacyBadSons.start();
  assert.equal(legacyBadSons._detector.noAecMode, true, "legacy engine, aecDegraded=true → WP5 rule (true)");
  assert.equal(legacyBadSons.degraded.aec, true);
});

// ------------------------------------------------------ 6. human messages

test("humanMessage: new AEC-scope codes read as prose a UI can show", () => {
  const limited = humanMessage(ERROR_CODES.AEC_SCOPE_LIMITED);
  assert.match(limited, /createAgentAudioRoute/);
  assert.match(limited, /echo cancellation/i);

  const fallback = humanMessage(ERROR_CODES.AEC_SCOPE_FALLBACK);
  assert.match(fallback, /OS permission/i);
  assert.match(fallback, /fell back/i);

  const noAec = humanMessage(ERROR_CODES.NO_AEC);
  assert.match(noAec, /stricter barge-in gating/);
});

// --------------------------------- 7. D4 ended-fallback flow (fake track)

/** Mic track double: reports settings; dieInMs 0 = already ended at attach
 *  (the Chromium 479234114 fast-fail shape), null = lives, >0 = dies later. */
class FakeTrack {
  constructor(settings, dieInMs) {
    this.settings = settings;
    this._ended = [];
    this.readyState = dieInMs === 0 ? "ended" : "live";
    this._dieTimer = dieInMs ? setTimeout(() => {
      this.readyState = "ended";
      for (const fn of this._ended) fn();
    }, dieInMs) : null;
  }
  getSettings() { return this.settings; }
  addEventListener(type, fn) {
    if (type === "ended") { this._ended.push(fn); if (this.readyState === "ended") fn(); }
  }
  removeEventListener(type, fn) {
    if (type === "ended") this._ended = this._ended.filter((f) => f !== fn);
  }
  stop() { if (this._dieTimer) clearTimeout(this._dieTimer); }
}
class FakeStream {
  constructor(track) { this.track = track; }
  getAudioTracks() { return [this.track]; }
  getTracks() { return [this.track]; }
}
const FAKE_VAD_LIB = { MicVAD: { new: async () => ({ start() {}, pause() {} }) } };

/** Swap in a fake navigator.mediaDevices for the duration of fn. */
async function withFakeNavigator(getUserMedia, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    configurable: true, writable: true,
  });
  try { return await fn(); }
  finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
}

test("D4: 'all' track ends during build → exactly one re-request with echoCancellation:true", async () => {
  const gumAudio = [];
  const getUserMedia = async ({ audio }) => {
    gumAudio.push(audio);
    if (gumAudio.length === 1) return new FakeStream(new FakeTrack({ echoCancellation: "all" }, 0)); // dies fast
    return new FakeStream(new FakeTrack({ echoCancellation: true }, null)); // fallback stream lives
  };
  await withFakeNavigator(getUserMedia, async () => {
    const adapter = new SileroVadAdapter();
    adapter._micIntent = "running"; // white-box: start() normally sets this
    const warnings = [];
    adapter.onError((e) => warnings.push(e));
    const vad = await adapter._openMicAndBuildVad(FAKE_VAD_LIB);
    assert.ok(vad, "pipeline built on the fallback stream");
    assert.equal(gumAudio.length, 2, "exactly one re-request");
    assert.equal(gumAudio[1].echoCancellation, true, "re-request uses the browser default");
    assert.equal(adapter._aecFallbackUsed, true);
    assert.equal(adapter.aecScope, "unknown", "fallback scope honestly unknown");
    assert.equal(adapter.aecDegraded, false, "unknown is not 'none'");
    assert.equal(
      warnings.filter((w) => w.code === "aec-scope-fallback").length, 1,
      "one-time aec-scope-fallback warning"
    );
  });
});

test("D4: healthy 'all' track → no re-request, no fallback warning", async () => {
  const gumAudio = [];
  const getUserMedia = async ({ audio }) => {
    gumAudio.push(audio);
    return new FakeStream(new FakeTrack({ echoCancellation: "all" }, null));
  };
  await withFakeNavigator(getUserMedia, async () => {
    const adapter = new SileroVadAdapter();
    const warnings = [];
    adapter.onError((e) => warnings.push(e));
    await adapter._openMicAndBuildVad(FAKE_VAD_LIB);
    assert.equal(gumAudio.length, 1, "single request");
    assert.equal(adapter.aecScope, "all");
    assert.equal(warnings.filter((w) => w.code === "aec-scope-fallback").length, 0);
    assert.equal(adapter._aecFallbackUsed, false);
  });
});

test("D4: retry's track dies too → audio-pipeline, not a second retry", async () => {
  const gumAudio = [];
  const getUserMedia = async ({ audio }) => {
    gumAudio.push(audio);
    return new FakeStream(new FakeTrack({ echoCancellation: "all" }, 0)); // every track dies
  };
  await withFakeNavigator(getUserMedia, async () => {
    const adapter = new SileroVadAdapter();
    adapter._micIntent = "running"; // white-box: start() normally sets this
    const warnings = [];
    adapter.onError((e) => warnings.push(e));
    await assert.rejects(
      () => adapter._openMicAndBuildVad(FAKE_VAD_LIB),
      (err) => err.code === "audio-pipeline"
    );
    assert.equal(gumAudio.length, 2, "initial + one fallback, no loop");
    assert.equal(
      warnings.filter((w) => w.code === "aec-scope-fallback").length, 1,
      "fallback warning still exactly once"
    );
  });
});

test("D4: boolean-request track dying is an ordinary mic failure (no AEC fallback)", async () => {
  const gumAudio = [];
  const getUserMedia = async ({ audio }) => {
    gumAudio.push(audio);
    return new FakeStream(new FakeTrack({ echoCancellation: true }, 0));
  };
  await withFakeNavigator(getUserMedia, async () => {
    const adapter = new SileroVadAdapter({ mic: { echoCancellation: true } });
    adapter._micIntent = "running"; // white-box: start() normally sets this
    const warnings = [];
    adapter.onError((e) => warnings.push(e));
    await assert.rejects(
      () => adapter._openMicAndBuildVad(FAKE_VAD_LIB),
      (err) => err.code === "audio-pipeline"
    );
    assert.equal(gumAudio.length, 1, "no re-request for boolean requests");
    assert.equal(warnings.filter((w) => w.code === "aec-scope-fallback").length, 0);
  });
});
