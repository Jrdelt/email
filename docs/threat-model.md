# Threat Model

## Goals and assets

- **Goal:** warn users about phishing emails, malicious attachments and deceptive links in webmail, while keeping false alarms low (target: a false-positive rate of 0.1% or less).
- **Protected assets:** user credentials, session state, the safety of the user's device, user trust, and mailbox privacy. Email bodies, attachment contents and names, sender addresses and full URLs never leave the browser.
- **Out of scope (v1):** deep inspection of attachment contents (such as encrypted ZIPs, PDFs or Office files), desktop and mobile mail apps, and server-side mail filtering.

## What an attacker can do

An attacker can send any HTML email to the user and may try to:

- **Impersonate a brand** with a display name (including squashed forms like `PayPalSupport`), a lookalike or homoglyph domain (letters that look alike), punycode (`xn--`), or a forged `From` header sent through a third-party relay.
- **Disguise a link** with link text that shows a different site, an `@` trick in the address, chains of redirects, URL shorteners, web pages on raw cloud storage, SVG `href`/`xlink:href` links, or form submissions (`<form action>` and `[formaction]`).
- **Deliver malware or credential-stealing pages as attachments**: `.html`, `.svg`, `.hta`, `.lnk`, `.iso`, `.exe`, double extensions like `invoice.pdf.exe`, or inline `data:`/`blob:` downloads.
- **Attack the extension's own code or UI**: clobber DOM properties (for example `<form><input name="getAttribute"></form>`), copy webmail header CSS classes inside the message body, or restyle the page to hide security warnings.

## Defenses and remaining limits

### 1. Link and form locking

When an email is flagged, the extension pauses links (`a`, `area`, SVG `href` and `xlink:href`), `<a ping>` beacons, embedded image links, form submissions and `[formaction]` controls. It moves their target attributes into `data-ped-*` attributes using helpers bound to `Element.prototype` (`src/dom.ts`), which cannot be tricked by DOM clobbering. It also blocks `click`, `auxclick`, `dragstart`, `submit` and `keydown` (`Enter`/`Space`) in the capture phase, and a `MutationObserver` locks any links added later.

- *Remaining limit:* a user copying a plain-text URL into the address bar.

### 2. Attachment locking for untrusted mail

In **any untrusted email**, the webmail's own attachment areas (Gmail shelves, Outlook attachment wells and cards, iCloud attachment bars, Yahoo tiles, Proton attachment lists) and inline `a[download]`, `data:` and `blob:` links are locked (`data-ped-att-locked`). The lock sets aside `href`, `download`, `download_url` and `formaction` attributes and blocks `click`, `auxclick`, `dblclick`, `mousedown`, `pointerdown`, `dragstart`, `submit` and `keydown` (`Enter`/`Space`). This applies even when the text scores safe or the banner is dismissed. File names are checked locally (`src/attachments.ts`) for smuggling files, executables and double extensions, without downloading anything.

- *Remaining limits:* the browser's own "Save link as…" menu, or a harmful payload inside a normal-looking file (such as a `.pdf`) after the user chooses to trust the email.

### 3. Click-time link check and race-to-click gate

If the user clicks a link or submits a form before the 400 ms delayed scan has finished, the scan runs immediately first (the `isPending` gate). When the user clicks an outside `http(s)` link, the extension:

- unwraps redirect wrappers (Outlook Safe Links, Google, Facebook, YouTube);
- checks local warning signs: an `@` in the address, a raw IPv4/IPv6 address, punycode, a raw cloud-storage web page, a risky file extension, an IP logger such as Grabify (`urlto.me`), a URL shortener, or unencrypted `http://`;
- looks up the destination domain, with a 700 ms time limit (skipped in Strict Local Mode).

Risky clicks open the local `warning.html` page. The link is passed through a one-time ID stored in `browser.storage.session` for up to 1 hour, which never contains the sender's email address.

- *Remaining limit:* server-side redirects that happen after the user reaches an established, reputable domain (catching these would need extra opt-in permissions such as `webNavigation`).

### 4. Spoof-resistant allowlist

Trusted senders (`trustedSenders`) match exact, validated email addresses only, never domains, wildcards or display names. When the webmail shows an unauthenticated-sender badge or a conflicting `via` relay that is not a known email service provider, `canTrustByAllowlist` refuses automatic trust, the banner disables "Always trust sender", and a spoofing warning is shown.

- *Remaining limit:* webmail views that hide authentication details until the user expands the headers.

## Third-party domain lookups and Strict Local Mode

By default, lookup services learn only the **registrable domain** of an opened email's sender or a clicked outside link, plus the user's IP address. Mitigations:

- **Strict Local Mode and enterprise policy** (`src/settings.ts`, `public/managed_schema.json`): users can turn it on in the popup, or IT admins can enforce `strictLocalMode: true` through `browser.storage.managed`. This disables every `domainIntel` `fetch()` call in the content script, click guard, warning page and background script, so nothing leaves the device.
- Strict `isValidDomain` checks before any request URL is built. The registry RDAP list from IANA is validated (`https:` only, checked hostnames, stored in an `Object.create(null)` map).
- `credentials: 'omit'` and `referrerPolicy: 'no-referrer'` on every `fetch`.
- A 24-hour local cache (`domainIntelCache`). DNS answers count only if they are `NOERROR` or `NXDOMAIN` (temporary `SERVFAIL` errors are ignored), and URIBL answers must be in `127.0.0.x`.
- Local false-positive notes are redacted (`feedback.ts` replaces addresses, full URLs, IPv4 addresses and domain names with `[address]`, `[url]`, `[ip]` and `[domain]`), and `warn:*` session entries hold no sender address (minimum necessary data).

## Permissions, messaging and UI isolation

- **Minimal install permissions:** only `storage` and the webmail sites in `extension/src/hosts.ts`: Gmail, Outlook on the web (including `outlook.cloud.microsoft`), Yahoo Mail, Proton Mail, and the iCloud Mail frames `www.icloud.com/mail/*`, `www.icloud.com/applications/mail2/*` and `*.icloud-sandbox.com/applications/mail2-message/*`. No `<all_urls>`, no `tabs` permission, no `web_accessible_resources`, and no runtime npm dependencies.
- **Checked messaging:** `background.ts` checks `sender.id`, checks `isSupportedWebmailUrl(sender.url)` on messages from webmail pages, and checks the frame (top frame or iCloud `app` frame for `verdict`, iCloud `sandbox` frame for `icloudBody`). It never uses `window.postMessage`.
- **Closed Shadow DOM and strict CSP:** the banner (`#ped-banner-host`) and toast (`#ped-toast-host`) use `attachShadow({ mode: 'closed' })` with `:host { all: initial !important }`, are mounted on `document.documentElement`, and are built only with `textContent` and `createElementNS`. Extension pages use the Content Security Policy `script-src 'self'; object-src 'none'; base-uri 'none';`.

## Planned hardening

- Evasion tests on a time-based split (T9) and SHA-256 checking of the exported model file (T5, T6). See [ROADMAP.md](ROADMAP.md).
