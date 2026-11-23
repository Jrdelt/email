# email

Privacy-first phishing **email** detection that runs entirely in your browser.
One codebase ships to **Chrome, Edge and Firefox** (Manifest V3, built with [WXT](https://wxt.dev)).

> Status: scaffold. The extension currently uses a heuristic scorer; the trained
> JSON-model model replaces it in milestone 4.

## How it works
```
Webmail page (Gmail, Outlook, Yahoo, Proton, iCloud)
  └─ content script: sender, link text vs. real href, body text
       ├─ scorer (heuristics now, tiny JSON model later) — runs locally
       └─ background: sender-domain lookups only (RDAP, DNS, URIBL), cached 24 h
            └─ banner + popup with human-readable reasons
ml/  (Python): data, features, training, evaluation, JSON-model export
```

## Layout
| Path | Purpose |
|---|---|
| `extension/` | WXT + TypeScript browser extension |
| `ml/` | Feature extraction, training and evaluation (Python, uv) |
| `docs/` | Threat model, privacy notes, evaluation results |

## Develop
```sh
# extension
cd extension && npm install
npm run dev            # Chrome;  dev:firefox / dev:edge also available
npm run build:all      # builds chrome, edge, firefox into .output/

# ml
cd ml && uv sync && uv run pytest
```

## Milestones
1. Scaffold + CI  ← you are here
2. Dataset collection (time-stamped, licensed sources) + baseline model
3. Time-split evaluation, precision at low false-positive rate
4. JSON-model export and in-extension inference (parity-tested against Python)
5. Explainable reasons in the UI
6. Adversarial testing, threat model, store submissions

## Privacy
No email content is sent anywhere. Only the sender's domain is looked up (registration, DNS, spam lists). See [docs/privacy.md](docs/privacy.md).

## Authorized use
Test only with emails and pages you own or have permission to analyze.

## License
MIT
