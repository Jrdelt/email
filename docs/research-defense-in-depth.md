# Defense-in-Depth Research

This document collects the research behind Phishing Email Detector's design: primary studies, browser platform documentation (Chrome Manifest V3 and MDN Web Docs) and an audit of the early codebase. It covers four areas: protecting users even after they click, catching modern phishing, keeping warnings clear and low-fatigue, and hardening the extension itself.

> [!NOTE]
> **Status:** All Tier 1 items in [Section 6](#6-prioritized-implementation-matrix) have shipped: hardened link, form and attachment locking; DOM-clobbering resistance; the 400 ms race-to-click gate; the click-time destination check with the `warning.html` page and recovery guide; Shadow DOM style isolation; the 2-step `danger` unlock; the Undo pill; and the auth-guarded allowlist. T1 parity fixtures have also shipped. Tier 2 and Tier 3 items are partly done or planned. See [threat-model.md](threat-model.md) for the current design.

## 1. Constraints

Every idea here must respect the rules in [AGENTS.md](../AGENTS.md), [privacy.md](privacy.md) and [threat-model.md](threat-model.md):

| Constraint | Current budget or rule | What it means for new protections |
|---|---|---|
| **Privacy** | No email bodies, full URLs or sender addresses leave the browser. Only validated registrable domains are looked up (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, 24 h cache). | Post-click URL checks must run locally or look up only the destination's **registrable domain** (or use privacy-preserving local Bloom filters or hash prefixes). |
| **Performance** | <10 ms scoring per email; ~0 idle CPU; <10 MB memory; <500 KB package (currently ~210 kB); <200 KB model JSON; no ONNX or TF.js. | Avoid heavy work on every DOM change. Keep threat lists compact (for example a Bloom filter or prefix table) and run heavier checks only on real clicks. |
| **Permissions** | Only `storage` plus the webmail sites in `extension/src/hosts.ts` at install time. | Any browser-wide navigation or download protection must use MV3 `optional_permissions` / `optional_host_permissions`, requested **only** if the user opts in. |
| **Precision** | Evaluate at a false-positive rate (FPR) of 0.1% or less to avoid warning fatigue. | Combine weak signals (for example free hosting alone) instead of raising `danger` alerts on single, often-benign patterns. |

## 2. Protection at and after the click

Before the click-time guard shipped, protection stopped at the inbox page: if a scan had not finished, if the scorer missed an attack, or if the user opened a URL by hand, nothing stepped in after the click. Five layers close this gap.

### 2.1 Race-to-click window (shipped)

**Audit finding ([content.ts](../extension/entrypoints/content.ts)):** the scheduler waits `DEBOUNCE_MS = 400` plus an idle callback before scanning, and domain lookups can take up to `TIMEOUT_MS = 5000` per request ([domainIntel.ts](../extension/src/domainIntel.ts)). A fast click in the first ~500 ms, or before a domain warning arrived, reached a still-active link.

**Fix (no extra permissions):** a **pending-scan click gate**. If the user clicks while a scan is pending, the click is held, the scan runs immediately, and the click either continues (if safe) or is blocked with the banner (if flagged).

### 2.2 Click-time destination check and local warning page (shipped, no new permissions)

The content script already listens for `click` and `auxclick` in webmail pages, so it can check a link at the moment it is clicked:

1. Hold the click on an outside link in a message body while it is checked.
2. Run fast local checks: raw IP address, `xn--` punycode, plain `http:`, an `@` that hides the real host (`https://trusted.com@evil.example`), raw cloud-storage HTML (`isCloudHtmlLink`), known URL shorteners, IP loggers, or a risky file extension. Then, if needed, look up the **destination's registrable domain** with the existing `getIntel` code in [background.ts](../extension/entrypoints/background.ts). Only the bare domain is sent (never the path, query or `#fragment`), with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
3. If the destination looks risky (for example registered less than 30 days ago, listed `black` or `red` on URIBL, `NXDOMAIN`, a risky file type or raw cloud HTML), store the link under a random one-time ID in `browser.storage.session` (so the URL never goes into a query string, browser history or a referrer) and open the extension's `warning.html?id=...` page. It shows a clear **"Back to safety (Close tab)"** button and a calm checklist for users who already clicked.

As shipped, the stored entry holds the link, its host and domain, the reasons and any domain details, but no sender address.

### 2.3 Optional post-click browser shield (planned, opt-in)

A link from an email often passes through 2 or 3 redirects (for example a marketing tracker or open redirect, then a fresh phishing domain), or starts an HTML/SVG smuggling download after leaving the webmail tab.

According to Chrome's Manifest V3 documentation (`developer.chrome.com`):

- Putting `<all_urls>` or `https://*/*` in `host_permissions` shows an alarming install warning ("Read and change all your data on all websites"), which breaks the minimal-permission rule in [AGENTS.md](../AGENTS.md).
- MV3 also supports **`optional_permissions`** (`webNavigation`, `downloads`) and **`optional_host_permissions`** (`https://*/*`, `http://*/*`). These show **no warning at install time** and are requested with `chrome.permissions.request()` only if the user turns on an opt-in setting such as an "Extended Post-Click Shield".
- **`declarativeNetRequest`** can block requests by rule without host permissions and without broad data-access warnings (redirecting or changing headers does need host permissions).

Possible opt-in features:

1. **Watch only tabs opened from webmail** (`webNavigation.onCreatedNavigationTarget` and `onCommitted`, using `sourceTabId`) for a short time (for example 30 seconds). If a redirect lands on an `NXDOMAIN`, newly registered, URIBL-listed or blocklisted domain, close the tab or send it to `warning.html` before the user can type into a login form.
2. **Download guard** (`downloads.onCreated`): when a download from a webmail click or an email-opened tab has a risky smuggling extension (`.svg`, `.html`, `.htm`, `.iso`, `.lnk`, `.vbs`, `.scr`, `.exe`, or an unexpected `.dmg`), pause it (`browser.downloads.pause`) and explain HTML/SVG smuggling before continuing.

### 2.4 Privacy-preserving threat lists (planned)

Checking clicked domains against phishing feeds must not leak browsing history or break the 500 KB package budget.

| Approach | Privacy | Freshness | Size and speed | Fit for this extension |
|---|---|---|---|---|
| **Domain-only RDAP/DNS/URIBL** (built) | Only the registrable domain and the user's IP are sent (`credentials: 'omit'`). | Real time (24 h cache). | ~0 KB; 100–800 ms at click time. | **Current baseline**, documented in [privacy.md](privacy.md). |
| **Compact local domain Bloom filter** | **No network queries** for safe or unknown domains; no URLs sent. | Depends on how often the list (for example OpenPhish or URLhaus domains) is rebuilt. | ~50–150 KB for 50k–100k domains at <0.1% false positives; <0.05 ms per check. | **Strong Tier 2 option**, if Bloom filter hits are confirmed by a domain lookup so the FPR stays at or below 0.1%. |
| **Google Safe Browsing API v5 with Oblivious HTTP (OHTTP)** | Sends only 4-byte SHA-256 hash prefixes through an OHTTP relay, so neither the IP nor the full URL is revealed; uses a local Global Cache first. | Real time. | Needs an API key and an OHTTP relay server. | **Out of scope** for a serverless extension, unless a project-run OHTTP relay is added (which would require updating [privacy.md](privacy.md)). |

### 2.5 "I clicked by mistake" recovery steps (shipped)

The `warning.html` page and the popup's **"Clicked a suspicious link?"** button give calm, ordered steps instead of alarm:

1. **Only clicked, nothing typed or downloaded?** Close the page. Simply clicking a link in a modern browser rarely compromises an account on its own.
2. **Typed a password, 2FA code or payment card?** Change that password from the real website (type the address yourself), turn on 2FA or passkeys, and sign out of active sessions.
3. **A file downloaded (`.html`, `.svg`, `.zip`, `.dmg`, `.exe`)?** Do not open it. Delete it from Downloads and empty the Trash.

## 3. Catching modern phishing (2025–2026 evasion techniques)

Modern phishing avoids simple keyword and domain checks with techniques documented by CISA, NIST and industry threat reports.

### 3.1 Living off trusted sites (LOTS) and redirect abuse

Attackers host phishing pages and redirectors on legitimate cloud and SaaS platforms whose root domains have clean reputations:

- **Raw object-storage HTML** (shipped): S3, GCS, Azure Blob, Firebase Storage, R2, IPFS, Backblaze and DigitalOcean Spaces.
- **Free static hosting and serverless endpoints** (planned): `*.web.app`, `*.firebaseapp.com`, `*.pages.dev`, `*.workers.dev`, `*.netlify.app`, `*.vercel.app`, `*.github.io`, `*.glitch.me`, `*.trycloudflare.com`, `*.ngrok-free.app`.
  - *Precision rule:* real companies sometimes send `github.io` docs or `vercel.app` previews, so **never flag static hosts alone as `danger`**. Give them a weak score (for example +0.15 to +0.2, only together with urgency, brand claims or login wording) so the FPR stays at or below 0.1%.
- **Open redirects and tracking wrappers:** unwrap them locally before checking. Outlook Safe Links, `google.com/url?q=`, `l.facebook.com/l.php?u=` and YouTube redirects are unwrapped at click time (shipped). Others such as `urldefense.proofpoint.com` are not yet handled.
- **URL shorteners** (shipped): treated as a moderate hiding signal, because real security alerts from banks, Google or Apple rarely use public shorteners (for example `bit.ly`, `tinyurl.com`, `t.co`, `rebrand.ly`, `rb.gy`, `cutt.ly`, `shorturl.at`, `is.gd`, `ow.ly`).

### 3.2 QR-code phishing ("quishing") and image-only emails (planned)

Attackers increasingly put the phishing URL only in a QR code image, or turn the whole email into images, so there are no `<a>` tags to find:

- **QR scanning with the built-in `BarcodeDetector`:** MDN Web Docs documents `BarcodeDetector({ formats: ['qr_code'] })`, available in secure contexts in Chromium, with no bundle cost.
  - *Cautions:* only run it when an email has images and few or no text links; limit it to the first few reasonably sized images (for example 5 images of at least 80×80); and run it after the main scan so the <10 ms scoring budget holds. Cross-origin images served without CORS headers may not be readable.
- **Image-heavy, low-text check:** emails with fewer than 80 characters of visible text, at least one large clickable image or `<map>`/`<area>`, and urgent wording in the subject or `alt` text could get a score boost (+0.2). `img[alt]` text could also be included in link-text mismatch checks.

### 3.3 Header, relay and structure signals

Seen in a real Gmail sample and in 2025–2026 campaigns:

- **Gmail `via` relay mismatch** (shipped): Gmail shows `via <relay-domain>` next to the sender. When the relay's domain differs from the `From` domain and looks suspicious (deep subdomains such as `442.320397.jnc7.one.bss0019.narodaro.my.id`, numeric labels, lookalike characters or freemail), the extension warns that the mail came through a suspicious relay.
- **Whole-card clickable wrappers** (planned): real newsletters rarely wrap a whole multi-paragraph card in one giant `<a>`. An `<a>` that contains more than 150 characters or several block elements (`div`, `p`, `table`) is a strong structural signal.
- **Fake trust labels in the body** (planned): text like "This message was sent from a trusted sender." or fake `[Verified]` / "Passed security scan" labels inside the message are classic social-engineering tricks.
- **Hidden `<form>` and `formaction` URLs** (shipped): `<form action>` and `[formaction]` targets are extracted as links so the scorer checks them the same way as `<a href>`.

### 3.4 Replacing hand-set weights with a calibrated local model (Roadmap T1 to T6)

Fixed weights (+0.3, +0.4) have fixed trade-offs. The [roadmap](ROADMAP.md) addresses this:

- **T1 parity fixtures** (shipped) guarantee identical features in Python (`ml/src/phishml/features.py`) and TypeScript (`extension/src/features.ts`).
- **T3/T4 time-split training and evaluation** train calibrated models (logistic regression first, then shallow gradient-boosted trees with hashed text features, under 200 KB of JSON), evaluated at **an FPR of 0.1% or less** on later, held-out emails.
- **T8 explainability** turns the top feature contributions into plain-English banner reasons.

## 4. Usable security

Usable-security research gives concrete lessons on why people ignore warnings:

- **Akhawe and Felt (USENIX Security 2013, "Alice in Warningland")** studied millions of real Chrome and Firefox warning impressions. Roughly 25–33% of browser phishing and malware warnings were clicked through, and users mostly ignored secondary "Advanced" or "Learn more" links. Lessons:
  1. **Put the key reason on the main surface**, not behind a toggle.
  2. **Fight warning fatigue:** keep clean mail silent and save red `danger` styling for high-confidence threats.
  3. **Use opinionated design:** make the safe choice the obvious one, and make bypassing a dangerous alert take deliberate effort.
- **NIST Technical Note 2276 (the NIST Phish Scale)** shows that how likely people are to fall for an email depends heavily on **premise alignment** (how well the story fits what the user expects, such as "storage full", a delivery notice or a password alert) as well as **observable cues**. Pointing out the **exact mismatch** between the story and the cue is what breaks the illusion.

UX changes made in response (all shipped):

1. **More friction for risky bypasses:** `warning` alerts unlock in one click ("I trust this email"); `danger` alerts need a second confirmation ("Yes, unlock links anyway"), while the safe choice stays prominent.
2. **Side-by-side cue on the main card:** the real `From:` address shown next to `Links go to:` with the link destination domains (and any attachment names).
3. **Feedback when a paused link is clicked:** a small toast explains that the link was paused and names its destination. Before this, a locked link silently did nothing, and users often assumed the page was broken and clicked "I trust this email" just to make it work.
4. **Undo after trusting:** an "Email trusted" pill with an **Undo** button removes the fingerprint from `trustedEmails` and re-locks the links.

## 5. Hardening the extension itself

A security extension that runs inside hostile webmail pages and parses untrusted HTML must resist attacks on its own locks, UI, allowlist and model.

### 5.1 Audit: bypasses found and fixed

| File | Before | Bypass found | Fix shipped |
|---|---|---|---|
| [linkLock.ts](../extension/src/ui/linkLock.ts) and [extract.ts](../extension/src/adapters/extract.ts) | Locked `href` on `a`/`area` and `action` on `form`. | 1. **`formaction` override:** per MDN and the HTML spec, `<button formaction="...">` overrides `<form action>`, and `extract.ts` did not extract `formaction` URLs. 2. **SVG `xlink:href` and `<a ping>`:** SVG 1.1 links are missed by `a[href]`; `ping` sends a background POST on click. 3. **Keyboard:** `Enter`/`Space` on focused controls was not always caught. 4. **Timing gap:** links added between debounced scans stayed active. | Set aside and restore `formaction`, `xlink:href` and `ping`; extract `form[action]`, `[formaction]` and SVG links; block `Enter`/`Space`; re-lock immediately when the DOM changes inside a locked container. |
| [banner.ts](../extension/src/ui/banner.ts) | Closed shadow root, mounted in `document.body`. | **Style leakage and removal:** without `:host { all: initial !important }`, inherited page styles leak into the Shadow DOM (per MDN), and webmail re-renders of `body` could remove the banner. | Added `:host { all: initial !important; ... }` and mounted the banner on `document.documentElement`. |
| [allowlist.ts](../extension/src/allowlist.ts) and [content.ts](../extension/entrypoints/content.ts) | A trusted sender address skipped scanning. | **Allowlist spoofing:** a forged `From` sent through an unauthenticated server (Gmail shows a `via` relay or an unverified badge) could skip scanning and unlock links. | Adapters extract the unauthenticated and `via` signals (`gmail.ts`), and trusted senders are never honored (and a warning is shown) when authentication or the relay conflicts with the claimed sender. |
| [content.ts](../extension/entrypoints/content.ts) and [gmail.ts](../extension/src/adapters/gmail.ts) | Scanned subject, body text and links. | **Hidden or spoofed headers:** iCloud Mail shows only the display name until "Details" is expanded; an email could copy Gmail's sender CSS classes inside the body. | Keep strict `!container.contains(el)` checks in every adapter. Optionally, add an iCloud tip when no sender address is visible. |

### 5.2 Manifest, CSP and model integrity ([wxt.config.ts](../extension/wxt.config.ts))

- **Strict Content Security Policy** (shipped): `extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'"`, so extension pages (`popup.html`, `warning.html`) block inline scripts, `eval` and outside scripts.
- **Zero runtime dependencies** (shipped): `extension/package.json` has only development dependencies, which removes npm supply-chain risk from the shipped bundle.
- **SHA-256 check of the bundled model** (planned, T5/T6): verify `extension/public/model.json` against `model.sha256` before use, and fall back to the rules on a mismatch.

## 6. Prioritized implementation matrix

| Priority | Improvement | Status | Security / UX impact | New permissions? | Privacy impact | Size / speed | Files |
|---|---|---|---|---|---|---|---|
| **Tier 1** | **Harden `linkLock.ts` and `extract.ts`** (`formaction`, `xlink:href`, `ping`, `keydown`, instant re-lock) | **Done** | Closes known HTML/SVG/`formaction` lock bypasses | None | None | <0.5 KB, ~0 ms | [linkLock.ts](../extension/src/ui/linkLock.ts), [extract.ts](../extension/src/adapters/extract.ts) |
| **Tier 1** | **Click-time destination check and local `warning.html` page** (with the "clicked a bad link" checklist) | **Done** | Protects the user **at the click**, before leaving webmail | None | Domain only (`getIntel`); URL kept only in `storage.session` | ~4–6 KB, runs only on click | `extension/entrypoints/warning/`, [content.ts](../extension/entrypoints/content.ts), [linkLock.ts](../extension/src/ui/linkLock.ts) |
| **Tier 1** | **400 ms race-to-click gate and paused-link toast** | **Done** | Stops fast clicks before the scan finishes; stops users clicking "Trust" just to make a link work | None | None | ~1 KB, ~0 ms | [content.ts](../extension/entrypoints/content.ts), [linkLock.ts](../extension/src/ui/linkLock.ts), [linkToast.ts](../extension/src/ui/linkToast.ts), [banner.ts](../extension/src/ui/banner.ts) |
| **Tier 1** | **Banner style isolation, 2-step `danger` unlock and Undo pill** | **Done** | Prevents page CSS breakage; reduces habituation (Akhawe and Felt) | None | None | ~1.5 KB, ~0 ms | [banner.ts](../extension/src/ui/banner.ts) |
| **Tier 2** | **LOTS static hosts, shorteners, whole-card `<a>`, redirect unwrapping, `via` relay mismatch and allowlist auth guard** | **Partial** (`via` mismatch, allowlist guard, shorteners and click-time redirect unwrapping shipped; LOTS static hosts and whole-card `<a>` remain) | Catches LOTS kits, shorteners, `via` spoofs and allowlist spoofing | None | None (needs a parity update in `features.py`) | ~1.5 KB, <0.2 ms | [features.ts](../extension/src/features.ts), [features.py](../ml/src/phishml/features.py), [gmail.ts](../extension/src/adapters/gmail.ts), [sender.ts](../extension/src/sender.ts), [linkGuard.ts](../extension/src/linkGuard.ts) |
| **Tier 2** | **Roadmap T2–T6 and T8** (time-split model under 200 KB, explainable reasons) | **Planned** (T1 parity done) | Calibrated scoring at an FPR of 0.1% or less instead of hand-set weights | None | Local-only inference with SHA-256 check | <200 KB JSON, <5 ms | `ml/src/phishml/*`, `extension/src/model.ts`, `docs/results.md` |
| **Tier 3** | **Local Bloom filter and opt-in post-click shield** (`optional_permissions`: `webNavigation`, `downloads`) | **Planned** | Catches redirect chains and smuggling downloads outside webmail | **Opt-in only** (no install warnings) | No queries on Bloom misses; user opts in | ~60–150 KB list | [wxt.config.ts](../extension/wxt.config.ts), [background.ts](../extension/entrypoints/background.ts), [popup/main.ts](../extension/entrypoints/popup/main.ts) |
| **Tier 3** | **QR-code ("quishing") detection with `BarcodeDetector`** | **Planned** | Decodes QR phishing images locally with no bundle cost | None (CORS caveat) | Fully local | ~1 KB, async, image-heavy mail only | `extension/src/qr.ts` (new), [content.ts](../extension/entrypoints/content.ts) |

## 7. Primary sources cited

1. **Chrome for Developers — Manifest V3 Permissions & `optional_host_permissions`:** [https://developer.chrome.com/docs/extensions/reference/api/permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) and [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) (install-time warning minimization via `optional_permissions` / `optional_host_permissions`).
2. **Chrome for Developers — `declarativeNetRequest` API:** [https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) (blocking vs. redirecting host-permission requirements).
3. **Chrome for Developers — `webNavigation` & `downloads` APIs:** [https://developer.chrome.com/docs/extensions/reference/api/webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) and [https://developer.chrome.com/docs/extensions/reference/api/downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads).
4. **Google Safe Browsing API v5 & Oblivious HTTP (OHTTP) Documentation:** [https://developers.google.com/safe-browsing/v5](https://developers.google.com/safe-browsing/v5) (hash-prefix protocol, local Global Cache, and OHTTP privacy relay).
5. **MDN Web Docs — HTML `<button formaction>`, SVG `href`/`xlink:href`, Shadow DOM Encapsulation, and `BarcodeDetector` API:** [https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#formaction](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#formaction), [https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/xlink:href](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/xlink:href), [https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM), and [https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector).
6. **Akhawe, D., & Felt, A. P. (2013) — *"Alice in Warningland: A Large-Scale Field Study of Browser Security Warning Effectiveness"*:** USENIX Security Symposium 2013 ([https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/akhawe](https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/akhawe)) — empirical measurement of warning click-through rates, habituation, and opinionated warning UI design.
7. **NIST Technical Note 2276 (2023) — *NIST Phish Scale*:** National Institute of Standards and Technology ([https://csrc.nist.gov/pubs/tn/2276/final](https://csrc.nist.gov/pubs/tn/2276/final)) — observable cues vs. premise alignment in human phishing detection.
8. **CISA — HTML/SVG Smuggling & Phishing Delivery Advisories:** Cybersecurity and Infrastructure Security Agency ([https://www.cisa.gov/](https://www.cisa.gov/)).
