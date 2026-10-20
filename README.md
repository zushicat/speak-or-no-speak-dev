# Speak Or No Speak

Detects: speech start · turn end · barge-in interruption.

## Run the demo

    npm start            # python3 http.server on http://localhost:5173
    npm run start:serve  # alternative via npx serve

Open http://localhost:5173 (a secure context is required for microphone access —
`file://` will NOT work). Click **Start microphone** and allow the prompt.

## Requirements

- Serving: Python 3 (default on macOS) — or Node + `npx serve` via `start:serve`.
- Tests: Node ≥ 18 (`node --test`, zero test dependencies).
- Browsers: a current Chromium browser and/or Safari.

## Layout (zero-build)

No bundler, no TypeScript compile — plain ES modules loaded straight from the
static server, runtime libraries pinned via CDN `<script>` tags.

    index.html        demo page (green/orange listening indicator)
    demo/             demo wiring — UI mapping only, no detection logic
    src/              the module (facade, VAD adapters, turn state machine)
    test/unit/        node --test suite · test/util/ + test/harness (later WPs)
    plans/            implementation plan & work packages (not published)

## Status

Work in progress — see plans/initial/plan-initial.md.
