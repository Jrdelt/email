# Privacy Policy for Phishing Email Detector

**Last updated:** November 25, 2026

Phishing Email Detector checks the emails you open in supported webmail (**Gmail / Google Workspace**, **Outlook on the web / Microsoft 365**, **Apple iCloud Mail**, **Yahoo Mail** and **Proton Mail**) inside your browser. It warns you about phishing, deceptive links and unsafe attachments.

## 1. What data is processed, and what never leaves your device

- **Processed only in your browser, never sent:** email subjects and text, sender display names and full email addresses, attachment file names, and full link URLs (including paths, query parameters and `#fragments`). These are analyzed in memory on your device. Attachment files are never downloaded or read.
- **Strict Local Mode (zero network lookups):** You can turn on Strict Local Mode in the extension's toolbar popup, and IT administrators can enforce it through enterprise policy (`managed_schema.json` / `browser.storage.managed`). It is recommended for HIPAA-regulated environments. While it is on, **no network requests** leave your browser.
- **Standard Mode domain lookups (bare domain names only):** When Strict Local Mode is off and you open an untrusted email or click an outside link in an email, the extension looks up **only the bare registrable domain** (for example `example.com`; never `you@example.com`, never the message content, and never the full URL path or query string). It uses public domain-registration and DNS services to check domain age, mail setup (`MX`, `SPF`, `DMARC`) and public spam listings.
- **No analytics, tracking, accounts or sync:** The extension uses no cookies, analytics SDKs, crash telemetry, advertising identifiers, cloud profile sync (`storage.sync`) or developer-run servers.

## 2. What is stored, and where

All extension data is stored **only on your device**, in the browser's extension storage (`storage.local` and `storage.session`):

- **Privacy setting** (`privacySettings` in `storage.local`, optionally overridden by enterprise policy through `storage.managed`): your Strict Local Mode choice.
- **Trusted senders** (`trustedSenders` in `storage.local`): exact email addresses you chose to trust with *"Always trust sender"*.
- **Trusted emails** (`trustedEmails` in `storage.local`, up to 500 entries): one-way SHA-256 hashes only, so emails you unlock with *"I trust this email"* stay unlocked after a page refresh. No email text, links, attachment names or sender addresses are stored.
- **False-positive notes** (`falsePositiveReports` in `storage.local`, up to 50 entries): when you click *"Not phishing"*, the verdict level, numeric score and warning text are saved, with email addresses, full URLs, IPv4 addresses and domain names replaced by `[address]`, `[url]`, `[ip]` and `[domain]`. These notes are never sent anywhere. Administrators can turn them off by policy (`disableLocalReports`).
- **Domain lookup caches** (`domainIntelCache` for 24 hours and `rdapBootstrap` for 7 days, in `storage.local`): public registration and DNS results, keyed by domain name, so the same domain is not looked up repeatedly.
- **Temporary state** (in `storage.session`, which is kept in memory and cleared when the browser closes):
  - `tab:*` holds the latest result for each webmail tab, including the sender details shown in the popup. It is deleted when the tab closes.
  - `warn:*` holds a paused link for the warning page. It contains no sender email address and expires after 1 hour.

## 3. How data is used

All data is used only for the extension's single purpose: detecting phishing emails, pausing risky links and untrusted attachments in webmail, and showing clear security warnings to you. It is never used for advertising, profiling, creditworthiness, lending or any unrelated purpose.

## 4. Third-party services used for domain lookups (off in Strict Local Mode)

When Strict Local Mode is off and the extension checks a sender's registrable domain or a clicked outside link's registrable domain, these public services receive only the **bare domain name** and your **IP address**. Every request uses `credentials: 'omit'` (no cookies or logins) and `referrerPolicy: 'no-referrer'`.

- **IANA RDAP bootstrap (`data.iana.org`) and domain registry RDAP servers, with `rdap.org` as a fallback:** look up a domain's registration date and registrar ([ICANN/IANA Privacy Policy](https://www.icann.org/privacy/policy), [rdap.org info](https://about.rdap.org/)).
- **Cloudflare Public DNS (`cloudflare-dns.com`):** DNS-over-HTTPS queries for `MX`, `SPF`, `DMARC`, `NXDOMAIN` and URIBL ([Cloudflare 1.1.1.1 Privacy Policy](https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/)).
- **Google Public DNS (`dns.google`):** used only as a fallback when Cloudflare's URIBL query is refused or fails ([Google Public DNS Privacy](https://developers.google.com/speed/public-dns/privacy)).
- **URIBL (`multi.uribl.com`, queried through DNS):** checks whether a domain is publicly listed for spam or phishing ([URIBL About/Policy](https://uribl.com/about.shtml)).

## 5. Data sharing and sale

We do **not** sell, rent, license or share user data with third parties. Apart from the bare-domain lookups in Section 4 (which are completely off in Strict Local Mode), no data leaves your browser.

## 6. Data retention and your controls

- Temporary session state is deleted when the tab closes (`tab:*`), when you proceed past a warning or after 1 hour (`warn:*`), and when you close the browser.
- Cached domain lookups expire after 24 hours.
- From the toolbar popup you can turn **Strict Local Mode** on or off, view and remove **trusted senders**, clear **trusted emails**, clear **false-positive notes**, or use **"Clear all local data"** to delete trusted senders, trusted emails, false-positive notes and domain lookup caches at once. Right after trusting an email, you can also click **Undo** in the banner.
- Uninstalling the extension permanently deletes all of its local storage from your browser.

## 7. Changes to this policy

If the extension's data practices or lookup endpoints change, we will update this policy, give notice in the extension or in the release notes, and update the "Last updated" date above before releasing the change.

## 8. Contact

For privacy questions, open an issue or contact the maintainer through [https://github.com/Jrdelt/email](https://github.com/Jrdelt/email). For private security or privacy reports, see [SECURITY.md](../SECURITY.md).
