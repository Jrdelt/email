# AGENTS.md

Browser extension (Chrome/Edge/Firefox, MV3, WXT) + Python ML pipeline for local phishing-email detection.
Read `docs/ROADMAP.md` for the task list. Pick the first unchecked task; do one task per change.

## Commands
- Extension (run in `extension/`): `npm install`, `npm run typecheck`, `npm test`, `npm run build:all`
- ML (run in `ml/`): `uv sync`, `uv run pytest`
- A task is done only when all four checks above pass and its acceptance criteria are met.

## Rules
- **Privacy:** no email content, URLs or sender addresses leave the browser. No telemetry.
  The ONLY network traffic is domain lookups in `src/domainIntel.ts`, run from the background script: the sender's
  registrable domain (validated by `isValidDomain`) sent to IANA/registry RDAP (rdap.org fallback), cloudflare-dns.com
  and dns.google (URIBL fallback). Cached 24 h. Do not add endpoints or send anything else without updating `docs/privacy.md`.
- **Warn, never block on sender issues:** sender/domain problems produce banner warnings only. Only the content scorer's
  phishing verdict locks links.
- **Parity contract:** `ml/src/phishml/features.py` and `extension/src/features.ts` must produce identical features.
  Any feature change updates both plus `ml/tests/fixtures/parity.json`, which both test suites read.
- **Permissions:** only `storage` and the webmail hosts in `extension/src/hosts.ts` (single source for host permissions and content-script matches). Justify any addition in `docs/threat-model.md`.
- **Evaluation:** split by time, never randomly. Report precision at <=0.1% false-positive rate, not just accuracy.
- **Data:** raw data goes in `ml/data/raw/` (gitignored). Record source, license and collection date in `ml/data/SOURCES.md`.
- **UI safety:** build DOM with `textContent`; never `innerHTML` with email-derived data.
- No real phishing kits or live attack infrastructure. Use only public datasets and self-made test pages.
- **Allowlist:** trust is per exact address validated by `STRICT_EMAIL` in `allowlist.ts`. Never add domain or wildcard trust; never match on display names.
- Webmail selectors live only in `extension/src/adapters/`; never in feature or scoring code.

## Performance budget (hard requirements)
- Scoring one email: <10 ms. Content script idle CPU: ~0. Extension memory: <10 MB. Total package: <500 KB.
- **No ONNX Runtime, TensorFlow.js or other ML runtimes.** The model is exported as a small JSON (weights/trees, <200 KB) and evaluated in plain TypeScript.
- Only scan when an email changes: debounce DOM mutations, skip hidden tabs, cap body length and link count, no polling, no timers while idle.
- No persistent background work; the background script only stores the latest verdict.
- Any task that adds a dependency must report package size before and after.

## Layout
- `extension/src/features.ts` scorer; `model.ts` JSON-model scorer (stub); `hosts.ts` supported webmail URLs; `sender.ts` local sender checks (brand claim, lookalike, display-name address); `domainIntel.ts` online domain lookups; `brands.ts` impersonated brands; `adapters/` per-webmail DOM extraction (Gmail, Outlook, Yahoo, Proton, iCloud; stubs)
- `extension/src/allowlist.ts`, `feedback.ts` local trusted senders and false-positive reports (through the `KV` interface in `storage.ts`, so they test without a browser); `src/ui/` banner (closed shadow DOM) and link locking
- `ml/src/phishml/` `features.py`, `data.py`, `train.py`, `evaluate.py`, `export_model.py` (stubs except features)
