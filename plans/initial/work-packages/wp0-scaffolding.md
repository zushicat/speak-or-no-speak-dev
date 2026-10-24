# WP0 — Project scaffolding (zero-build)

- **Status:** planned
- **Phase:** M1
- **Estimate:** 0.5 d
- **Depends on:** —
- **Decisions applied:** D1 (zero-build, CDN, no bundler/no TS compile), D4 (package name `speak-or-no-speak`)
- **Master plan:** [plan-initial.md](../plan-initial.md) · Analysis: [problem-analysis-initial.md](../problem-analysis-initial.md)

## Objective

A static project that serves `index.html` on `http://localhost:5173` with no build step, no installed dependencies, and the final directory skeleton in place. Mic access requires a **secure context** — `localhost` qualifies; `file://` does **not** — so a static HTTP server is part of the workflow from day one.

## Prerequisites

- Node ≥ 18 (for `node --test` in later WPs; not needed to serve) and/or Python 3 (for serving).
- Modern Chromium browser and/or Safari for verification.

## Steps

### 0.1 `package.json` (no dependencies, ESM)

```json
{
  "name": "speak-or-no-speak",
  "version": "0.0.1",
  "description": "Detects speech start, turn end, and barge-in from a microphone stream (Silero VAD + adaptive endpointing + browser AEC).",
  "type": "module",
  "license": "MIT",
  "scripts": {
    "start": "python3 -m http.server 5173",
    "start:serve": "npx --yes serve -l 5173 .",
    "test": "node --test test/unit/"
  }
}
```

Notes:
- `"type": "module"` makes later `node --test test/unit/` work on plain ESM without any transpiler.
- No `dependencies` at all. The two runtime libraries (ONNX Runtime Web, `@ricky0123/vad-web`) are loaded from CDN `<script>` tags (D1) — see WP1.
- `start` uses `python3` (present by default on macOS); `start:serve` is the cross-platform fallback. Document both in the README.

### 0.2 `.gitignore`

```
node_modules/
.DS_Store
*.log
test/recordings/
vendor/
```

(`vendor/` is the optional local mirror of the CDN scripts — see WP1 risks; `test/recordings/` holds potentially large calibration audio.)

### 0.3 Directory skeleton with stub files

```
speak-or-no-speak/
├── index.html                  # stub: "hello" page (real version in WP2)
├── demo/
│   └── main.js                 # stub: console.log('demo boot ok')
├── src/
│   ├── index.js                # stub: export {}
│   ├── types.js                # placeholder (JSDoc typedefs arrive in WP3)
│   ├── config.js               # placeholder
│   ├── errors.js               # placeholder (WP7)
│   ├── speak-or-no-speak.js    # placeholder (WP3)
│   ├── vad/
│   │   ├── vad-engine.js       # placeholder (WP1)
│   │   ├── silero-vad-adapter.js  # placeholder (WP1)
│   │   └── energy-vad.js       # placeholder (WP7)
│   ├── turn/
│   │   ├── turn-detector.js    # placeholder (WP3)
│   │   └── ring-buffer.js      # placeholder (WP3)
│   └── turn-model/             # empty (WP8, conditional)
├── test/
│   ├── unit/                   # empty (WP3+)
│   └── util/                   # empty (WP4: wav-export.js)
├── plans/                      # existing docs
├── package.json
├── .gitignore
└── README.md                   # stub
```

Empty dirs need a `.gitkeep` to be committed.

### 0.4 README stub

Must contain at minimum:

```markdown
# Speak Or No Speak
Detects: speech start · turn end · barge-in interruption.

## Run the demo
    npm start          # python3 http.server on http://localhost:5173
    npm run start:serve  # alternative via npx serve

Open http://localhost:5173 (a secure context is required for microphone access —
`file://` will NOT work). Click **Start microphone** and allow the prompt.

## Status
Work in progress — see plans/initial/plan-initial.md.
```

### 0.5 Verify serving + secure context

- [ ] Run `npm start`, open `http://localhost:5173` — page loads, console clean.
- [ ] In `demo/main.js` stub, probe once and log:

```js
console.log('secure context:', window.isSecureContext,
            'mediaDevices:', !!navigator.mediaDevices);
```

- [ ] Both flags must be `true` on `localhost` (if `mediaDevices` is undefined → not served over a secure context; fix serving, do not proceed).
- [ ] `npm test` runs and reports "0 tests" without error (runner wiring works).

## Acceptance criteria

- [ ] `npm start` serves the stub page at `http://localhost:5173`, console clean.
- [ ] `window.isSecureContext === true` and `navigator.mediaDevices` exists on the served page.
- [ ] Directory tree matches §0.3; no build config files (no `vite.config.*`, no `tsconfig.json`) — that is the point of D1.
- [ ] `npm test` executes via `node --test`.
- [ ] Package name is `speak-or-no-speak` (D4).

## Risks

| Risk | Mitigation |
|---|---|
| No `python3` on a contributor machine | `npm run start:serve` (`npx serve`); document both |
| Port 5173 occupied | Use `-l`/`-p` with another port; nothing in the code hardcodes it |
| Opening `index.html` via double-click (`file://`) | README warning + WP0.5 probe makes the failure obvious instead of mysterious |

## Deliverables

- `package.json`, `.gitignore`, `README.md`, skeleton tree, verified dev server workflow.
