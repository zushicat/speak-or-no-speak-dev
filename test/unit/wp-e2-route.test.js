/**
 * WP-E2 — cancelable agent-audio route: mode resolution (D7), export surface,
 * Node-import safety, option validation. (The loopback wiring itself is
 * browser-bound and verified in the WP-E2 browser matrix.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveRouteMode, createAgentAudioRoute } from "../../src/agent-audio/echo-reference-route.js";
import * as index from "../../src/index.js";
import { ERROR_CODES } from "../../src/errors.js";

// ------------------------------------------------------- 1. mode resolution

const UAS = {
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.2 Safari/605.1.15",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",
  firefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
  ego: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 EgoBrowser/1.0",
};

test("resolveRouteMode (D7): WebKit → direct, everything else → loopback", () => {
  assert.equal(resolveRouteMode(UAS.safari, "Apple Computer, Inc."), "direct");
  assert.equal(resolveRouteMode(UAS.chrome, "Google Inc."), "loopback");
  assert.equal(resolveRouteMode(UAS.edge, "Google Inc."), "loopback");
  assert.equal(resolveRouteMode(UAS.firefox, undefined), "loopback");
  assert.equal(resolveRouteMode(UAS.ego, "Google Inc."), "loopback", "Chromium-family → loopback");
});

test("resolveRouteMode: vendor guard + junk input → safe default (loopback)", () => {
  assert.equal(resolveRouteMode(UAS.safari, "Google Inc."), "loopback", "non-Apple vendor wins over a Safari-ish UA");
  assert.equal(resolveRouteMode(UAS.safari, undefined), "direct", "vendor absent (Firefox-style) → UA decides");
  assert.equal(resolveRouteMode("", undefined), "loopback", "junk UA → loopback");
  assert.equal(resolveRouteMode(undefined, undefined), "loopback", "no UA → loopback");
  assert.equal(resolveRouteMode("totally not a browser", "someone"), "loopback");
});

// --------------------------------------------------------- 2. export surface

test("src/index.js export surface includes createAgentAudioRoute (F8)", async () => {
  assert.equal(typeof index.createAgentAudioRoute, "function");
  const names = Object.keys(index);
  assert.ok(names.includes("createAgentAudioRoute"));
  // surface grows per WP (rev-2: 16 → WP-E2: 17 → WP-E4: 20 with the voice
  // gate); the authoritative exact list lives in test/bundle-verify-main.js.
  assert.equal(names.length, 20, `got: ${names.join(", ")}`);
});

// ------------------------------------------------ 3. Node import + guards

test("route module: Node import is clean; factory rejects with audio-pipeline outside a browser", async () => {
  // importing the module at the top of this file already proves no window access
  await assert.rejects(
    () => createAgentAudioRoute(),
    (err) => err.code === ERROR_CODES.AUDIO_PIPELINE
  );
});

test("route module: unknown mode → audio-pipeline error (validated before the browser guard)", async () => {
  await assert.rejects(
    () => createAgentAudioRoute({ mode: "bogus" }),
    (err) => err.code === ERROR_CODES.AUDIO_PIPELINE && /unknown mode/.test(err.message)
  );
  await assert.rejects(
    () => createAgentAudioRoute({ mode: 42 }),
    (err) => err.code === ERROR_CODES.AUDIO_PIPELINE
  );
});
