/**
 * `createAgentAudioRoute` — cancelable agent audio via a WebRTC loopback
 * (rev 8.1 WP-E2, D6/D7/D8).
 *
 * Why: on desktop Chromium the page-played agent audio is NOT in the mic's
 * AEC reference unless the track was opened with `echoCancellation: "all"`
 * (WP-E1 D1) — and some deployments cannot rely on that. The one source the
 * browser's AEC *always* references is audio arriving as "remote participant"
 * audio on an `RTCPeerConnection`. This route plays the app's agent voice
 * through a local loopback (`MediaStreamDestination` → pc1 → pc2 →
 * `<audio>`), so the browser classifies it as remote audio and cancels it
 * from the mic. WebKit (Safari) already cancels system-wide — there the route
 * runs **direct** (no loopback, D7).
 *
 * The contract (D8 — hard rule, documented):
 *   1. Connect the TTS source to `route.input` — that is the ONLY wiring.
 *   2. Control volume on `route.gain` (pre-loopback, inside the AEC
 *      reference). Never on the output element (stays at 1.0).
 *   3. Do NOT also connect the source to `ctx.destination` — that would play
 *      the audio twice and leave one uncancelable copy.
 *   4. Create the route inside a user-gesture call chain (same click handler
 *      that starts the mic — R2), because `element.play()` needs it.
 *
 * Node-safety: importing the module must not touch browser globals; every
 * `window`/`AudioContext`/`RTCPeerConnection` access is inside the factory
 * (same discipline as the engines). Failures throw
 * `SpeakError("audio-pipeline", …)` — the app keeps its plain playback path
 * and the D5 stricter gating stays armed.
 *
 * @module agent-audio/echo-reference-route
 */

import { ERROR_CODES, SpeakError } from "../errors.js";

const ROUTE_MODES = new Set(["auto", "loopback", "direct"]);
/** Loopback connect must succeed within this window (host candidates, no servers). */
const CONNECT_TIMEOUT_MS = 5000;

/**
 * D7 mode resolution (pure): WebKit → "direct" (its system AEC already
 * references non-WebRTC audio — the loopback would be pure overhead);
 * everything else → "loopback". Junk/unknown input → "loopback" (the safe
 * default: harmless everywhere, required on Chromium).
 *
 * @param {string|undefined} userAgent  `navigator.userAgent`
 * @param {string|undefined} [vendor]  `navigator.vendor` — guard for Chromium
 *        forks whose UA lacks "Chrom"; a non-Apple vendor forces loopback
 * @returns {"loopback"|"direct"}
 */
export function resolveRouteMode(userAgent, vendor) {
  const ua = String(userAgent ?? "");
  const looksSafari = /Safari/.test(ua) && !/Chrom|Edg|OPR|Firefox/.test(ua);
  const vendorIsApple = vendor == null || /Apple/.test(vendor);
  return looksSafari && vendorIsApple ? "direct" : "loopback";
}

/**
 * Build the cancelable agent-audio route.
 *
 * @param {Object} [options]
 * @param {AudioContext} [options.audioContext]  reuse the app's context
 *        (default: the route creates and owns one — closed on stop())
 * @param {number} [options.gain]  initial `route.gain` value (default 1)
 * @param {"auto"|"loopback"|"direct"} [options.mode]  D7 (default "auto";
 *        explicit values always win — demo test hook `?routemode=`)
 * @returns {Promise<{ input: GainNode, gain: GainNode, element: HTMLAudioElement|null,
 *            outputElement: HTMLAudioElement|null, mode: "loopback"|"direct",
 *            context: AudioContext, ready: Promise<void>,
 *            getReferenceNode(): AudioNode, stop(): Promise<void> }>}
 */
export async function createAgentAudioRoute(options = {}) {
  const { audioContext, gain: initialGain = 1 } = options ?? {};
  const modeOption = options?.mode ?? "auto";
  if (!ROUTE_MODES.has(modeOption)) {
    throw new SpeakError(
      ERROR_CODES.AUDIO_PIPELINE,
      `createAgentAudioRoute: unknown mode ${JSON.stringify(modeOption)} — expected "auto" | "loopback" | "direct".`
    );
  }

  // Node / non-browser guard (must come after option validation so the mode
  // check stays testable outside a browser).
  if (typeof window === "undefined" || typeof AudioContext === "undefined") {
    throw new SpeakError(
      ERROR_CODES.AUDIO_PIPELINE,
      "createAgentAudioRoute requires a browser environment (AudioContext/window missing)."
    );
  }

  const ownedContext = !audioContext;
  const ctx = audioContext ?? new AudioContext();
  try {
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});

    const requestedMode = modeOption === "auto"
      ? resolveRouteMode(navigator.userAgent, navigator.vendor)
      : modeOption;

    // D8 wiring: source ──► input ──► gain ──► (loopback | destination)
    // `gain` is pre-loopback → inside the AEC reference → volume lives here.
    const input = ctx.createGain();
    const gain = ctx.createGain();
    gain.gain.value = initialGain;
    input.connect(gain);

    if (requestedMode === "direct") {
      // WebKit: straight to the speakers — Safari's system AEC references it.
      gain.connect(ctx.destination);
      return finalize({ ctx, ownedContext, input, gain, mode: "direct", element: null });
    }

    // Loopback (Chromium/Edge/Firefox/…): local RTCPeerConnection exchange,
    // no signaling servers, no STUN (host candidates suffice).
    if (typeof RTCPeerConnection === "undefined") {
      throw new SpeakError(ERROR_CODES.AUDIO_PIPELINE, "RTCPeerConnection unavailable — cannot build the AEC loopback route.");
    }

    const dest = ctx.createMediaStreamDestination();
    gain.connect(dest);

    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    pc1.onicecandidate = (e) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };
    pc2.onicecandidate = (e) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };

    const element = document.createElement("audio");
    element.autoplay = true;
    element.playsInline = true;
    element.muted = false;
    element.volume = 1.0; // D8: volume lives on route.gain, never here
    element.setAttribute("aria-hidden", "true");
    (document.body ?? document.documentElement).appendChild(element);

    pc2.ontrack = (e) => { element.srcObject = e.streams[0] ?? new MediaStream([e.track]); };
    pc1.addTrack(dest.stream.getAudioTracks()[0], dest.stream);

    // Local offer/answer exchange (both onicecandidate cross-feed above).
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);

    // Wait for the loopback to connect (bounded) before declaring readiness.
    await new Promise((resolve, reject) => {
      if (pc2.connectionState === "connected") return resolve();
      const timer = setTimeout(() => reject(new Error(`loopback connect timeout (${CONNECT_TIMEOUT_MS} ms, state=${pc2.connectionState})`)), CONNECT_TIMEOUT_MS);
      pc2.addEventListener("connectionstatechange", () => {
        if (pc2.connectionState === "connected") { clearTimeout(timer); resolve(); }
        else if (pc2.connectionState === "failed" || pc2.connectionState === "closed") {
          clearTimeout(timer);
          reject(new Error(`loopback connection ${pc2.connectionState}`));
        }
      });
    });

    // R2: the factory belongs in a user-gesture call chain — play() needs it.
    await element.play().catch((err) => {
      throw new Error(`element.play() rejected (${err?.name ?? err}) — call createAgentAudioRoute() inside a user-gesture handler.`);
    });

    return finalize({ ctx, ownedContext, input, gain, mode: "loopback", element, pc1, pc2 });
  } catch (err) {
    // Fail-soft teardown of everything built so far, then surface the error —
    // the app keeps plain playback + D5 stricter gating (R3).
    if (ownedContext) { try { await ctx.close(); } catch { /* noop */ } }
    throw new SpeakError(
      ERROR_CODES.AUDIO_PIPELINE,
      `createAgentAudioRoute failed: ${err?.message ?? err}`,
      err
    );
  }

  /** Attach the shared API surface to the built route. @private */
  function finalize({ ctx, ownedContext, input, gain, mode, element, pc1, pc2 }) {
    let stopped = false;
    /** @private reference-tap state (lazy — built on first subscribe) */
    let tapNode = null;
    let tapSink = null;
    const refCbs = new Set();
    const buildTap = async () => {
      // Pass-through tap on the reference node: worklet first (posts Float32Array
      // copies), ScriptProcessor fallback (engine-adapter pattern — SP is
      // deprecated but universally supported).
      try {
        const src = "class Tap extends AudioWorkletProcessor{process(i){const c=i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('sons-echo-tap',Tap)";
        const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
        try { await ctx.audioWorklet.addModule(url); }
        finally { URL.revokeObjectURL(url); }
        tapNode = new AudioWorkletNode(ctx, "sons-echo-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        tapNode.port.onmessage = (e) => { for (const cb of refCbs) { try { cb(e.data); } catch { /* listener error must not kill the tap */ } } };
      } catch {
        tapNode = ctx.createScriptProcessor(1024, 1, 1);
        tapNode.onaudioprocess = (e) => {
          const copy = e.inputBuffer.getChannelData(0).slice(0);
          for (const cb of refCbs) { try { cb(copy); } catch { /* listener error must not kill the tap */ } }
        };
      }
      // The tap needs a connected path to run; a zero-gain sink keeps it silent.
      tapSink = ctx.createGain();
      tapSink.gain.value = 0;
      gain.connect(tapNode);
      tapNode.connect(tapSink);
      tapSink.connect(ctx.destination);
    };
    const teardownTap = () => {
      try { tapNode && (tapNode.onaudioprocess = null, tapNode.port && (tapNode.port.onmessage = null), tapNode.disconnect()); } catch { /* noop */ }
      try { tapSink && tapSink.disconnect(); } catch { /* noop */ }
      try { gain.disconnect(tapNode); } catch { /* noop */ }
      tapNode = null;
      tapSink = null;
    };
    return {
      input,
      gain,
      element,
      /** alias of `element` (master-plan wording) */
      get outputElement() { return element; },
      mode,
      context: ctx,
      /** Resolves when the route is ready to carry audio (pre-resolved post-factory). */
      ready: Promise.resolve(),
      /**
       * The node whose output IS the audible (and AEC-referenced) signal —
       * the pre-loopback tap for the WP-E3 correlation gate.
       */
      getReferenceNode() { return gain; },
      /**
       * WP-E3: subscribe to reference-tap frames (Float32Array copies at the
       * route context's sample rate). The tap is built lazily on the first
       * subscription and torn down when the last one unsubscribes.
       * @param {(samples: Float32Array) => void} cb
       * @returns {() => void} unsubscribe
       */
      onReferenceFrame(cb) {
        refCbs.add(cb);
        if (!tapNode) buildTap().catch(() => { /* gate stays off without a tap */ });
        return () => {
          refCbs.delete(cb);
          if (refCbs.size === 0) teardownTap();
        };
      },
      /** Idempotent teardown: pcs, element, tap, owned context. */
      async stop() {
        if (stopped) return;
        stopped = true;
        if (pc1) { try { pc1.close(); } catch { /* noop */ } }
        if (pc2) { try { pc2.close(); } catch { /* noop */ } }
        try { input.disconnect(); gain.disconnect(); } catch { /* noop */ }
        teardownTap();
        refCbs.clear();
        if (element) {
          try { element.pause(); element.srcObject = null; element.remove(); } catch { /* noop */ }
        }
        if (ownedContext) { try { await ctx.close(); } catch { /* noop */ } }
      },
    };
  }
}
