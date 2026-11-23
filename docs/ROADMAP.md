# Roadmap

Each task lists acceptance criteria. Check the box when all are met and CI passes.

- [x] **T0 Scaffold**: extension builds for Chrome, Edge, Firefox; ml tests pass.
- [ ] **T1 Parity fixtures**: create `ml/tests/fixtures/parity.json` (>=20 cases: sender, body, links, expected features). Python and TS tests both load it and assert equal features.
- [ ] **T2 Data**: implement `phishml/data.py` `load_dataset()` returning a DataFrame with columns `sender, body, links, label, date, source`. Document sources in `ml/data/SOURCES.md`. Include a tiny synthetic sample under `ml/tests/fixtures/` so tests run offline.
- [ ] **T3 Baseline model**: `train.py` trains logistic regression on `FEATURE_NAMES`; `evaluate.py` does a time-based split and prints precision@0.1% FPR, PR-AUC, confusion matrix. Results table into `docs/results.md`.
- [ ] **T4 Better model**: small gradient-boosted trees (shallow, few trees) plus hashed text features; beat T3 on the same time split. Model JSON must stay under 200 KB.
- [ ] **T5 Model export**: `export_model.py` writes `extension/public/model.json` (weights or small tree ensemble, <200 KB) plus its SHA-256 in `model.sha256`. Test: a pure-Python reference evaluator of the JSON matches sklearn within 1e-6 on fixtures.
- [ ] **T6 In-extension inference**: `src/model.ts` loads the bundled JSON (no network, no ML runtime), verifies the hash, scores in plain TS, and matches the Python reference on fixtures. Falls back to heuristics if loading fails. Must meet the performance budget in AGENTS.md.
- [ ] **T7 Adapters**: implement adapters in `src/adapters/` for Gmail, Outlook (live/office/office365), Yahoo, Proton and iCloud, each returning `{sender, body, links}`. Unit-test each with saved, synthetic HTML fixtures (no real emails). Proton and iCloud render in iframes: resolve frame access first. Can be split per provider (T7a Gmail, T7b Outlook, T7c Yahoo, T7d Proton, T7e iCloud).
- [ ] **T8 Explainability**: top contributing features become the human-readable reasons in the banner and popup.
- [ ] **T9 Hardening**: evasion tests (homoglyphs, shorteners, HTML-only links); false-positive report and allowlist flow; update the threat model.
- [ ] **T9b Performance check**: measure scoring time and memory on a long email and a busy inbox; add a vitest benchmark asserting <10 ms.
- [ ] **T10 Release**: Playwright smoke test on Chromium and Firefox; `npm run zip:all`; store listings and the privacy policy.
