# Roadmap

Each task lists acceptance criteria. Check the box when all are met and CI passes.

- [x] **T0 Scaffold**: extension builds for Chrome, Edge, Firefox; ml tests pass.
- [ ] **T1 Parity fixtures**: create `ml/tests/fixtures/parity.json` (>=20 cases: sender, body, links, expected features). Python and TS tests both load it and assert equal features.
- [ ] **T2 Data**: implement `phishml/data.py` `load_dataset()` returning a DataFrame with columns `sender, body, links, label, date, source`. Document sources in `ml/data/SOURCES.md`. Include a tiny synthetic sample under `ml/tests/fixtures/` so tests run offline.
- [ ] **T3 Baseline model**: `train.py` trains logistic regression on `FEATURE_NAMES`; `evaluate.py` does a time-based split and prints precision@0.1% FPR, PR-AUC, confusion matrix. Results table into `docs/results.md`.
- [ ] **T4 Better model**: gradient boosting + TF-IDF text features; beat T3 on the same time split. Keep the model under 5 MB.
- [ ] **T5 ONNX export**: `export_onnx.py` writes `extension/public/model.onnx` plus a SHA-256 in `model.sha256`. Test: ONNX output matches sklearn within 1e-5 on fixtures.
- [ ] **T6 In-extension inference**: `src/model.ts` loads the model with onnxruntime-web (WASM, bundled, no CDN), verifies the hash, returns a score. Falls back to the heuristic scorer if loading fails.
- [ ] **T7 Adapters**: implement Gmail and Outlook adapters in `src/adapters/` returning `{sender, body, links}`. Unit-test with saved HTML fixtures (no real emails).
- [ ] **T8 Explainability**: top contributing features become the human-readable reasons in the banner and popup.
- [ ] **T9 Hardening**: evasion tests (homoglyphs, shorteners, HTML-only links); false-positive report and allowlist flow; update the threat model.
- [ ] **T10 Release**: Playwright smoke test on Chromium and Firefox; `npm run zip:all`; store listings and the privacy policy.
