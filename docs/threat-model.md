# Threat model (draft)

**Goal:** warn users about likely phishing emails with a low false-positive rate.

**Assets:** user trust, user mailbox content (never exfiltrated).

**Attacker capabilities:** crafts emails to evade the scorer (homoglyph domains, link text/href mismatch,
image-only bodies, hosting on legitimate platforms).

**Third-party lookups:** the lookup services learn which sender domains the user receives mail from (plus the
user's IP). Accepted for v1 (always on, by product decision). Mitigations: domain only, 24 h cache, no cookies or
referrer, strict domain validation before building any URL. URIBL limits public resolvers, so "lookup refused" is
common and is shown as such, never as "clean".

**Out of scope (v1):** attachments, native mail clients, server-side filtering.

**Host permissions:** limited strictly to webmail origins in `extension/src/hosts.ts` (Gmail, Outlook Web including `outlook.cloud.microsoft`, Yahoo, Proton, and iCloud Mail). No `<all_urls>` permission is requested. For iCloud Mail, host permissions and `all_frames: true` content-script injection are additionally scoped to its two internal mail frames — `https://www.icloud.com/applications/mail2/*` (header/UI iframe) and `https://*.icloud-sandbox.com/applications/mail2-message/*` (cross-origin message-body iframe) — excluding non-mail iCloud apps (such as Photos or Drive). Cross-frame coordination between those two frames uses isolated extension messaging relayed statelessly by the background script (verified against `sender.url`, never `window.postMessage`, and storing no email content).

**Link locking limits:** flagged emails have links (`a`, `area`), embedded image links (`<a><img></a>`), and `<form>` submissions paused by stashing `href`/`action` attributes (`data-ped-href`, `data-ped-action`) and intercepting `click`, `auxclick`, `dragstart`, and `submit` in capture phase. This blocks left/middle clicks, keyboard activation, drag-and-drop, form submissions, and right-click "Open link in new tab" until the user unlocks the email or trusts the sender. Remaining limitation: manually copying and pasting plain-text URLs from the message body.

**Allowlist abuse:** an attacker who spoofs a trusted sender's address bypasses scanning. Mitigation (future):
only honor the allowlist when the display address is unambiguous and, where available, authentication passes.

TODO: evasion test results, model integrity (hash-pinned model file), permission justification.
