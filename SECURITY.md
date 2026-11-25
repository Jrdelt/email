# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| `main` / `0.1.x` | Yes |

## Reporting a vulnerability

**Please do not report security problems in public GitHub issues.**

Use [GitHub Private Vulnerability Reporting](https://github.com/Jrdelt/email/security/advisories/new) for this repository. This lets the issue be fixed and tested before it is made public.

Please include:

1. The browser and version (Chrome, Edge or Firefox) and the webmail (Gmail, Outlook on the web, iCloud Mail, Yahoo Mail or Proton Mail).
2. A minimal **synthetic** reproduction (HTML or URL). Never attach real personal emails, live phishing sites or anyone's credentials.
3. The impact, for example a link or attachment lock bypass, a click-time check bypass, allowlist spoofing, cross-frame message spoofing, or unexpected network traffic.

We aim to acknowledge reports within **72 hours** and to ship fixes with unit tests as quickly as possible.

## In scope

- Bypassing link, form, `formaction`, SVG link or attachment locking on untrusted or flagged emails (`extension/src/ui/linkLock.ts`, `extension/src/ui/attachmentLock.ts`).
- Bypassing the click-time link check or the `warning.html` page (`extension/src/linkGuard.ts`, `extension/entrypoints/warning/`).
- Spoofing messages between frames or tabs in `extension/entrypoints/background.ts` or `extension/entrypoints/content.ts`.
- Getting a sender auto-trusted even though the webmail shows it as unverified or sent through a suspicious relay (`extension/src/sender.ts`, `extension/src/allowlist.ts`).
- DOM XSS (cross-site scripting), Shadow DOM style or script injection, or weaknesses in the extension's Content Security Policy.
- Privacy leaks: any network request that carries email bodies, full URLs, paths, query strings, attachment names or contents, or sender addresses.

## Out of scope (known limits)

- A user copying a plain-text URL and pasting it into the address bar.
- Server-side redirects that happen after leaving the webmail tab, starting from an established, reputable domain (the extension has no permission to watch other tabs).
- Malicious content inside a normal-looking file (such as a `.pdf`) after the user chooses to trust the email or sender and downloads it.
- Desktop and mobile mail apps, and webmail sites the extension does not support.

See [docs/threat-model.md](docs/threat-model.md) and [docs/privacy.md](docs/privacy.md) for details.
