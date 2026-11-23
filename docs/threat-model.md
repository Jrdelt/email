# Threat model (draft)

**Goal:** warn users about likely phishing emails with a low false-positive rate.

**Assets:** user trust, user mailbox content (never exfiltrated).

**Attacker capabilities:** crafts emails to evade the scorer (homoglyph domains, link text/href mismatch,
image-only bodies, hosting on legitimate platforms).

**Out of scope (v1):** attachments, native mail clients, server-side filtering.

TODO: evasion test results, model integrity (hash-pinned model file), permission justification.
