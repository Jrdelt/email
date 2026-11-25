# AGENTS.md

Browser extension (Chrome/Edge/Firefox, MV3, WXT) + Python ML pipeline for local phishing-email detection.
Read `docs/ROADMAP.md` for the task list. Pick the first unchecked task; do one task per change.

## Commands
- Extension (run in `extension/`): `npm install`, `npm run typecheck`, `npm test`, `npm run build:all`
- ML (run in `ml/`): `uv sync`, `uv run pytest`
- A task is done only when all four checks above pass and its acceptance criteria are met.

## Rules
- **Privacy:** no email content, URLs, paths/queries/fragments, or sender addresses leave the browser. No telemetry.
  When Strict Local Mode (`src/settings.ts` + `public/managed_schema.json`) is enabled, **zero** network traffic leaves the
  browser. Otherwise, the ONLY network traffic is domain lookups in `src/domainIntel.ts`, run from the background script:
  the sender's or clicked external destination's registrable domain (validated by `isValidDomain`) sent to IANA/registry
  RDAP (`rdap.org` fallback), `cloudflare-dns.com` and `dns.google` (URIBL fallback), cached 24 h. Do not add endpoints
  or send anything else without updating `docs/privacy.md` and `docs/hipaa-and-compliance.md`.
- **Lock links and attachments:** any warning (content phishing flag, sender warning, or domain/spam warning) pauses all links (`a`, `area`, SVG `xlink:href`), `<a ping>`, embedded image links, image maps, forms, and `[formaction]` controls (including `keydown` `Enter`/`Space` and dynamically mutated DOM additions) until the user unlocks the email or trusts the sender. Any attachment (native webmail attachment shelf/cards or inline `download`/`data:`/`blob:` anchors) from an **untrusted** email is always blocked (`src/ui/attachmentLock.ts` + `src/attachments.ts`) even when the body scores safe or the banner is dismissed; never block reading the email itself.
- **Parity contract:** `ml/src/phishml/features.py` and `extension/src/features.ts` must produce identical features.
  Any feature change updates both plus `ml/tests/fixtures/parity.json`, which both test suites read.
- **Permissions:** only `storage` and the webmail hosts in `extension/src/hosts.ts` (single source for host permissions and content-script matches). Justify any addition in `docs/threat-model.md`.
- **Evaluation:** split by time, never randomly. Report precision at <=0.1% false-positive rate, not just accuracy.
- **Data:** raw data goes in `ml/data/raw/` (gitignored). Record source, license and collection date in `ml/data/SOURCES.md`.
- **UI safety:** build DOM with `textContent`; never `innerHTML` with email-derived data.
- No real phishing kits or live attack infrastructure. Use only public datasets and self-made test pages.
- **Allowlist:** sender trust is per exact address validated by `STRICT_EMAIL` in `allowlist.ts`. Never add domain or wildcard trust; never match on display names; always refuse auto-trust (`canTrustByAllowlist` in `sender.ts`) when webmail flags an unauthenticated sender or a conflicting non-ESP `via` relay. Per-email trust stores one-way SHA-256 fingerprints only (`trustedEmails` in `allowlist.ts`, up to 500).
- Webmail selectors live only in `extension/src/adapters/`; never in feature or scoring code.

## Performance budget (hard requirements)
- Scoring one email: <10 ms. Content script idle CPU: ~0. Extension memory: <10 MB. Total package: <500 KB.
- **No ONNX Runtime, TensorFlow.js or other ML runtimes.** The model is exported as a small JSON (weights/trees, <200 KB) and evaluated in plain TypeScript.
- Only scan when an email changes: debounce DOM mutations, skip hidden tabs, cap body length and link count, no polling, no timers while idle.
- No persistent background work; the background script only stores the latest per-tab verdict, ephemeral `warn:*` session entries for `warning.html` (with 1 h stale pruning), and relays `sender.url`-verified iCloud cross-frame messages statelessly.
- Any task that adds a dependency must report package size before and after.

## Layout
- `extension/src/features.ts` scorer & `extractFeatures`; `model.ts` JSON-model scorer (stub); `hosts.ts` supported webmail URLs & sender URL verification; `settings.ts` & `public/managed_schema.json` Strict Local Mode / HIPAA enterprise policy settings; `dom.ts` DOM-clobbering-safe `Element.prototype` attribute helpers; `domain.ts` registrable-domain & IPv4/IPv6 parsing; `sender.ts` local sender checks (brand claim, compact/camelCase spoofs, lookalike, display-name address, `via`/auth allowlist guard); `domainIntel.ts` online domain lookups (`RDAP`, `MX`/`SPF`/`DMARC`/`NXDOMAIN`/`URIBL`); `brands.ts` impersonated brands & known ESP domains; `linkGuard.ts` click-time destination inspection & multi-hop redirect unwrapping; `attachments.ts` local filename/double-extension risk classification; `text.ts` display helpers for attacker text (bidi neutralising, middle ellipsis); `adapters/` per-webmail DOM extraction (`extract.ts`, `gmail.ts`, `outlook.ts`, `icloud.ts`, `yahoo.ts`, `proton.ts`)
- `extension/src/allowlist.ts`, `feedback.ts` local trusted senders, SHA-256 `trustedEmails`, and false-positive reports (through the `KV` interface in `storage.ts`, so they test without a browser); `src/ui/` neo-brutalist banner (closed shadow DOM on `document.documentElement`), domain details panel, `icons.ts`, hardened `linkLock.ts`, `attachmentLock.ts` (isolated-world stash records; `ariaDisabled.ts` restores the page's own `aria-disabled`), and `linkToast.ts`
- `extension/entrypoints/` `content.ts` (multi-message scanner, 400 ms race-to-click gate, click-time guard, iCloud dual-frame orchestration), `background.ts` (intel cache, `warn:*` session store, `openWarning`/`openSafeLink`, stateless iCloud frame relay), `popup/` (verdict status, recovery link, trust & report management), `warning/` (`warning.html` interstitial & recovery checklist)
- `ml/src/phishml/` `features.py`, `data.py`, `train.py`, `evaluate.py`, `export_model.py` (stubs except features)
