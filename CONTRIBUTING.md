# Contributing to Phishing Email Detector

Thanks for helping make webmail safer without sacrificing user privacy.

## Prerequisites
- **Node.js 22.12+ or 24+** (not 23 or 25; `extension/package.json` `engines`: `^22.12.0 || ^24.0.0 || >=26.0.0`) and `npm`
- [`uv`](https://docs.astral.sh/uv/), which installs the Python version pinned in `ml/.python-version` (3.13). The ML features depend on the interpreter's Unicode tables, so a test fails on any other Python version.

## Setup & Required Checks

Every pull request must pass both the TypeScript extension checks and the Python ML checks:

```sh
# 1. Browser extension (Chrome, Edge, Firefox MV3)
cd extension
npm ci
npm run typecheck
npm test
npm run build:all

# 2. Python ML pipeline & parity tests
cd ../ml
uv sync --locked
uv run pytest
```

## Loading the Extension Locally

After running `npm run build:all` inside `extension/`:
- **Chrome:** Open `chrome://extensions` → enable **Developer mode** → click **Load unpacked** → select the repo-root `chrome-mv3/` folder (auto-synced on `npm run build` / `npm run build:chrome`).
- **Edge:** Open `edge://extensions` → enable **Developer mode** → click **Load unpacked** → select `extension/.output/edge-mv3/`.
- **Firefox (142+, desktop):** Open `about:debugging#/runtime/this-firefox` → click **Load Temporary Add-on…** → select `extension/.output/firefox-mv3/manifest.json`.

## Core Architectural Rules

1. **Strict Privacy:** Email bodies, attachment contents/names, full URLs, paths, query strings, and sender email addresses **never** leave the browser. No analytics or telemetry. The only network lookups live in `extension/src/domainIntel.ts` and send validated registrable domains only (`isLookupDomain`) to IANA/registry RDAP (`rdap.org` fallback) and `cloudflare-dns.com`, cached locally for 24 hours. Any change to network behavior or local storage requires updating [docs/privacy.md](docs/privacy.md).
2. **Feature Parity Contract:** `extension/src/features.ts` and `ml/src/phishml/features.py` must produce identical feature vectors on every input in `ml/tests/fixtures/parity.json`. Whenever you add or modify a feature, update **both** implementations and `parity.json`; each case's `expected` keys must be in `FEATURE_NAMES` order (`ml/tests/fixtures/feature_names.json`), and both suites check it. A change to how the extension reads an email (`withSubject`, `bodyText`, `scanLinks`, redirect unwrapping) also updates `ml/tests/fixtures/scoring_input.json`.
3. **DOM & UI Safety:** Build UI exclusively with `document.createElement` / `createElementNS` and `textContent` inside closed Shadow DOM roots—**never** pass untrusted email data into `innerHTML`.
4. **Adapter Locality:** Webmail-specific CSS selectors belong strictly inside `extension/src/adapters/` (`gmail.ts`, `outlook.ts`, `icloud.ts`, `yahoo.ts`, `proton.ts`)—never inside scoring, sender, or UI modules.
5. **Minimal Permissions & Bundle Budget:** Keep install-time permissions limited to `storage` and `WEBMAIL_MATCHES` (`extension/src/hosts.ts`). Keep runtime npm `dependencies` at **zero**, scoring under `<10 ms` per email, and total unpacked package size under `<500 KB`.
6. **Secrets stay local:** store-publishing credentials from `wxt submit init` go to `extension/.env.submit`, which is gitignored (as is every `.env.*` except `.env.example`). Never commit them.
7. **Safe Test Fixtures Only:** Never commit real personal emails, live phishing kits, or active attack URLs. Write unit tests with minimal, synthetic HTML fixtures (using `.example` domains per RFC 2606).
