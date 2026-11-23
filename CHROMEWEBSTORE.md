# Chrome Web Store & Microsoft Edge Add-ons Listing — Phishing Email Detector

> Last Updated: 2026-11-23

Use this file to copy-paste every required field in the **Chrome Web Store Developer Dashboard** and **Microsoft Partner Center (Edge Add-ons)**.

---

## Store Packages Ready to Upload

All ready-to-upload files are gathered in `/Users/cesardeltoro-lemire/email-detection/store-upload/` (regenerate anytime with `cd extension && npm run build:all && npm run zip:all`):
- **Chrome Web Store ZIP:** `store-upload/phishing-email-detection-extension-0.1.0-chrome.zip` (also at `extension/.output/phishing-email-detection-extension-0.1.0-chrome.zip`)
- **Microsoft Edge Add-ons ZIP:** `store-upload/phishing-email-detection-extension-0.1.0-edge.zip` (also at `extension/.output/phishing-email-detection-extension-0.1.0-edge.zip`)

---

## Store Listing

**Extension Name** [REQUIRED]
Phishing Email Detector

**Short Description** [REQUIRED — 119 / 132 characters]
Warns about phishing in webmail. Email content stays in your browser; only sender and clicked link domains are checked.

**Detailed Description** [REQUIRED — plain text, copy-paste directly]
```text
Warns you about phishing emails, deceptive links, and unsafe attachments in webmail (compatible with Gmail, Outlook on the web, and iCloud Mail) while keeping your email content private on your device.

FEATURES
• Spots impersonation and scam tactics — flags fake sender names, lookalike domains, urgent account threats, unverified senders, and links that display one website in the text while pointing somewhere else.
• Checks domain reputation without exposing your mail — verifies how recently a sender's or clicked link's website domain was registered, whether its email records are set up properly, and whether it appears on public spam lists.
• Pauses risky links and untrusted attachments — automatically disables links in flagged emails and blocks attachments from untrusted senders until you choose to trust the email, preventing accidental one-click downloads or fake login pages.
• Protects you even if you click — inspects external links the moment you click them, unwraps tracking redirects, and stops dangerous or newly registered destinations on a clear warning screen with step-by-step recovery guidance.
• Clear, reversible trust controls — shows who really sent the message alongside where its links lead, asks for confirmation before unlocking high-risk alerts, and lets you undo trusting an email with one click.

HOW TO USE
1. Install Phishing Email Detector and open your webmail (compatible with Gmail, Outlook on the web, and iCloud Mail).
2. Open any email as usual — clean emails stay out of your way, while suspicious emails or untrusted attachments display a clear warning banner at the top of the page.
3. Click "See why" on a warning banner (or click the toolbar icon) to view plain-English details about the sender and website domain, or manage your trusted senders and recovery guide.

PRIVACY
Your email text, attachments, sender email addresses, and full link URLs never leave your browser. No account is required, and there is no analytics or tracking. To check domain age and spam listings, only the bare website domain name (for example, example.com — never your email address or the full link) is looked up via public domain registration (RDAP) and DNS services and cached locally on your device for 24 hours. All preferences stay on your device.

PERMISSIONS
• "Read and change your data on mail.google.com, outlook.live.com, outlook.office.com, outlook.office365.com, outlook.cloud.microsoft, www.icloud.com, and icloud-sandbox.com" — used only on supported webmail pages to check opened emails for phishing signs, display warning banners, and pause risky links and untrusted attachments.
• "Storage" — saves your trusted senders list, trusted email hashes, local false-alarm notes, and 24-hour domain lookup cache on your device.

SUPPORT
Found a bug or false alarm, or have a suggestion? Open an issue at https://github.com/Jrdelt/email/issues

Version 0.1.0 — Initial release with local phishing detection for webmail, untrusted attachment blocking, and click-time link protection.
```

**Category** [REQUIRED]
- **Chrome Web Store:** `Productivity` → `Workflow & Planning` (or `Tools`)
- **Microsoft Edge Add-ons:** `Security & Privacy`

**Single Purpose** [REQUIRED]
Detects phishing signs in emails opened in supported webmail services and warns users before they open risky links or untrusted attachments.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Store | Status | Filename |
|-------|-----------|-------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | Chrome & Edge | ✅ Ready | `store-upload/icon-128.png` (`extension/public/icons/icon-128.png`) |
| Edge Store Logo [REQUIRED for Edge] | 300×300 PNG | Edge Add-ons | ✅ Ready | `store-upload/edge-logo-300x300.png` |
| Screenshot 1 [REQUIRED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `store-upload/screenshot-1-phishing-banner-1280x800.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `store-upload/screenshot-2-link-stopped-1280x800.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `store-upload/screenshot-3-attachment-lock-popup-1280x800.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 (24-bit PNG) | Chrome & Edge | ✅ Ready | `store-upload/small-promo-440x280.png` |

---

## Permissions Justification

Copy-paste these plain-English explanations into the **Chrome Web Store Privacy Practices** tab and **Microsoft Partner Center Notes for Certification**:

| Permission / Host Pattern | Type | Justification |
|---------------------------|------|---------------|
| `storage` | `permissions` | Stores the user's local trusted-sender allowlist, one-way SHA-256 digests of trusted emails, redacted local false-positive notes, temporary 1-hour link-warning session tokens (`storage.session`), and a 24-hour local cache of domain lookup results (`storage.local`) on the user's device. |
| `https://mail.google.com/*` | `host_permissions` | Reads the currently opened email's sender header, text, links, and attachment shelf in Gmail locally in the browser to detect phishing indicators, display an in-page warning banner, and pause risky links and untrusted attachments until unlocked by the user. |
| `https://outlook.live.com/*`, `https://outlook.office.com/*`, `https://outlook.office365.com/*`, `https://outlook.cloud.microsoft/*` | `host_permissions` | Reads the currently opened email in consumer Outlook.com and Microsoft 365 Outlook on the web locally in the browser to detect phishing indicators, display an in-page warning banner, and pause risky links and untrusted attachments. |
| `https://www.icloud.com/mail/*`, `https://www.icloud.com/applications/mail2/*`, `https://*.icloud-sandbox.com/applications/mail2-message/*` | `host_permissions` | iCloud Mail renders message headers in `www.icloud.com/applications/mail2/*` and message bodies inside a cross-origin `*.icloud-sandbox.com/applications/mail2-message/*` iframe under `www.icloud.com/mail/*`. Scoped access to only these mail paths (not other iCloud apps) lets the extension analyze opened emails and pause risky links and attachments in iCloud Mail. |

---

## Privacy & Data Use Disclosure

Use these exact answers so the Chrome Web Store **Privacy Practices** form, Microsoft Partner Center disclosure, and `docs/privacy.md` match 100%:

### Data Collection & Off-Device Transmission
- **Does the extension transmit any data off-device?**
  - **Email content, sender email addresses, attachment files/names, and full URLs:** **No** — processed strictly in memory on the user's device and never transmitted anywhere.
  - **Registrable website domains (`Web history` / `Website content` minimal disclosure):** When an untrusted email is opened or an external link inside an email is clicked, **only the bare registrable domain name** (e.g., `example.com`, never URL paths/queries or email addresses) is queried over HTTPS against public IANA/registry RDAP (`data.iana.org`, registry RDAP / `rdap.org`) and public DNS-over-HTTPS (`cloudflare-dns.com`, `dns.google` fallback) to check domain age, mail setup, and URIBL spam status. No developer backend, analytics, or user tracking exists.

| Data Type | Collected / Stored Externally by Developer? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|---------------------------------------------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | No | No | N/A | No |
| Personal communications | No (analyzed locally in browser memory only) | No | Local phishing & attachment inspection | No |
| Location | No | No | N/A | No |
| Web history | No | No | N/A | No |
| User activity | No | No | N/A | No |
| Website content | Domain name only (sender / clicked external link registrable domain) | Yes — bare domain name only to public RDAP & DNS resolvers (24 h cached) | Check domain registration age, DNS email records, and URIBL spam listings | Public RDAP & DNS resolvers only (no ad/analytics sharing) |

### Data Use Certification (Check all 3 boxes in CWS Dashboard)
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

### Remote Code
- **Are you using remote code?** **No.** All JavaScript is bundled inside the extension package (`script-src 'self'; object-src 'none'; base-uri 'none';`), with zero runtime third-party dependencies.

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED — verified HTTP 200 public]
`https://github.com/Jrdelt/email/blob/main/docs/privacy.md`

---

## Distribution & Developer Info

- **Visibility:** Public (or Unlisted for initial testing)
- **Regions:** All regions
- **Publisher Name:** `[Fill in your publisher display name]`
- **Contact Email:** `[Fill in a monitored email address — required and shown publicly on Chrome Web Store]`
- **Homepage URL:** `https://github.com/Jrdelt/email`
- **Support URL:** `https://github.com/Jrdelt/email/issues`

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 0.1.0 | 2026-11-23 | Initial store-ready package: local phishing detection for Gmail, Outlook Web, and iCloud Mail; untrusted attachment locking; click-time link guard & `warning.html` recovery guide; domain RDAP/DNS/URIBL checks. | Draft |

---

## Review Notes & Known Limitations

- **Reviewer test instructions (paste into "Notes for Reviewer" on Chrome & Edge):**
  > 1. Sign in to Gmail (`https://mail.google.com`), Outlook on the web (`https://outlook.live.com`), or iCloud Mail (`https://www.icloud.com/mail`). *(No special account is required for the extension itself — it works locally with zero sign-in.)*
  > 2. Open any email from an untrusted sender containing an attachment or suspicious link/sender mismatch: a warning banner appears at the top of the page and attachments/flagged links are paused until you click "I trust this email".
  > 3. Click the extension toolbar icon to view the local check summary, domain details, trusted senders list, and the "Clicked a suspicious link?" recovery guide.
- **Withheld Yahoo & Proton host permissions:** `yahoo.ts` and `proton.ts` are roadmap stubs (`T7c`/`T7d`), so `mail.yahoo.com` and `mail.proton.me` are intentionally omitted from `manifest.json` `host_permissions` until implemented to comply with Chrome Web Store & Edge Add-ons minimum-permission rules.
