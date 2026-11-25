# Threat Model

## Assets & Goals

- **Goal:** Warn users about phishing emails, malicious attachments, and deceptive destination links in webmail while maintaining a low false-positive rate (`<=0.1%` target).
- **Protected assets:** User credentials, session state, local device safety, user trust, and mailbox privacy (zero email bodies, attachment contents/names, sender addresses, or full URLs ever leave the browser).
- **Out of scope (v1):** Deep byte-level attachment sandboxing (inspecting inside encrypted ZIPs, PDFs, or Office binaries), native desktop/mobile mail apps, and server-side mail gateway filtering.

## Attacker Capabilities

An adversary can send arbitrary HTML emails to the user's inbox and may attempt to:
- Impersonate trusted brands via display names (including compact/camelCase forms), lookalike/homoglyph domains, punycode (`xn--`), or forged `From` headers sent through third-party relays.
- Disguise malicious links via mismatched anchor text, `@` userinfo authority tricks, multi-hop open/tracking redirects, URL shorteners, raw cloud object storage HTML pages, SVG `href`/`xlink:href` anchors, or HTML `<form action>` / `[formaction]` submissions.
- Smuggle credentials stealers or malware via attachments (`.html`, `.svg`, `.hta`, `.lnk`, `.iso`, `.exe`, double extensions like `invoice.pdf.exe`, or inline `data:`/`blob:` downloads).
- Clobber DOM properties (`<form><input name="getAttribute"><input name="tagName"><input name="closest"></form>`) to crash the scanner or slip past the locks, spoof webmail header CSS classes inside the message body, or override page styles to hide/restyle security UI.

## Defense Layers & Residual Limits

### 1. Link & Form Locking
Flagged emails pause links (`a`, `area`, SVG `href` & `xlink:href`), `<a ping>` beacons, embedded image links, `<form>` submissions, and `[formaction]` controls by stashing attributes (`data-ped-*`) via prototype-bound helpers (`src/dom.ts`: attributes, `closest`, `contains`, `localName`, `textContent`, `nodeType`, `ownerDocument`, immune to `<form>` DOM clobbering; adapters also skip `<form>` elements as header/attachment candidates, see `isUnsafeNode` in `src/adapters/extract.ts`) and intercepting `click`, `auxclick`, `dragstart`, `submit`, and `keydown` (`Enter`/`Space`) in capture phase, with instant `MutationObserver` re-locking of dynamically inserted nodes.
- *Residual limit:* Users manually copying and pasting plain-text URLs into the address bar.

### 2. Always-On Attachment Locking for Untrusted Mail
Native webmail attachment shelves/cards (Gmail, Outlook Web, iCloud Mail) and inline `a[download]` / `data:` / `blob:` links in **any untrusted email** are locked (`data-ped-att-locked`, stashing `href`, `download`, `download_url`, `formaction`, and blocking `click`, `auxclick`, `dblclick`, `mousedown`, `pointerdown`, `dragstart`, `submit`, and `keydown` `Enter`/`Space`), even when body text scores safe or after dismissing the banner. Local filename inspection (`src/attachments.ts`) highlights dangerous smuggling/executable/double-extension patterns without downloading bytes.
- *Residual limit:* Browser-native context-menu `"Save link as…"` or malicious payloads inside benignly named files (`.pdf`) after the user explicitly chooses to trust the email.

### 3. Click-Time Destination Inspector & Race-to-Click Gate
Clicking a link or submitting a form before the 400 ms debounced scan finishes triggers an immediate scan flush (`isPending` gate). Clicking an external `http(s)` link unwraps multi-hop redirectors (Outlook Safe Links, Google, Facebook, YouTube), checks local URL risk signals (`@` authority disguise, IPv4/IPv6 literal, punycode, raw cloud HTML, dangerous file extensions, IP-loggers/Grabify traps like `urlto.me`, URL shorteners, unencrypted `http://`), and queries destination domain intelligence (700 ms timeout; disabled in Strict Local Mode), routing risky clicks to `warning.html` via a 1-hour ephemeral `browser.storage.session` UUID token containing zero sender email addresses.
- *Residual limit:* Server-side multi-hop redirects that occur *after* navigating to an aged, reputable domain (without opt-in `webNavigation` permissions).

### 4. Spoof-Resistant Allowlist
Sender trust (`trustedSenders`) matches exact validated email addresses only (never domains, wildcards, or display names). Whenever webmail exposes an unauthenticated badge or a conflicting non-ESP `via` relay, `canTrustByAllowlist` refuses auto-trust, disables `"Always trust sender"` in the banner, and surfaces a spoofing warning.
- *Residual limit:* Webmail views where authentication metadata is hidden until headers are expanded.

## Third-Party Domain Lookups & HIPAA Strict Local Mode

By default, lookup services learn only the **registrable domain** of opened emails' senders and clicked external link destinations (plus the user's IP address). Mitigations:
- **Strict Local Mode & Enterprise Policy (`src/settings.ts`, `public/managed_schema.json`):** Users can toggle **Strict Local Mode** directly in the popup, or HIPAA/enterprise IT administrators can enforce `strictLocalMode: true` via `browser.storage.managed`, disabling all `domainIntel` `fetch()` calls (0 bytes off-device) across content, click-guard, warning, and background scripts.
- Strict `isValidDomain` validation before constructing any request URL; `https:`-only registry RDAP bootstrap validation (`Object.create(null)` map + hostname verification).
- `credentials: 'omit'` and `referrerPolicy: 'no-referrer'` on every `fetch`.
- Private-use and special-use TLDs (`.local`, `.lan`, `.corp`, `.internal`, `.home`, ...) are never looked up (`isLookupDomain`), so intranet host names are not disclosed.
- *Residual limit:* DNS-over-HTTPS queries for a sender's domain reach that domain's authoritative name servers, so a sender who runs its own DNS can infer that (and roughly when) the email was opened, even when remote content is blocked. The user's IP is not exposed (the resolver asks on its behalf). Strict Local Mode removes the signal.
- 24-hour local cache (`domainIntelCache`), DNS `NOERROR`/`NXDOMAIN` RCODE verification (ignoring transient `SERVFAIL` errors), and `127.0.0.x` URIBL response validation.
- Hardened local report redaction (`feedback.ts` strips emails, full URLs, IP literals, and domain names to `[address]`/`[url]`/`[ip]`/`[domain]`) and zero sender addresses stored inside `warn:*` session warnings (minimum-necessary principle).

## Permissions, Messaging & UI Isolation

- **Minimal install permissions:** Only `storage` and the explicit active webmail match patterns in `extension/src/hosts.ts` (Gmail, Outlook Web including `outlook.cloud.microsoft`, Yahoo Mail, Proton Mail, and scoped iCloud Mail frames `www.icloud.com/mail/*`, `www.icloud.com/applications/mail2/*`, and `*.icloud-sandbox.com/applications/mail2-message/*`). No `<all_urls>`, no `tabs` host access, zero `web_accessible_resources`, and zero runtime npm dependencies.
- **Native attachment blocking on all 5 supported providers:** Works across Gmail shelves, Outlook Aria attachment wells/cards, iCloud mail2 attachment bars, Yahoo attachment tiles, Proton attachment lists, and inline download/data/blob anchors.
- **Sender-verified messaging:** `background.ts` verifies `sender.id` and `isSupportedWebmailUrl(sender.url)` (plus top-frame / iCloud `app`-frame checks on `verdict` and `sandbox`-frame checks on `icloudBody`), never using `window.postMessage`.
- **Closed Shadow DOM & strict CSP:** `#ped-banner-host` and `#ped-toast-host` use `attachShadow({ mode: 'closed' })` with `:host { all: initial !important }` mounted on `document.documentElement`, constructed strictly via `textContent` / `createElementNS`. Extension pages enforce `script-src 'self'; object-src 'none'; base-uri 'none';`.

## Remaining Roadmap Hardening

- Time-split evasion benchmarks (`T9`) and SHA-256 hash verification of the exported JSON ML model (`T5–T6`).
