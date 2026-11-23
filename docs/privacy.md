# Privacy

- Email analysis runs locally in the browser. No email content, URLs, or sender addresses are transmitted.
- **Domain lookups (always on):** for each email you open, the extension looks up **only the sender's domain**
  (for example `paypal.com`, never `you@...` or the message) to show registration date, registrar, mail settings
  and spam reports. These services receive the domain and your IP address:
  - IANA (`data.iana.org`, registry list, weekly) and the domain's registry RDAP server (or `rdap.org`)
  - Cloudflare DNS (`cloudflare-dns.com`) for MX/SPF/DMARC and the URIBL spam list
  - Google DNS (`dns.google`), only if Cloudflare's URIBL query is refused
  Results are cached for 24 hours on your device, so a domain is looked up at most once a day.
- No analytics or telemetry.
- Permissions are limited to the supported webmail hosts and `storage`.
- Stored locally in `browser.storage.local` only:
  - **Trusted senders** you add: exact email addresses only, validated by a strict format check (no domains, wildcards or display names). View and remove them in the popup.
  - **Trusted emails** (up to 500): one-way SHA-256 fingerprints only (no email body, links, or sender address stored), so an email you trust with "I trust this email" stays unlocked across refreshes; view the count and clear them in the popup.
  - **False-positive reports** (up to 50): verdict level, score and reason text, with email addresses redacted.
    No email body or sender is stored. View the count and clear them in the popup. They are never sent anywhere.
