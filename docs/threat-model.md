# Threat model (draft)

**Goal:** warn users about likely phishing emails with a low false-positive rate.

**Assets:** user trust, user mailbox content (never exfiltrated).

**Attacker capabilities:** crafts emails to evade the scorer (homoglyph domains, link text/href mismatch,
image-only bodies, hosting on legitimate platforms).

**Third-party lookups:** the lookup services learn which sender domains the user receives mail from and which external link destination domains the user clicks inside webmail (plus the user's IP). Accepted for v1 (always on, by product decision). Mitigations: registrable domain only (never URL paths, query strings, `#fragment`, or email addresses/bodies), 24 h cache, `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, strict domain validation before building any URL. URIBL limits public resolvers, so "lookup refused" is common and is shown as such, never as "clean".

**Out of scope (v1):** attachments, native mail clients, server-side filtering.

**Host permissions:** limited strictly to webmail origins in `extension/src/hosts.ts` (Gmail, Outlook Web including `outlook.cloud.microsoft`, Yahoo, Proton, and iCloud Mail). No `<all_urls>` permission is requested. For iCloud Mail, host permissions and `all_frames: true` content-script injection are additionally scoped to its two internal mail frames — `https://www.icloud.com/applications/mail2/*` (header/UI iframe) and `https://*.icloud-sandbox.com/applications/mail2-message/*` (cross-origin message-body iframe) — excluding non-mail iCloud apps (such as Photos or Drive). Cross-frame coordination between those two frames uses isolated extension messaging relayed statelessly by the background script (verified against `sender.url`, never `window.postMessage`, and storing no email content).

**Link locking limits:** flagged emails have links (`a`, `area`, SVG `xlink:href`), `<a ping>` beacons, embedded image links (`<a><img></a>`), `<form>` submissions, and `[formaction]` overrides paused by stashing attributes (`data-ped-href`, `data-ped-xlink-href`, `data-ped-ping`, `data-ped-action`, `data-ped-formaction`) and intercepting `click`, `auxclick`, `dragstart`, `submit`, and `keydown` (`Enter`/`Space`) in capture phase — with automatic re-locking of dynamically added DOM nodes inside locked containers. Remaining limitation: manually copying and pasting plain-text URLs from the message body.

**Allowlist abuse:** an attacker who spoofs a trusted sender's address without passing authentication cannot bypass scanning when webmail flags unverified senders or a conflicting non-ESP `via` relay (`canTrustByAllowlist` refuses auto-trust and adds a warning). Remaining limitation: webmail views that strip header authentication cues altogether (e.g., collapsed headers).

**Click-time destination inspector & race-to-click gate:** clicking any link inside a scanned email before the 400 ms scan completes triggers an immediate scan flush (`isPending` gate). Clicking an external `http(s)` link in any email also inspects the unwrapped destination locally (`@` disguise, IP, punycode, raw cloud HTML, risky file extension, URL shortener, plain `http://`) and queries the destination's registrable domain (`domainIntel`, 700 ms timeout), routing risky links to the local `warning.html` interstitial via an ephemeral random `browser.storage.session` token (no URLs in query strings/history; strictly `isSafeHttpUrl`-validated before navigation). Remaining limitation: multi-hop redirects on an initially clean domain after leaving webmail without opt-in navigation permissions.

**UI isolation & CSP:** the in-page warning banner (`#ped-banner-host`) and paused-link toast (`#ped-toast-host`) use closed Shadow DOM roots (`attachShadow({ mode: 'closed' })`) with `:host { all: initial !important; ... }` mounted directly on `document.documentElement` so webmail CSS and SPA re-renders of `document.body` cannot restyle or strip them. All DOM nodes are built with `textContent` (never `innerHTML`). Extension pages (`popup.html`, `warning.html`) enforce strict MV3 CSP (`script-src 'self'; object-src 'none'; base-uri 'none';`), define zero `web_accessible_resources`, and ship with zero runtime npm dependencies.

TODO: evasion test results, model integrity (hash-pinned model file), permission justification.
