# Privacy Policy for Phishing Email Detector

**Last updated:** November 23, 2026

Phishing Email Detector checks emails you open in supported webmail services (**Gmail / Google Workspace**, **Outlook on the web / Microsoft 365**, **Apple iCloud Mail**, **Yahoo Mail**, and **Proton Mail**) directly inside your browser to warn about phishing, deceptive links, and unsafe attachments.

## 1. What Data We Process (and What Never Leaves Your Device)

- **Processed locally in your browser only (never transmitted):** Email subject lines and message text, sender display names and full email addresses, attachment filenames and file contents (attachments are never downloaded or read), and full link URLs (including paths, query parameters, and `#fragments`) are analyzed strictly in memory on your device.
- **Optional Strict Local Mode (0 network lookups — HIPAA / enterprise ready):** Users can enable **Strict Local Mode** directly in the extension toolbar popup (and enterprise IT administrators can enforce it via `managed_schema.json` / `browser.storage.managed`). When Strict Local Mode is active, **zero network requests** leave your browser.
- **Standard Mode domain lookups (bare registrable domain names only):** When Strict Local Mode is off and you open an untrusted email or click an external link inside an email, the extension queries **only the bare registrable domain name** (for example `example.com` — never `you@example.com`, never the message content, and never the full URL path or query string) against public domain-registration and DNS services to check domain age, mail configuration (`MX`/`SPF`/`DMARC`), and public spam listings.
- **No analytics, tracking, accounts, or `storage.sync`:** The extension does not use cookies, analytics SDKs, crash telemetry, advertising identifiers, cloud profile syncing (`storage.sync`), or developer-operated backend servers.

## 2. How Data Is Stored

All extension state is stored **exclusively on your device** using browser local/session storage (`storage.local` and `storage.session`):

- **Privacy preferences (`privacySettings` in `storage.local`, optional enterprise override via `storage.managed`):** Stores your `Strict Local Mode` preference.
- **Trusted senders (`trustedSenders` in `storage.local`):** Exact email addresses you explicitly choose to trust via *"Always trust sender"*.
- **Trusted emails (`trustedEmails` in `storage.local`, up to 500 entries):** One-way SHA-256 cryptographic hashes only (no email text, links, attachment names, or sender addresses are stored) so emails you unlock with *"I trust this email"* stay unlocked across page refreshes.
- **False-positive notes (`falsePositiveReports` in `storage.local`, up to 50 entries):** Verdict level, numeric score, and redacted warning reason text saved locally when you click *"Not phishing"* (attachment filenames, email addresses, full URLs, IPv4/IPv6 addresses, and domain names are stripped to `[file]`, `[address]`, `[url]`, `[ip]`, and `[domain]`). Never transmitted anywhere.
- **Domain lookup caches (`domainIntelCache` for 24 hours, `rdapBootstrap` for 7 days in `storage.local`):** Public domain registration and DNS results keyed by registrable domain name to avoid repeated network lookups.
- **Temporary tab & link-warning state (`tab:*` and `warn:*` in `storage.session`, in memory only):** `tab:*` holds the latest verdict for each open webmail tab so the toolbar popup can show it, including the sender's display name and address, link domains, and attachment names; it is removed when the tab closes or navigates to a new page. `warn:*` holds the clicked link's URL for the warning page; it is removed when you go back or proceed, after 1 hour, or when the browser closes. *"Clear all local data"* removes both.

## 3. How Data Is Used

Every piece of data processed by the extension is used solely for its single purpose — detecting phishing emails, pausing risky links and untrusted attachments in webmail, and displaying clear security warnings to you. Data is never used for advertising, profiling, creditworthiness, lending, or any unrelated purpose.

## 4. Third-Party Services Used for Domain Lookups (Disabled in Strict Local Mode)

When **Strict Local Mode** is off and the extension checks a sender's registrable domain or a clicked external link's registrable domain, those public lookup services receive only the **bare domain name** and your **IP address** (all requests use `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`). Domains on private or special-use top-level domains (for example `.local`, `.lan`, `.corp`, `.internal`, `.home`, `.intranet`) are never looked up, so intranet host names are not disclosed:

- **IANA RDAP Bootstrap (`data.iana.org`) & Domain Registry RDAP Servers (with `rdap.org` fallback):** Used to look up domain registration date and registrar ([ICANN/IANA Privacy Policy](https://www.icann.org/privacy/policy), [rdap.org Info](https://about.rdap.org/)).
- **Cloudflare Public DNS (`cloudflare-dns.com`):** Used for DNS-over-HTTPS `MX`, `SPF`, `DMARC`, `NXDOMAIN`, and URIBL queries ([Cloudflare 1.1.1.1 Privacy Policy](https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/)).
- **Google Public DNS (`dns.google`):** Used only as a fallback if Cloudflare's URIBL DNS query is rate-limited ([Google Public DNS Privacy](https://developers.google.com/speed/public-dns/privacy)).
- **URIBL (`multi.uribl.com` via DNS):** Queried via DNS to check whether a domain is publicly listed for spam or phishing ([URIBL About/Policy](https://uribl.com/about.shtml)).

DNS lookups are answered by the queried domain's own name servers (through the public resolver, so they see the resolver, not your IP address). Whoever runs a sender's domain, which can be the sender, may therefore notice that the domain was looked up shortly after their email was opened, even when your webmail blocks remote images. Strict Local Mode removes this signal along with every other lookup.

## 5. Data Sharing and Sale

We do **not** sell, rent, license, or share user data with third parties. Aside from the bare registrable-domain lookups in Section 4 (which are disabled completely when Strict Local Mode is on), zero data leaves your browser.

## 6. Data Retention and User Controls

- Temporary session state (`storage.session`) is deleted when you close or navigate the tab, go back from or proceed through a warning, after 1 hour (link warnings), when you click *"Clear all local data"*, or when you close your browser.
- Cached domain lookups expire after 24 hours.
- You can toggle **Strict Local Mode**, view and remove **Trusted senders**, clear **Trusted emails** (or click **Undo** immediately after trusting), clear **False-positive reports**, or wipe everything with **"Clear all local data"** directly from the toolbar popup.
- Uninstalling the extension permanently deletes all local storage associated with the extension from your browser.

## 7. Changes to This Policy

If the extension's data practices or lookup endpoints ever change, we will update this policy, provide an in-extension/release notice, and update the "Last updated" date above prior to releasing the change.

## 8. Contact

For privacy questions or concerns, open an issue or contact the maintainer via [https://github.com/Jrdelt/email](https://github.com/Jrdelt/email) (or see [SECURITY.md](../SECURITY.md) for private security/privacy reports).
