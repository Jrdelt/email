# Architecture

This page explains how Phishing Email Detector is built. For what it does and how to install it, see the [README](../README.md).

## Overview

```text
Webmail tab (Gmail, Outlook on the web, iCloud Mail, Yahoo Mail, Proton Mail)
  └─ Content script (extension/entrypoints/content.ts)
       ├─ Per-provider page reader, called an adapter (extension/src/adapters/*)
       ├─ Local checks: content, sender, attachments (features.ts, sender.ts, attachments.ts)
       ├─ 400 ms pending-scan click gate + link/attachment locks (src/ui/linkLock.ts, attachmentLock.ts)
       ├─ Click-time link check (linkGuard.ts) -> one-time session token -> warning.html
       └─ Banner and "link paused" toast in a closed Shadow DOM (extension/src/ui/*)
            │
            ▼
  Background script (extension/entrypoints/background.ts)
       ├─ Domain-only RDAP + DNS + URIBL lookups (off when Strict Local Mode is on)
       ├─ Reads enterprise policy (managed_schema.json via storage.managed)
       ├─ Short-lived warning.html entries in browser.storage.session (pruned after 1 h)
       └─ Stateless relay between iCloud Mail frames, checked with sender.url

Offline ML pipeline (ml/src/phishml/*, Python 3.11+ with uv)
  └─ Feature parity with the TypeScript code, checked by ml/tests/fixtures/parity.json
```

## How an email is checked

1. **Wait for the email to settle.** The content script runs only on the supported webmail pages listed in `extension/src/hosts.ts`. When the open email changes, it waits 400 ms (a debounce) and then scans. It does not poll.
2. **Read the page.** The adapter for that webmail reads each message in the thread: sender, body text, links and attachment names. Webmail-specific selectors live only in `extension/src/adapters/`.
3. **Run local checks.** `features.ts` scores the text and links, `sender.ts` checks the sender, and `attachments.ts` checks attachment file names. Nothing is sent anywhere for these checks.
4. **Look up the sender's domain (optional).** For untrusted emails, and only when Strict Local Mode is off, the background script looks up the sender's registrable domain with `domainIntel.ts` and caches the result for 24 hours.
5. **Warn and lock.** If any check raises a warning, a banner explains why and links and forms in that email are locked. Attachments in untrusted emails are always locked. Reading the email is never blocked.
6. **Check clicks.** When you click an outside link, `linkGuard.ts` unwraps known redirects and checks the real destination. Risky clicks open the local `warning.html` page instead. If you click before the first scan has finished, the scan runs first.

The current scorer uses fixed rules. A trained model that runs from a small JSON file is planned (see [ROADMAP.md](ROADMAP.md), tasks T2 to T6). `extension/src/model.ts` is a placeholder until then.

## Code map

| Path | Purpose |
|---|---|
| `extension/entrypoints/content.ts` | Finds and scans emails, applies locks, runs the click guard, coordinates iCloud Mail frames |
| `extension/entrypoints/background.ts` | Domain lookups and cache, warning-page entries, opening safe links, iCloud frame relay |
| `extension/entrypoints/popup/` | Toolbar popup: current verdict, Strict Local Mode switch, trusted senders, local data controls |
| `extension/entrypoints/warning/` | `warning.html`: the "link paused" page and recovery checklist |
| `extension/src/adapters/` | One reader per webmail: `gmail.ts`, `outlook.ts`, `icloud.ts`, `yahoo.ts`, `proton.ts`, plus shared `extract.ts` |
| `extension/src/features.ts` | Content features and rule-based scoring (mirrored in `ml/src/phishml/features.py`) |
| `extension/src/sender.ts` | Sender checks: brand claims, lookalike domains, display-name tricks, unverified senders and relays |
| `extension/src/domainIntel.ts` | The only network code: RDAP, DNS and URIBL lookups for a bare domain |
| `extension/src/linkGuard.ts` | Click-time destination checks and redirect unwrapping |
| `extension/src/attachments.ts` | File-name risk checks (no file contents are read) |
| `extension/src/allowlist.ts` | Trusted senders (exact addresses) and trusted-email fingerprints (SHA-256) |
| `extension/src/settings.ts` | Strict Local Mode and enterprise policy settings |
| `extension/src/hosts.ts` | The single list of supported webmail sites, used for permissions and content-script matches |
| `extension/src/ui/` | Banner, details panel, icons, link lock, attachment lock and toast |
| `extension/public/managed_schema.json` | Policy schema IT admins use to enforce Strict Local Mode |
| `ml/src/phishml/` | Python features (done) and data, training, evaluation and export steps (placeholders) |

## Repository layout

| Path | Contents |
|---|---|
| `extension/` | The WXT + TypeScript browser extension |
| `chrome-mv3/` | Unpacked Chrome build copied here by `npm run build` (not committed) |
| `ml/` | Python feature extraction, parity fixtures and future model training |
| `docs/` | Project documentation |
