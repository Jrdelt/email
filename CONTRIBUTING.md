# Contributing

Thanks for helping make webmail safer without giving up privacy.

## Prerequisites

- Node.js 22+ and npm
- Python 3.11+ and [uv](https://docs.astral.sh/uv/)

## Required checks

Every pull request must pass the extension checks and the Python checks:

```sh
# 1. Browser extension
cd extension
npm ci
npm run typecheck
npm test
npm run build:all

# 2. Python ML pipeline and parity tests
cd ../ml
uv sync --locked
uv run pytest
```

To try your build in a browser, follow [Load Unpacked in Your Browser](README.md#load-unpacked-in-your-browser). For how the code fits together, see [docs/architecture.md](docs/architecture.md).

## Project rules

The full rules are in [AGENTS.md](AGENTS.md). The most important ones:

1. **Privacy.** Email bodies, attachment contents and names, full URLs (including paths and query strings) and sender addresses never leave the browser. No analytics or telemetry. The only network code is `extension/src/domainIntel.ts`, which sends validated registrable domains only (`isValidDomain`) and caches results for 24 hours. Any change to network behavior or local storage must also update [docs/privacy.md](docs/privacy.md) and [docs/hipaa-and-compliance.md](docs/hipaa-and-compliance.md).
2. **Feature parity.** `extension/src/features.ts` and `ml/src/phishml/features.py` must produce identical features for every case in `ml/tests/fixtures/parity.json`. If you change a feature, update both files and `parity.json`.
3. **Safe UI code.** Build UI with `createElement` / `createElementNS` and `textContent`. Never put email data into `innerHTML`.
4. **Adapters stay separate.** Webmail-specific selectors belong only in `extension/src/adapters/`, never in scoring, sender or UI code.
5. **Small and minimal.** Install permissions stay limited to `storage` and the sites in `extension/src/hosts.ts`. Keep zero runtime npm dependencies, scoring under 10 ms per email, and each unpacked build under 500 KB.
6. **Safe test data only.** Never commit real personal emails, live phishing kits or active attack URLs. Use small synthetic fixtures with `.example` domains (reserved for testing by RFC 2606).
