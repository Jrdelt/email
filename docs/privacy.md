# Privacy Policy for Phishing Email Detector

**Last updated:** November 28, 2026

Phishing Email Detector checks emails you open in supported webmail services (**Gmail / Google Workspace**, **Outlook on the web / Microsoft 365**, **Apple iCloud Mail**, **Yahoo Mail**, and **Proton Mail**) directly inside your browser to warn about phishing, deceptive links, and unsafe attachments.

## 1. What Data We Process (and What Never Leaves Your Device)

- **Processed locally in your browser only (never transmitted):** Email subject lines and message text, sender display names and full email addresses, attachment filenames and file contents (attachments are never downloaded or read), and full link URLs (including paths, query parameters, and `#fragments`) are analyzed strictly in memory on your device.
- **Optional Strict Local Mode (0 network lookups — HIPAA / enterprise ready):** Users can enable **Strict Local Mode** directly in the extension toolbar popup (and enterprise IT administrators can enforce it via `managed_schema.json` / `browser.storage.managed`). When Strict Local Mode is active, **zero network requests** leave your browser.
- **Standard Mode domain lookups (bare registrable domain names only):** When Strict Local Mode is off and you open an untrusted email, or click an external link or submit a web form inside an email, the extension queries **only the bare registrable domain name** (for example `example.com` — never `you@example.com`, never the message content, never form fields, and never the full URL path or query string) against public domain-registration and DNS services to check whether the domain exists, how old it is, and its mail configuration (`MX`/`SPF`/`DMARC`). There is no spam-list lookup.
- **"Copy details for IT" (your clipboard only):** This button in the banner's IT options copies a plain-text summary to your clipboard: the sender's name and address, the sender's and links' domains, the warning reasons (which can include attachment file names) and the domain lookup results. It is copied on your device and sent nowhere. Remove anything personal before you paste it somewhere public, such as a GitHub issue.
- **No analytics, tracking, accounts, or `storage.sync`:** The extension does not use cookies, analytics SDKs, crash telemetry, advertising identifiers, cloud profile syncing (`storage.sync`), or developer-operated backend servers.

## 2. How Data Is Stored

All extension state is stored **exclusively on your device** using browser local/session storage (`storage.local` and `storage.session`):

- **Privacy preferences (`privacySettings` in `storage.local`, optional enterprise override via `storage.managed`):** Stores your `Strict Local Mode` preference.
- **Trusted senders (`trustedSenders` in `storage.local`):** Exact email addresses you explicitly choose to trust via *"Always trust sender"*.
- **Trusted emails (`trustedEmails` in `storage.local`, up to 500 entries):** One-way SHA-256 cryptographic hashes only (no email text, links, attachment names, or sender addresses are stored) so emails you unlock with *"I trust this email"* stay unlocked across page refreshes.
- **False-positive notes (`falsePositiveReports` in `storage.local`, up to 50 entries):** Verdict level, numeric score, and redacted warning reason text saved locally when you click *"Not phishing"* (attachment filenames, email addresses, full URLs, IPv4/IPv6 addresses, and domain names are stripped to `[file]`, `[address]`, `[url]`, `[ip]`, and `[domain]`). Never transmitted anywhere.
- **Domain lookup caches (`domainIntelCache` for 24 hours, or 15 minutes when a lookup only partly succeeded, newest 200 domains; `rdapBootstrap` for 7 days in `storage.local`):** Public domain registration and DNS results keyed by registrable domain name to avoid repeated network lookups. Expired results are deleted when the extension's background next starts or next looks up a domain. Turning on Strict Local Mode (yourself or by IT policy) deletes them all.
- **Temporary tab & link-warning state (`tab:*` and `warn:*` in `storage.session`, in memory only):** `tab:*` holds the latest verdict for each open webmail tab so the toolbar popup can show it, including the sender's display name and address, link domains, and attachment names; it is removed when the tab closes or navigates to another site. `warn:*` holds the clicked link's URL for the warning page (and, when the link went through your organization's link-protection service such as Microsoft Safe Links, the URL you clicked, which can contain your own email address); it is removed when you go back, proceed or close the warning tab, is dropped once it is over 1 hour old (when the extension's background starts, or at the next tab close or link warning), and is gone when the browser closes. *"Clear all local data"* removes both.

## 3. How Data Is Used

Every piece of data processed by the extension is used solely for its single purpose — detecting phishing emails, pausing risky links and untrusted attachments in webmail, and displaying clear security warnings to you. Data is never used for advertising, profiling, creditworthiness, lending, or any unrelated purpose.

## 4. Third-Party Services Used for Domain Lookups (Disabled in Strict Local Mode)

When **Strict Local Mode** is off and the extension checks a sender's registrable domain or the registrable domain of an external link you click (or a web form you submit) in an email, those public lookup services receive the **bare domain name** in the request, plus what every browser request carries: your **IP address** and the browser's standard request headers. All requests use `credentials: 'omit'` (no cookies) and `referrerPolicy: 'no-referrer'` (no page address). Domains on private or special-use top-level domains (for example `.local`, `.lan`, `.corp`, `.mail`, `.internal`, `.home`, `.intranet`) are never looked up, so intranet host names are not disclosed. Sites on free hosting services (such as `pages.dev`, `netlify.app` or `github.io`) are not looked up either: a click on one goes to the warning page instead, because the service's own domain says nothing about who runs the site.

- **IANA RDAP Bootstrap (`data.iana.org`) & Domain Registry RDAP Servers (with `rdap.org` fallback):** Used to look up domain registration date and registrar ([ICANN/IANA Privacy Policy](https://www.icann.org/privacy/policy), [rdap.org Info](https://about.rdap.org/)).
- **Cloudflare Public DNS (`cloudflare-dns.com`):** Used for DNS-over-HTTPS `MX`, `SPF` and `DMARC` queries, which also show whether the domain exists (`NXDOMAIN`) ([Cloudflare 1.1.1.1 Privacy Policy](https://developers.cloudflare.com/1.1.1.1/privacy/public-dns-resolver/)).

No other service is contacted. There is no spam-list (URIBL) check and no Google Public DNS (`dns.google`) lookup.

**What the request headers reveal.** Each lookup also carries the browser's `User-Agent` and an `Origin` header naming the extension: `chrome-extension://<extension ID>` in Chrome (Edge sends its own store ID). The ID is the same for everyone who installs the extension from that store, so it identifies the extension, not you, but it does tell Cloudflare, IANA, the domain registries and `rdap.org` that the domain came from an email you opened or a link you clicked. The browser adds this header to every request of this kind, and the extension cannot remove it without a new permission. Firefox uses a `moz-extension://` origin whose ID is chosen at random when the extension is installed; we have not yet confirmed whether Firefox sends it with these lookups. If it does, the services could tell that several lookups came from the same Firefox profile. Strict Local Mode turns all of this off.

DNS lookups are answered by the queried domain's own name servers (through the public resolver, so they see the resolver, not your IP address). Whoever runs a sender's domain, which can be the sender, may therefore notice that the domain was looked up shortly after their email was opened, even when your webmail blocks remote images. Strict Local Mode removes this signal along with every other lookup.

## 5. Data Sharing and Sale

We do **not** sell, rent or license user data, and share none with advertisers or analytics providers. The only data shared with third parties is the bare registrable domain of an untrusted email's sender or of a link you click (seen together with your IP address and the request headers described in Section 4), sent to the public RDAP and DNS services in Section 4; Strict Local Mode turns this off completely. Nothing else leaves your browser.

## 6. Data Retention and User Controls

- Temporary session state (`storage.session`) is deleted when you close the tab or leave the webmail site, go back from, proceed through or close a warning, once a link warning is over 1 hour old (when the extension's background starts, or at the next tab close or warning), when you click *"Clear all local data"*, or when you close your browser.
- Cached domain lookups expire after 24 hours (15 minutes for partial results); expired ones are deleted when the extension's background next starts or next looks up a domain, and all of them are deleted when Strict Local Mode is turned on.
- You can toggle **Strict Local Mode**, view and remove **Trusted senders**, clear **Trusted emails** (or click **Undo** immediately after trusting), clear **False-positive reports**, or use **"Clear all local data"** in the toolbar popup to erase trusted senders, trusted emails, false-positive notes, lookup caches and the temporary tab and warning state at once (your Strict Local Mode choice is kept).
- Uninstalling the extension permanently deletes all local storage associated with the extension from your browser.

## 7. Changes to This Policy

If the extension's data practices or lookup endpoints ever change, we will update this policy, provide an in-extension/release notice, and update the "Last updated" date above prior to releasing the change.

## 8. Contact

For privacy questions or concerns, open an issue or contact the maintainer via [https://github.com/Jrdelt/email](https://github.com/Jrdelt/email) (or see [SECURITY.md](../SECURITY.md) for private security/privacy reports).
