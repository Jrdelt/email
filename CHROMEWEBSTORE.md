# Chrome Web Store & Microsoft Edge Add-ons Listing — Phishing Email Detector

> Last Updated: 2026-11-25

> **Version note:** Chrome Web Store version `0.1.0` (ID `bdpnkkpanopdfhnclfcpllnlccphlejp`) was submitted before **Strict Local Mode** (`managed_schema.json`) and the **Yahoo Mail** and **Proton Mail** adapters (`mail.yahoo.com`, `mail.proton.me`) were added. Leave `0.1.0` in review as it is, and change `"version"` in `extension/package.json` to `0.2.0` before submitting the next Chrome Web Store update. New submissions to Edge Add-ons and Firefox AMO can use the latest build right away. See [docs/browser-support-and-stores.md](docs/browser-support-and-stores.md) for all stores and [docs/hipaa-and-compliance.md](docs/hipaa-and-compliance.md) for HIPAA guidance.

---

## Store Packages Ready to Upload

Ready-to-upload files are collected in a local `store-upload/` folder, which is not committed (`.gitignore`). Rebuild the ZIP files at any time with `cd extension && npm run build:all && npm run zip:all`:
- **Chrome Web Store ZIP:** `store-upload/phishing-email-detection-extension-0.1.0-chrome.zip` (also at `extension/.output/phishing-email-detection-extension-0.1.0-chrome.zip`)
- **Microsoft Edge Add-ons ZIP:** `store-upload/phishing-email-detection-extension-0.1.0-edge.zip` (also at `extension/.output/phishing-email-detection-extension-0.1.0-edge.zip`)

---

## Store Listing

**Extension Name** [REQUIRED]
Phishing Email Detector

**Short Description** [REQUIRED — 119 / 132 characters]
Warns about phishing in webmail. Email content stays in your browser; only sender and clicked link domains are checked.

**Detailed Description** [REQUIRED — plain text, copy-paste directly]

This text names all five webmail services in the current code. The `0.1.0` package in review supports only Gmail, Outlook on the web and iCloud Mail.

```text
Warns you about phishing emails, deceptive links, and unsafe attachments in Gmail, Outlook on the web, iCloud Mail, Yahoo Mail, and Proton Mail while keeping your email content private on your device.

FEATURES
• Spots impersonation and scam tactics — flags fake sender names, lookalike websites, urgent account threats, unverified senders, and links that display one website in the text while pointing somewhere else.
• Checks website reputation without exposing your mail — verifies how recently a sender's or clicked link's domain was registered, whether its email records are set up properly, and whether it appears on public spam lists.
• Pauses risky links and untrusted attachments — automatically disables links in flagged emails and blocks attachments from untrusted senders until you choose to trust the email, preventing accidental downloads or fake login pages.
• Protects you even if you click — inspects external links the moment you click them, unwraps tracking redirects, and stops dangerous or newly registered destinations on a warning screen with step-by-step recovery guidance.
• Clear, reversible trust controls — shows who really sent the message alongside where its links lead, asks for confirmation before unlocking high-risk alerts, and lets you undo trusting an email with one click.

HOW TO USE
1. Install Phishing Email Detector and open your webmail inbox.
2. Read your email as usual — clean messages stay out of your way, while suspicious emails or untrusted attachments display a clear warning banner at the top of the page.
3. Click "See why" on any banner (or open the extension icon in your toolbar) to inspect sender details, manage your trusted senders list, or open the recovery guide.

PRIVACY
Your email text, attachments, sender email addresses, and full link addresses never leave your browser. No account is required, and there is no analytics or tracking. To check website age and spam listings, only the bare website domain name is looked up via public domain registration (RDAP) and DNS services and cached locally on your device for 24 hours — or enable Strict Local Mode directly in the popup for zero network lookups.

PERMISSIONS
• Webmail site access — used only on supported webmail services so the extension can scan opened emails locally, show warning banners, and pause risky links and untrusted attachments.
• Local storage — saves your trusted senders list, trusted email fingerprints, local false-alarm notes, and domain lookup cache on your device.

SUPPORT
Found a bug or false alarm? Use the Support link on this listing to report an issue or share feedback.
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
| Store Icon [REQUIRED] | 128×128 PNG | Chrome & Edge | Ready | `store-upload/icon-128.png` (`extension/public/icons/icon-128.png`) |
| Edge Store Logo [REQUIRED for Edge] | 300×300 PNG | Edge Add-ons | Ready | `store-upload/edge-logo-300x300.png` |
| Screenshot 1 [REQUIRED] | 1280×800 (24-bit PNG) | Chrome & Edge | Ready | `store-upload/screenshot-1-phishing-banner-1280x800.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | Ready | `store-upload/screenshot-2-link-stopped-1280x800.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | Ready | `store-upload/screenshot-3-attachment-lock-popup-1280x800.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 (24-bit PNG) | Chrome & Edge | Ready | `store-upload/small-promo-440x280.png` |

---

## Permissions Justification

Copy-paste these plain-English explanations into the **Chrome Web Store Privacy Practices** tab and **Microsoft Partner Center Notes for Certification**:

| Permission / Host Pattern | Type | Justification |
|---------------------------|------|---------------|
| `storage` | `permissions` | Stores the user's local trusted-sender allowlist, one-way SHA-256 digests of trusted emails, redacted local false-positive notes, Strict Local Mode preference (plus read-only `storage.managed` enterprise policy schema), temporary 1-hour link-warning session tokens (`storage.session`), and a 24-hour local cache of domain lookup results (`storage.local`) on the user's device. |
| `https://mail.google.com/*` | `host_permissions` | Reads the currently opened email's sender header, text, links, and attachment shelf in Gmail locally in the browser to detect phishing indicators, display an in-page warning banner, and pause risky links and untrusted attachments until unlocked by the user. |
| `https://outlook.live.com/*`, `https://outlook.office.com/*`, `https://outlook.office365.com/*`, `https://outlook.cloud.microsoft/*` | `host_permissions` | Reads the currently opened email in consumer Outlook.com and Microsoft 365 Outlook on the web locally in the browser to detect phishing indicators, display an in-page warning banner, and pause risky links and untrusted attachments. |
| `https://mail.yahoo.com/*` | `host_permissions` | Reads the currently opened email in Yahoo Mail locally in the browser (excluding compose drafts) to detect phishing indicators, display warning banners, and pause risky links and untrusted attachments. *(Included starting in `0.2.0` / fresh Edge & Firefox builds.)* |
| `https://mail.proton.me/*` | `host_permissions` | Reads the already-decrypted visible email view in Proton Mail locally in the browser (without accessing encryption keys or Proton APIs) to detect phishing indicators, display warning banners, and pause risky links and untrusted attachments. *(Included starting in `0.2.0` / fresh Edge & Firefox builds.)* |
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
| 0.1.0 | 2026-11-23 | Initial store-ready package: local phishing detection for Gmail, Outlook Web, and iCloud Mail; untrusted attachment locking; click-time link guard & `warning.html` recovery guide; domain RDAP/DNS/URIBL checks. | In Review / Resubmitted |

### Rejection History

| Date | Reference / Violation | Fix Applied |
|------|-----------------------|-------------|
| 2026-11-23 | `Yellow Argon` — comma-separated webmail domain list flagged as excessive keywords in Description | Replaced domain list in Description `PERMISSIONS` section with plain-English prose |

---

## Review Notes & Known Limitations

- **Reviewer test instructions (paste into "Notes for Reviewer" on Chrome & Edge):**
  > 1. Sign in to Gmail (`https://mail.google.com`), Outlook on the web (`https://outlook.live.com`), or iCloud Mail (`https://www.icloud.com/mail`). *(No special account is required for the extension itself — it works locally with zero sign-in.)*
  > 2. Open any email from an untrusted sender containing an attachment or suspicious link/sender mismatch: a warning banner appears at the top of the page and attachments/flagged links are paused until you click "I trust this email".
  > 3. Click the extension toolbar icon to view the local check summary, domain details, trusted senders list, and the "Clicked a suspicious link?" recovery guide.
- **In-UI privacy control (`0.2.0` / fresh Edge & Firefox builds):** The toolbar popup includes a **Strict Local Mode (0 network lookups)** checkbox (and enterprise `managed_schema.json` policy override) plus a **Clear all local data** control for HIPAA/enterprise zero-egress deployments.
