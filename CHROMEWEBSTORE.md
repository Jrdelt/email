# Chrome Web Store & Microsoft Edge Add-ons Listing — Phishing Email Detector

> Last Updated: 2026-11-28

> **Important Version Note:** Chrome Web Store version `0.1.0` (ID `bdpnkkpanopdfhnclfcpllnlccphlejp`) was submitted prior to adding **Strict Local Mode (`managed_schema.json`)** and the **Yahoo Mail** & **Proton Mail** adapters (`mail.yahoo.com`, `mail.proton.me`). Its **Privacy practices** tab was filled in with the earlier answers (*Personal communications: No*, *Web history: No*), which under-declare what 0.1.0 already does (sender and clicked-link domains are looked up). Safest: cancel the 0.1.0 review and resubmit with the corrected answers below; otherwise correct the Privacy practices tab as soon as 0.1.0 is approved, without waiting for the next version. Then bump `extension/package.json` `"version"` to `0.2.0` before submitting the next update to Chrome Web Store.
>
> **Open owner decision (version label):** `extension/package.json` is still `0.1.0`, so every archive built now (`npm run zip:all`, including the ones for a fresh Edge Add-ons or Firefox AMO submission) is labelled `0.1.0` although it contains the 0.2.0 features (Yahoo Mail, Proton Mail, Strict Local Mode, click-time checks of form submissions). The new name and short description in [store/listing/name.txt](store/listing/name.txt) and [summary.txt](store/listing/summary.txt) are not in `extension/wxt.config.ts` yet either. Decide when to bump to `0.2.0` (and apply both files with it) before uploading anywhere. See [docs/browser-support-and-stores.md](docs/browser-support-and-stores.md) and [docs/hipaa-and-compliance.md](docs/hipaa-and-compliance.md) for all browser stores and HIPAA guidance.

---

## Store Packages

Build the archives with `cd extension && npm run build:all && npm run zip:all`. They are written to `extension/.output/` (gitignored), named after the version in `extension/package.json` (see the version note above):
- **Chrome Web Store ZIP:** `extension/.output/phishing-email-detection-extension-<version>-chrome.zip`
- **Microsoft Edge Add-ons ZIP:** `extension/.output/phishing-email-detection-extension-<version>-edge.zip`
- **Firefox AMO:** `extension/.output/phishing-email-detection-extension-<version>-firefox.zip` plus `...-sources.zip` (build instructions inside, from [extension/README.md](extension/README.md))

---

## Store Listing

**Extension Name** and **Short Description** [REQUIRED]
The store takes both from the package manifest (`extension/wxt.config.ts`), so they change only with a new version:
- **Now (0.1.0 manifest):** *Phishing Email Detector* / *Warns about phishing in webmail. Email content stays in your browser; only sender and clicked link domains are checked.* (119 / 132 characters)
- **With 0.2.0:** [store/listing/name.txt](store/listing/name.txt) and [store/listing/summary.txt](store/listing/summary.txt), copied into `wxt.config.ts` together with the version bump (not done yet).

**Detailed Description** [REQUIRED — plain text]
> Paste from [store/listing/description-0.1.0.txt](store/listing/description-0.1.0.txt) now, and [description-0.2.0.txt](store/listing/description-0.2.0.txt) together with the 0.2.0 package, opened in a plain-text editor (see [store/README.md](store/README.md)). Never copy it from a rendered page: that is how hard line breaks reached the live listing. (The older reference copy of the description that used to be here was removed: it had drifted from the code.)

**Category** [REQUIRED]
- **Chrome Web Store:** `Privacy & Security` (set on the live listing)
- **Microsoft Edge Add-ons:** `Security & Privacy`

**Single Purpose** [REQUIRED]
Detects phishing signs in emails opened in supported webmail services and warns users before they open risky links or untrusted attachments.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

> Current files: [store/graphics/](store/graphics/) (real screenshots of the extension on an invented webmail page, re-captured on 2026-11-28; small promo tile, marquee, padded store icon, Edge logo); see [store/README.md](store/README.md) for the upload order. The live 0.1.0 listing still has older mockup screenshots: replace them with screenshots 1-4.

| Asset | Dimensions | Store | Status | Filename (in `store/graphics/`) |
|-------|-----------|-------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | Chrome & Edge | ✅ Ready | `store-icon-128-padded.png` |
| Edge Store Logo [REQUIRED for Edge] | 300×300 PNG | Edge Add-ons | ✅ Ready | `edge-logo-300x300.png` |
| Screenshot 1 [REQUIRED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `screenshot-1-spot-phishing.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `screenshot-2-see-why.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `screenshot-3-link-stopped.png` |
| Screenshot 4 [RECOMMENDED] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready | `screenshot-4-attachments-locked.png` |
| Screenshot 5 [with 0.2.0] | 1280×800 (24-bit PNG) | Chrome & Edge | ✅ Ready (shows Strict Local Mode) | `screenshot-5-private.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 (24-bit PNG) | Chrome & Edge | ✅ Ready | `small-promo-440x280.png` |
| Marquee Promo Tile [OPTIONAL] | 1400×560 (24-bit PNG) | Chrome & Edge | ✅ Ready | `marquee-1400x560.png` |

---

## Permissions Justification

Copy-paste these plain-English explanations into the **Chrome Web Store Privacy Practices** tab and **Microsoft Partner Center Notes for Certification**:

| Permission / Host Pattern | Type | Justification |
|---------------------------|------|---------------|
| `storage` | `permissions` | Stores the user's local trusted-sender allowlist, one-way SHA-256 digests of trusted emails, redacted local false-positive notes, Strict Local Mode preference (plus read-only `storage.managed` enterprise policy schema), in-memory session state (`storage.session`: the latest verdict per open webmail tab for the toolbar popup, and short-lived link-warning entries that are removed when the warning is closed and pruned once older than 1 hour), and a 24-hour local cache of domain lookup results (`storage.local`) on the user's device. |
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
  - **Registrable website domains (check `Personal communications`, `Web history` and `Website content` in the CWS form, domain names only):** When an untrusted email is opened, or an external link inside an email is clicked or a web form in it is submitted (also by pressing Enter), **only the bare registrable domain name** (e.g., `example.com`, never URL paths/queries or email addresses) is queried over HTTPS against public IANA/registry RDAP (`data.iana.org`, registry RDAP / `rdap.org`) and public DNS-over-HTTPS (`cloudflare-dns.com`) to check whether the domain exists, its age, and its mail setup. Like any browser request, each lookup also carries the user's IP address, the browser's `User-Agent` and an `Origin: chrome-extension://<extension ID>` header, so these services can tell the domain came from this extension (see [docs/privacy.md](docs/privacy.md) §4). No developer backend, analytics, or user tracking exists.

| Data Type | Collected / Stored Externally by Developer? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|---------------------------------------------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | No | No | N/A | No |
| Personal communications | Domain name only (the sender's registrable domain; emails themselves are analyzed locally in browser memory only) | Yes — only the registrable domain of the sender of an opened untrusted email (never the address, content, full link URLs or attachments; a clicked link's domain is covered under Web history) to public RDAP & DNS resolvers | Check the sender domain's registration age, existence and email records | Public RDAP & DNS resolvers only (no ad/analytics sharing) |
| Location | No (the extension never reads, stores or sends an IP address or location; public RDAP/DNS resolvers see the user's IP, and the browser's standard request headers including the extension's `Origin`, only as metadata of each lookup, see privacy.md §4) | No | N/A | No |
| Web history | Domain name only (of a clicked external link or a submitted form's destination) | Yes — only the registrable domain of an external link the user clicks, or of the destination of a form the user submits, in an email (never the URL path, query, form fields or the user's other browsing) to public RDAP & DNS resolvers | Check a clicked link's or submitted form's destination before it opens | Public RDAP & DNS resolvers only (no ad/analytics sharing) |
| User activity | No | No | N/A | No |
| Website content | Domain name only (sender / clicked link or submitted form destination registrable domain) | Yes — bare domain name only to public RDAP & DNS resolvers (cached up to 24 h) | Check domain registration age, existence and DNS email records | Public RDAP & DNS resolvers only (no ad/analytics sharing) |

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
- **Support URL:** `https://github.com/Jrdelt/email/issues` (public: the listing and the issue template tell users to leave out names, addresses and file names, and to use [SECURITY.md](SECURITY.md) private reporting for anything sensitive)

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| (next) | 2026-11-28 | Privacy practices answers corrected: *Personal communications*, *Web history* and *Website content* are checked (registrable domains only, to public RDAP/DNS). URIBL spam-list lookup and its `dns.google` fallback removed (URIBL refuses public resolvers); form submissions in emails checked at click time like links; many lock and detection fixes. | Pending submission |
| 0.1.0 | 2026-11-23 | Initial store-ready package: local phishing detection for Gmail, Outlook Web, and iCloud Mail; untrusted attachment locking; click-time link guard & `warning.html` recovery guide; domain RDAP/DNS checks (plus a URIBL spam-list lookup through Cloudflare and, in practice for every lookup, Google Public DNS `dns.google`, which almost never answered and was removed in the next version; docs/privacy.md §4 keeps a note on it while 0.1.0 is served). | Submitted (in review) |

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
- **Known limitations (also in [docs/threat-model.md](docs/threat-model.md)):** desktop browsers only; sender verification ("couldn't verify", `via`) is read only in Gmail with an English interface; inbox-list file buttons are guarded only in Gmail; image-only emails and links that open an app (`search-ms:`, `ms-word:`, ...) are not scored or checked at click time; links opened from the browser's own context menu skip the click-time check on unflagged emails; each domain lookup carries the browser's `User-Agent` and the extension's `Origin` header.
