# Roadmap

Each task lists its acceptance criteria. Check the box when all of them are met and CI passes.

## Done

- [x] **T0 Scaffold**: extension builds for Chrome, Edge, Firefox; ml tests pass.
- [x] **T0b Detection actions**: a banner (in Shadow DOM) with three actions:
  - "I trust this email": saved locally as a one-way SHA-256 fingerprint so it survives page refreshes; can be reversed with the inline **Undo** pill or **Clear** in the popup.
  - "Always trust sender": a local allowlist, enabled only when a valid sender address was extracted and the sender passed the authentication and relay checks; manageable in the popup.
  - "Not phishing": a local false-positive report that stores no email content.

  Links and forms in flagged emails stay locked until unlocked.
- [x] **T0c Sender and domain checks**: the banner shows the sender, address validity, `via` relay, authentication and domain details.
  - Local warnings: invalid address; a brand name sent from the wrong domain (including squashed or camelCase forms); lookalike or punycode domains; an address inside the display name; a conflicting relay or failed authentication.
  - Online lookups of domains only: RDAP (age, registrar), MX/SPF/DMARC, NXDOMAIN, URIBL spam reports; cached 24 h.
  - Any sender or domain warning pauses links, the same as content warnings. Reading the email is never blocked.
- [x] **T0d Defense-in-depth, click-time guard and UX hardening**:
  - UI: neo-brutalist banner, popup and icon styling; paused-action toast; 2-step unlock for `danger` alerts; `From` vs `Links go to` comparison; Undo pill after trusting.
  - Coverage: scanning every message in a thread (`extractAll`); auto-synced repo-root `chrome-mv3/` build; cross-frame iCloud Mail adapter (`allFrames: true` with a stateless, `sender.url`-verified relay); cloud-storage HTML lures and more urgency and brand patterns.
  - Hardening: DOM-clobbering-safe `linkLock`, `attachmentLock` and `extract` (`formaction`, SVG `href`/`xlink:href`, `<a ping>`, `keydown` `Enter`/`Space`, instant re-locking of new DOM nodes); Shadow DOM `:host { all: initial !important }` mounted on `document.documentElement`; strict MV3 CSP.
  - Attachments: always blocked in untrusted emails, with local file-name risk checks.
  - Clicks: click-time destination check, `warning.html` page with a recovery guide, and a 400 ms scan race gate.
- [x] **T1 Parity fixtures**: create `ml/tests/fixtures/parity.json` (>=20 cases: sender, body, links, expected features). Python and TS tests both load it and assert equal features.

## Open

- [ ] **T2 Data**: implement `phishml/data.py` `load_dataset()` returning a DataFrame with columns `sender, body, links, label, date, source`. Document sources in `ml/data/SOURCES.md`. Include a tiny synthetic sample under `ml/tests/fixtures/` so tests run offline.
- [ ] **T3 Baseline model**: `train.py` trains logistic regression on `FEATURE_NAMES`; `evaluate.py` does a time-based split and prints precision@0.1% FPR, PR-AUC, confusion matrix. Results table into `docs/results.md`.
- [ ] **T4 Better model**: small gradient-boosted trees (shallow, few trees) plus hashed text features; beat T3 on the same time split. Model JSON must stay under 200 KB.
- [ ] **T5 Model export**: `export_model.py` writes `extension/public/model.json` (weights or small tree ensemble, <200 KB) plus its SHA-256 in `model.sha256`. Test: a pure-Python reference evaluator of the JSON matches sklearn within 1e-6 on fixtures.
- [ ] **T6 In-extension inference**: `src/model.ts` loads the bundled JSON (no network, no ML runtime), verifies the hash, scores in plain TS, and matches the Python reference on fixtures. Falls back to heuristics if loading fails. Must meet the performance budget in AGENTS.md.
- [ ] **T7 Adapters**: implement and verify adapters in `src/adapters/` for Gmail, Outlook (`live`/`office`/`office365`/`outlook.cloud.microsoft`), Yahoo (`mail.yahoo.com`), Proton (`mail.proton.me`), and iCloud, each returning `{sender, body, links}`. Can be tracked per provider (T7a Gmail, T7b Outlook, T7c Yahoo, T7d Proton, T7e iCloud).
  - *Progress:* all 5 adapters are implemented and unit-tested against synthetic DOM fixtures (`gmail`, `outlook`, `icloud`, `yahoo`, `proton`). Live inbox verification and real, sanitized end-to-end smoke fixtures are still needed before this can be checked off.
- [ ] **T8 Explainability**: top contributing features become the human-readable reasons in the banner and popup.
- [ ] **T9 Hardening**: evasion tests (homoglyphs, shorteners, HTML-only links); false-positive report and allowlist flow; update the threat model.
- [ ] **T9b Performance check**: measure scoring time and memory on a long email and a busy inbox; add a vitest benchmark asserting <10 ms.
- [ ] **T10 Release**: Playwright smoke test on Chromium and Firefox; `npm run zip:all`; store listings and the privacy policy.
