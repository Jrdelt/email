# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| `main` / `0.1.x` | Yes |

## Reporting a Vulnerability

**Please do not report security vulnerabilities in public GitHub issues.**

Use [GitHub Private Vulnerability Reporting](https://github.com/Jrdelt/email/security/advisories/new) on this repository so findings can be triaged, patched, and regression-tested before public disclosure.

Include:
1. Affected browser(s) and version(s) (Chrome, Edge, Firefox) and webmail provider (Gmail, Outlook Web, iCloud Mail).
2. A minimal, **synthetic** HTML/URL reproduction (never attach real personal emails, live phishing infrastructure, or third-party credentials).
3. Impact assessment (e.g., link/attachment lock bypass, click-time guard bypass, allowlist spoofing, cross-frame message spoofing, or unintended network egress).

We aim to acknowledge reports within **72 hours** and ship fixes with unit tests as quickly as possible.

## Scope

### In Scope
- Bypassing link, `<form>`, `[formaction]`, SVG link, or attachment locking on untrusted/flagged emails (`extension/src/ui/linkLock.ts`, `extension/src/ui/attachmentLock.ts`).
- Bypassing the click-time destination inspector or `warning.html` interstitial (`extension/src/linkGuard.ts`, `extension/entrypoints/warning/`).
- Cross-frame or cross-tab message spoofing in `extension/entrypoints/background.ts` or `extension/entrypoints/content.ts`.
- Allowlist spoofing bypasses when webmail surfaces unauthenticated sender or suspicious relay cues (`extension/src/sender.ts`, `extension/src/allowlist.ts`).
- DOM XSS, Shadow DOM style/script injection, or MV3 Content Security Policy weaknesses.
- Privacy leaks (any network request transmitting email bodies, full URLs, paths, query strings, attachment names/contents, or sender email addresses).

### Out of Scope (Known Architectural Boundaries)
- Users manually copying and pasting plain-text URLs into the address bar.
- Multi-hop server-side redirects hosted on an initially reputable, established domain *after* leaving the webmail tab (without opt-in navigation permissions).
- Malicious payloads hidden inside benign-looking files (e.g., `.pdf`) *after* a user explicitly trusts the email or sender and downloads the file.
- Native desktop/mobile mail clients outside supported webmail origins.

See [docs/threat-model.md](docs/threat-model.md) and [docs/privacy.md](docs/privacy.md) for full details.
