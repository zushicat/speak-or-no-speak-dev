#!/usr/bin/env node
/**
 * WP-B1 — bundle builder: single-file distributions of `speak-or-no-speak`.
 *
 * Produces (plan rev-2 §3, decisions D1–D3):
 *
 *   build/speak-or-no-speak.esm.js    ESM, named exports preserved — minified + .map
 *   build/speak-or-no-speak.iife.js   classic `<script>` build → global `SpeakOrNoSpeak`
 *
 * Scope (D2): bundles ONLY our own code. `@ricky0123/vad-web` is external —
 * it is resolved at RUNTIME by the consumer page via the pinned CDN `<script>`
 * tags (see README-BUNDLE.md) or by the consumer's own bundler. In the
 * browser bundle the bare dynamic `import()` in silero-vad-adapter.js cannot
 * resolve; the adapter catches that and the facade degrades to the energy
 * engine (WP7 ladder) — verified in WP-B2/WP-B4.
 *
 * F4 guard: `external` is a whitelist of exactly one package. Any NEW bare
 * import in `src/` that is not externalized makes esbuild fail loudly —
 * dependencies are never silently dropped.
 *
 * Usage:
 *     npm run build:bundle                 # minified artifacts (default)
 *     npm run build:bundle -- --no-minify  # readable rebuild for debugging (R3)
 *
 * Idempotent: same `src/` → byte-identical artifacts (no timestamps).
 */

import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "build");

const noMinify = process.argv.includes("--no-minify");

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/** Single-line banner (D3): name + version + docs pointer. */
const banner = (format) =>
  `/* speak-or-no-speak v${pkg.version} — single-file bundle (${format}).` +
  ` Docs: README-BUNDLE.md · rebuild: npm run build:bundle */`;

/** Shared esbuild options (plan §3). */
const common = {
  entryPoints: [path.join(root, "src/index.js")],
  bundle: true,
  platform: "browser",
  target: "es2020",
  minify: !noMinify,
  sourcemap: true,
  legalComments: "eof",
  // F4 guard — exactly the runtime-CDN VAD library. Anything else unresolvable
  // → hard build error, never a silently dropped dependency.
  external: ["@ricky0123/vad-web"],
  metafile: true,
  logLevel: "warning",
  absWorkingDir: root,
};

const esm = await build({
  ...common,
  format: "esm",
  outfile: path.join(outDir, "speak-or-no-speak.esm.js"),
  banner: { js: banner("ESM") },
});

const iife = await build({
  ...common,
  format: "iife",
  globalName: "SpeakOrNoSpeak", // exports → window.SpeakOrNoSpeak.*
  outfile: path.join(outDir, "speak-or-no-speak.iife.js"),
  banner: { js: banner("IIFE") },
});

// --- size report -----------------------------------------------------------

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
const rel = (file) => (file.startsWith("<") ? file : path.relative(root, file));

console.log("\nBundle artifacts:");
for (const meta of [esm.metafile, iife.metafile]) {
  for (const [file, out] of Object.entries(meta.outputs)) {
    if (file.endsWith(".map")) continue;
    console.log(`  ${rel(file).padEnd(42)} ${kb(out.bytes)}`);
  }
}

/** Per-module minified contribution — lives in metafile.outputs[key].inputs.
 *  The .map output is listed first and has an empty inputs map — pick the .js one. */
function contributions(meta) {
  const out = Object.entries(meta.outputs).find(([key]) => key.endsWith(".js"))?.[1];
  return out?.inputs ?? {};
}

/** Largest bundled modules by their own (minified) contribution. */
function largestInputs(meta, n = 8) {
  return Object.entries(contributions(meta))
    .filter(([file]) => file.startsWith("src/"))
    .map(([file, info]) => [file, info.bytesInOutput])
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

console.log("\nLargest bundled modules (ESM, minified contribution):");
for (const [file, bytes] of largestInputs(esm.metafile)) {
  console.log(`  ${file.padEnd(42)} ${kb(bytes)}`);
}
const contrib = contributions(esm.metafile);
const all = Object.entries(contrib).filter(([f]) => f.startsWith("src/"));
const total = all.reduce((sum, [, info]) => sum + info.bytesInOutput, 0);
console.log(`  ${all.length} modules from src/ — total contribution ${kb(total)}`);
