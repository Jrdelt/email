# AGENTS.md

Browser extension (Chrome/Edge/Firefox, MV3, WXT) + Python ML pipeline for local phishing-email detection.
Read `docs/ROADMAP.md` for the task list. Pick the first unchecked task; do one task per change.

## Commands
- Extension (run in `extension/`): `npm install`, `npm run typecheck`, `npm test`, `npm run build:all`
- ML (run in `ml/`): `uv sync`, `uv run pytest`
- A task is done only when all four checks above pass and its acceptance criteria are met.

## Rules
- **Privacy:** no email content, URLs or sender addresses leave the browser. No network calls from the extension. No telemetry.
- **Parity contract:** `ml/src/phishml/features.py` and `extension/src/features.ts` must produce identical features.
  Any feature change updates both plus `ml/tests/fixtures/parity.json`, which both test suites read.
- **Permissions:** only `storage` and the webmail hosts in `wxt.config.ts`. Justify any addition in `docs/threat-model.md`.
- **Evaluation:** split by time, never randomly. Report precision at <=0.1% false-positive rate, not just accuracy.
- **Data:** raw data goes in `ml/data/raw/` (gitignored). Record source, license and collection date in `ml/data/SOURCES.md`.
- **UI safety:** build DOM with `textContent`; never `innerHTML` with email-derived data.
- No real phishing kits or live attack infrastructure. Use only public datasets and self-made test pages.
- Webmail selectors live only in `extension/src/adapters/`; never in feature or scoring code.

## Layout
- `extension/src/features.ts` scorer; `model.ts` ONNX inference (stub); `adapters/` per-webmail DOM extraction (stubs)
- `ml/src/phishml/` `features.py`, `data.py`, `train.py`, `evaluate.py`, `export_onnx.py` (stubs except features)
