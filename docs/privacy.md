# Privacy

- Email analysis runs locally in the browser. No email content, attachment files/names, URLs, or sender addresses are transmitted (attachments are never downloaded or read).
- **Domain lookups (always on):** for each email you open (the sender's domain) or external link you click inside an email (the destination's domain only — never the path, query string, or `#fragment`), the extension looks up **only that registrable domain**
  (for example `paypal.com`, never `you@...` or the message) to show registration date, registrar, mail settings
  and spam reports. These services receive the domain and your IP address:
  - IANA (`data.iana.org`, registry list, weekly) and the domain's registry RDAP server (or `rdap.org`)
  - Cloudflare DNS (`cloudflare-dns.com`) for MX/SPF/DMARC and the URIBL spam list
  - Google DNS (`dns.google`), only if Cloudflare's URIBL query is refused
  Results are cached for 24 hours on your device, so a domain is looked up at most once a day.
- No analytics or telemetry.
- Permissions are limited to the supported webmail hosts and `storage`.
- Intercepted link warning details for `warning.html` (`warn:*`) and the current tab's latest verdict (`tab:*`) are stored ephemerally in `browser.storage.session` (in memory only, never in URL query strings or browser history) and cleared automatically when a tab closes, when a warning expires after 1 hour, when you proceed, or when you close the browser.
- Stored locally in `browser.storage.local` only (never synced or sent anywhere):
  - **Trusted senders** (`trustedSenders`): exact email addresses you explicitly trust, validated by a strict format check (no domains, wildcards, or display names). View and remove them in the popup.
  - **Trusted emails** (`trustedEmails`, up to 500): one-way SHA-256 fingerprints only (no email body, links, attachment names, or sender address stored), so an email you trust with `"I trust this email"` stays unlocked across refreshes; revert immediately via the inline **Undo** pill or clear them in the popup.
  - **False-positive reports** (`falsePositiveReports`, up to 50): verdict level, score, and reason text, with email addresses redacted. No email body or sender is stored. View the count and clear them in the popup.
  - **Domain lookup cache** (`domainIntelCache`, up to 500 entries, 24 h TTL) and **IANA RDAP registry list** (`rdapBootstrap`, 7 d TTL): public RDAP/DNS results keyed strictly by registrable domain so repeated emails from the same domain avoid redundant network lookups.
