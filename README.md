# Phishing Email Detector

[![CI](https://github.com/Jrdelt/email/actions/workflows/ci.yml/badge.svg)](https://github.com/Jrdelt/email/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-26d08c.svg)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-ffd166.svg)](extension/wxt.config.ts)

Privacy-first phishing email protection that runs locally in your browser. One TypeScript codebase ([WXT](https://wxt.dev), Manifest V3, `~193 kB` unpacked / `~73 kB` zipped, zero runtime npm dependencies) ships to **Chrome, Edge, and Firefox**, paired with a reproducible Python ML feature/training pipeline (`ml/`).

> **Project status:** Active development. Heuristic content scoring, sender/authentication checks, live domain intelligence, zero-permission link & attachment locking, and click-time destination protection are shipped (**T0–T1**). Calibrated time-split ML model training and in-extension JSON inference are tracked in [docs/ROADMAP.md](docs/ROADMAP.md) (**T2–T10**).

## Key Protections

- **Local content & sender analysis:** Detects brand impersonation (including compact/camelCase forms like `PayPalSupport`), lookalike/punycode domains, link-text vs. destination mismatches, raw cloud-storage HTML lures, urgency pretexts, unauthenticated senders, and suspicious `via` relays—all inside the browser.
- **Privacy-preserving domain intelligence:** Queries only validated registrable domains (never email bodies, sender addresses, or URL paths/queries) via RDAP, Cloudflare/Google DNS (`MX`, `SPF`, `DMARC`, `NXDOMAIN`), and URIBL, cached locally for 24 hours.
- **Hardened link & form locking:** Any content, sender, or domain warning pauses `<a>`, `<area>`, `<a ping>`, SVG `href`/`xlink:href`, `<form action>`, and `[formaction]` elements inside untrusted messages (with DOM-clobbering-safe attribute stashing and instant MutationObserver re-locking) without blocking reading the email.
- **Always-on attachment lock for untrusted mail:** Blocks webmail attachment shelves/cards and inline `download`/`data:`/`blob:` links on every untrusted email until explicitly trusted, flagging HTML/SVG smuggling, executables, scripts, macros, and double extensions locally by filename.
- **Click-time destination guard & recovery:** Flushes pending scans if a user clicks within the initial 400 ms debounce window, unwraps multi-hop tracking redirects (Safe Links, Google, Facebook, YouTube), checks destination domain age/reputation, and routes risky clicks to a local `warning.html` interstitial and calm recovery checklist.
- **Usable, spoof-resistant trust controls:** Shows a `From` vs. `Links go to` comparison cue on the main card, requires 2-step confirmation to unlock `danger` alerts, disables `"Always trust sender"` when sender authentication fails, and remembers `"I trust this email"` as a one-way SHA-256 digest with one-click **Undo**.

## Supported Webmail Providers

| Provider | Host(s) | Status | Notes |
|---|---|---|---|
| **Gmail** | `mail.google.com` | Supported | Full thread scanning, `via`/unauthenticated header checks, attachment shelf & inline lock |
| **Outlook Web** | `outlook.live.com`, `outlook.office.com`, `outlook.office365.com`, `outlook.cloud.microsoft` | Supported | Reading Pane subject + thread scanning, Safe Links unwrapping, attachment Aria-card lock |
| **iCloud Mail** | `www.icloud.com/mail/*` (+ scoped `mail2` & `icloud-sandbox` frames) | Supported | Stateless `sender.url`-verified cross-frame header/body coordination & lock |
| **Yahoo Mail** | `mail.yahoo.com` | Planned (`T7c`) | Adapter stub + generic fallback extractor |
| **Proton Mail** | `mail.proton.me` | Planned (`T7d`) | Adapter stub |

## Architecture

```text
Webmail tab (Gmail, Outlook Web, iCloud Mail cross-frame)
  └─ Content script (extension/entrypoints/content.ts)
       ├─ Per-provider DOM adapter (extension/src/adapters/*)
       ├─ Local scorer + sender/attachment checks (features.ts, sender.ts, attachments.ts)
       ├─ 400 ms pending-scan click gate + DOM-clobbering-safe link/attachment locks
       ├─ Click-time destination inspector (linkGuard.ts) -> session token -> warning.html
       └─ Closed Shadow DOM banner & paused-action toast (extension/src/ui/*)
            │
            ▼
  Background service worker / script (extension/entrypoints/background.ts)
       ├─ Domain-only RDAP + DNS + URIBL lookups (24 h local cache, credentials: omit)
       ├─ Ephemeral 1 h warning.html session store (browser.storage.session)
       └─ Stateless sender.url-verified iCloud Mail frame relay

Offline ML pipeline (ml/src/phishml/*, Python 3.11+ / uv)
  └─ Exact feature parity with TypeScript verified via ml/tests/fixtures/parity.json
```

## Quick Start

### Build & Run Tests

Requires **Node.js 22+** and **Python 3.11+** with [`uv`](https://docs.astral.sh/uv/).

```sh
# Browser extension
cd extension
npm ci
npm run typecheck
npm test
npm run build:all      # Builds Chrome, Edge, and Firefox MV3 bundles (+ syncs ../chrome-mv3/)

# Python ML pipeline & cross-language parity suite
cd ../ml
uv sync --locked
uv run pytest
```

### Load Unpacked in Your Browser

- **Chrome / Brave / Chromium:** Run `npm run build` in `extension/`, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the repo-root `chrome-mv3/` directory.
- **Microsoft Edge:** Run `npm run build:edge` in `extension/`, open `edge://extensions`, enable **Developer mode**, click **Load unpacked**, and select `extension/.output/edge-mv3/`.
- **Firefox (142+):** Run `npm run build:firefox` in `extension/`, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…**, and select `extension/.output/firefox-mv3/manifest.json`.

## Repository Layout

| Path | Description |
|---|---|
| [`extension/`](extension/) | WXT + TypeScript Manifest V3 extension (`src/`, `entrypoints/`) |
| `chrome-mv3/` | Gitignored unpacked Chrome MV3 build synced automatically on `npm run build` |
| [`ml/`](ml/) | Python feature extraction, parity fixtures, and upcoming model training (`uv`) |
| [`docs/`](docs/) | [ROADMAP.md](docs/ROADMAP.md), [privacy.md](docs/privacy.md), [threat-model.md](docs/threat-model.md), [research-defense-in-depth.md](docs/research-defense-in-depth.md) |
| Community | [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [LICENSE](LICENSE) |

## Privacy Summary

Email bodies, attachment files/filenames, full URLs, paths, query strings, `#fragments`, and sender email addresses **never leave your browser**. Only validated registrable domains (for an opened email's sender and clicked external link destinations) are checked against public RDAP and DNS services with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`, cached locally for 24 hours. Trusted emails are stored solely as one-way SHA-256 digests. Full details in [docs/privacy.md](docs/privacy.md) and [docs/threat-model.md](docs/threat-model.md).

## Authorized Use & Security

Test only with emails and pages you own or have permission to analyze. To report a security or privacy vulnerability, please follow [SECURITY.md](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
