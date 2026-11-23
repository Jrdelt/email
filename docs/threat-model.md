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

**Host permissions:** limited strictly to webmail origins in `extension/src/hosts.ts` (Gmail, Outlook Web including `outlook.cloud.microsoft`, Yahoo, Proton, iCloud). No `<all_urls>` permission is requested.

**Link locking limits:** flagged emails have their links disabled through one capturing click/auxclick/dragstart
listener. It cannot block the browser's native right-click "Open link in new tab" or copying the link address.
The banner says links are disabled; it does not claim they are impossible to open.

**Allowlist abuse:** an attacker who spoofs a trusted sender's address bypasses scanning. Mitigation (future):
only honor the allowlist when the display address is unambiguous and, where available, authentication passes.

TODO: evasion test results, model integrity (hash-pinned model file), permission justification.
