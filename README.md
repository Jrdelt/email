# email

Privacy-first phishing **email** detection that runs entirely in your browser.
One codebase ships to **Chrome, Edge and Firefox** (Manifest V3, built with [WXT](https://wxt.dev), `~156 kB` packaged, zero runtime dependencies).

> **Status:** active development. The extension ships heuristic content scoring, sender/header checks, live domain intel, hardened link/form pausing, and click-time destination protection; a calibrated JSON ML model (`ml/`) will replace the heuristic scorer in upcoming milestones (`T1–T6`).

## How it works
```
Webmail page (Gmail, Outlook Web, iCloud Mail cross-frame; Yahoo/Proton stubs)
  └─ content script: multi-message thread extraction (sender, via/auth cues,
       subject + body, a/area/form/formaction/SVG xlink:href)
       ├─ local scorer (heuristics now, <200 KB JSON model later) + sender checks
       ├─ 400 ms scan race gate + hardened link/form locking + paused-link toast
       ├─ click-time destination inspector -> ephemeral session hand-off -> warning.html
       └─ background script: domain-only lookups (RDAP, Cloudflare/Google DNS:
            MX/SPF/DMARC, NXDOMAIN, URIBL; 24 h cache) for sender domains &
            clicked external destinations + stateless iCloud cross-frame relay
            └─ Shadow DOM banner (comparison cue, 2-step danger unlock,
                 persistent SHA-256 trust + Undo, auth-guarded allowlist) & popup
ml/  (Python, uv): data, parity features, training, time-split evaluation, JSON-model export
```

## Key capabilities
- **Content, sender & domain analysis:** local scoring (brand spoofing including compact/camelCase variants, raw cloud-storage HTML lures, urgency phrases, link text vs. destination mismatch, punycode/lookalikes) paired with cached RDAP + DNS (`MX`/`SPF`/`DMARC`/`NXDOMAIN`/URIBL) checks and Gmail `via` relay mismatch / unauthenticated-sender detection.
- **Hardened link pausing & click-time guard:** any warning pauses `<a>`, `<area>`, `<a ping>`, SVG `xlink:href`, `<form action>`, and `[formaction]` elements inside flagged messages with instant mutation re-locking and a non-blocking paused-link toast. Clicking an external link runs a race-to-click scan flush, local URL risk checks, and cached destination-domain intel, routing risky clicks to a local `warning.html` interstitial and recovery guide.
- **Usable, privacy-preserving controls:** displays a `From: ... • Links go to: ...` comparison cue on the main banner card, requires a 2-step confirmation to unlock `danger` emails, remembers **"I trust this email"** locally as a one-way SHA-256 fingerprint (reversible via an inline **Undo** pill or the popup), refuses auto-trust when a `trustedSenders` address fails authentication/`via` checks, and provides a **"Clicked a suspicious link?"** recovery guide in the popup.

## Layout
| Path | Purpose |
|---|---|
| `extension/` | WXT + TypeScript MV3 browser extension |
| `chrome-mv3/` | Gitignored unpacked Chrome MV3 build (auto-synced on `npm run build` / `build:chrome`) |
| `ml/` | Feature extraction, training and evaluation (Python, `uv`) |
| `docs/` | [ROADMAP.md](docs/ROADMAP.md), [privacy.md](docs/privacy.md), [threat-model.md](docs/threat-model.md), [research-defense-in-depth.md](docs/research-defense-in-depth.md) |

## Develop
```sh
# extension
cd extension && npm install
npm run typecheck
npm test
npm run dev            # Chrome; dev:firefox / dev:edge also available
npm run build          # builds Chrome MV3 and syncs repo-root chrome-mv3/
npm run build:all      # builds chrome, edge, firefox into .output/ (and chrome-mv3/)

# ml
cd ml && uv sync && uv run pytest
```
To test in Chrome manually, run `npm run build` in `extension/` and load the auto-synced repo-root `chrome-mv3/` directory via **Load unpacked** in `chrome://extensions`.

## Milestones
Foundation, live Gmail/Outlook/iCloud detection, Shadow DOM UI, hardened link locking, and click-time destination protection (**T0–T0d**) are complete. Remaining milestones cover parity fixtures, time-split ML training/export, in-extension inference, remaining webmail adapters, evasion benchmarks, and store release (**T1–T10**). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Privacy
Email bodies, URLs, paths, query strings, and sender addresses never leave the browser. Only registrable domains—for opened emails' senders and clicked external link destinations—are queried against public RDAP and DNS services (cached 24 h locally). Trusted emails are stored as one-way SHA-256 digests only. See [docs/privacy.md](docs/privacy.md) and [docs/threat-model.md](docs/threat-model.md).

## Authorized use
Test only with emails and pages you own or have permission to analyze.

## License
MIT
