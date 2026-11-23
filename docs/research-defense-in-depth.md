# Defense-in-Depth Research: Effectiveness, Usable Security, Post-Click Protection, and Extension Hardening

This document synthesizes primary research, browser platform specifications (Chrome Manifest V3 and MDN Web Docs), and a line-by-line audit of the current codebase to outline how **Phishing Email Detector** can catch more real-world phishing, become clearer and less fatiguing for everyday users, stay resilient against bypasses, and protect the user **even if they click a malicious link**.

---

## 1. Executive Summary & Architectural Constraints

Every recommendation below must respect the hard guarantees established in [AGENTS.md](file:///Users/cesardeltoro-lemire/email-detection/AGENTS.md), [docs/privacy.md](file:///Users/cesardeltoro-lemire/email-detection/docs/privacy.md), and [docs/threat-model.md](file:///Users/cesardeltoro-lemire/email-detection/docs/threat-model.md):

| Constraint | Current Budget / Rule | Implication for New Protections |
|---|---|---|
| **Privacy** | Zero email bodies, full URLs, or sender email addresses leave the browser. Only validated registrable domains are queried (`credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, 24 h cache). | Post-click URL checks must either run locally or query only the destination **registrable domain** (or privacy-preserving local Bloom filters / hash prefixes). |
| **Performance** | `<10 ms` scoring per email; `~0` idle CPU; `<10 MB` RAM; `<500 KB` total package (currently `120.48 kB`); `<200 KB` model JSON; no ONNX/TF.js. | Avoid synchronous image decoding loops on every DOM mutation; keep threat lists compact (e.g., compact Bloom filter or prefix table) and run heavy click-time checks only on actual user clicks. |
| **Permissions** | Only `storage` + `WEBMAIL_MATCHES` in `extension/src/hosts.ts` at install time. | Any browser-wide navigation or download shield beyond webmail tabs must use MV3 `optional_permissions` / `optional_host_permissions` requested **only** if the user opts in. |
| **Precision** | Evaluate at `<=0.1%` false-positive rate (FPR) to avoid warning fatigue. | Compound weak signals (e.g., free hosting alone) rather than triggering `danger` alerts on single benign patterns. |

---

## 2. Pillar 1 — Click-Time & Post-Click Protection ("What if a user clicks a malicious link?")

Right now, protection ends at the inbox DOM: if a scan hasn't finished yet, if an attacker evades the pre-click email scorer, or if the user manually opens/pastes a URL, nothing intervenes after the click. Defense-in-depth closes this gap in five layers.

### 2.1 Eliminate the 400 ms–5 s Race-to-Click Window
**Codebase audit ([content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts)):**
- `createScheduler` waits `DEBOUNCE_MS = 400` plus an indeterminate `requestIdleCallback` delay before `scan()` even starts.
- After extraction, `evaluateAndRender` awaits `listTrusted` + `listTrustedEmails` + `hashEmail`, and then sends an asynchronous `domainIntel` lookup (`TIMEOUT_MS = 5000` per request in [domainIntel.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/domainIntel.ts)).
- If a fast user clicks a link in an email within the first ~500 ms after opening it — or before an async `domainIntel` warning arrives — the link is still active.

**Fix (zero extra permissions):**
- Install an ultra-lightweight **pending-scan click gate** on extracted message containers while a scan is in flight (or before the first `render()` finishes): if a user clicks a link during those ~400 ms, call `e.preventDefault()`, flush the scan immediately (`await scan()`), and either let the click proceed (if safe) or block and show the warning banner (if flagged).

### 2.2 Click-Time Destination Inspector + Local Interstitial (`warning.html`, Zero New Permissions)
Even when an email passed initial inspection (e.g., benign-looking prose linking to an unflagged host, a URL shortener, or a file download), the content script already has a capture-phase `click` / `auxclick` listener inside webmail pages.

**How it works without new permissions:**
1. On click of any link inside a webmail message body whose destination is not obviously the sender's own clean website (or matches high-risk heuristics), pause default navigation (`e.preventDefault()`).
2. Run a synchronous + cached **click-time destination check**:
   - **Local URL risk checks:** IP literal, `xn--` punycode, HTTP (non-HTTPS), `@` credential-masking authority (`https://trusted.com@evil.example`), cloud-storage HTML (`isCloudHtmlLink`), known URL shorteners (`bit.ly`, `tinyurl.com`, `t.co`, `rebrand.ly`, `rb.gy`, `cutt.ly`, `is.gd`), or dangerous file download extensions (`.html`, `.htm`, `.svg`, `.exe`, `.dmg`, `.pkg`, `.msi`, `.zip`, `.iso`, `.lnk`, `.apk`, `.ps1`, `.bat`, `.vbs`, `.scr`).
   - **Destination-domain intel lookup (privacy-safe):** reuse existing `domainIntel` (`getIntel`) in [background.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/background.ts) on the **destination URL's registrable domain** (`registrableDomain(hostOf(href))`). Only the bare domain is queried (never the URL path, query string, or `#fragment`), using existing `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`.
3. If either the email was flagged **or** the destination domain has high-risk signals (brand-new `<30d` registration, URIBL `black`/`red` listing, `NXDOMAIN`, no MX/unregistered, dangerous attachment extension, raw cloud HTML):
   - Store `{ href, reasons, sender, domainIntel }` under a random one-time ID in `browser.storage.session` (never passing the raw phishing URL in a query parameter so it never enters browser history or leaks via referrers).
   - Open an extension interstitial page (`browser.runtime.getURL('warning.html?id=...')`).
   - Show an opinionated **Warning / Safety Card** (Section 4) with a prominent **"Back to Safety (Close Tab)"** button and a calm **"If you already clicked / entered info"** checklist.

### 2.3 Opt-In Post-Click Browser Shield (`optional_permissions` & `declarativeNetRequest`)
A link clicked from email often redirects through 2–3 hops (e.g., legitimate marketing tracker or open redirect → fresh phishing domain), or triggers a drive-by SVG/HTML-smuggling download after leaving the webmail tab.

According to Chrome's Manifest V3 documentation (`developer.chrome.com`):
- Putting `<all_urls>` or `https://*/*` in `host_permissions` forces an alarming install-time warning (*"Read and change all your data on all websites"*), violating [AGENTS.md](file:///Users/cesardeltoro-lemire/email-detection/AGENTS.md) minimal-permission principles.
- However, MV3 supports **`optional_permissions`** (`webNavigation`, `downloads`) and **`optional_host_permissions`** (`https://*/*`, `http://*/*`), which **show zero warnings at install time** and are only prompted via `chrome.permissions.request()` if the user explicitly turns on an opt-in **"Extended Post-Click Shield"** toggle in the popup.
- Furthermore, **`declarativeNetRequest`** without host permissions allows blocking requests by rule without triggering broad data-access warnings (whereas redirecting/modifying headers requires host permissions).

**Optional post-click capabilities (strictly opt-in):**
1. **`webNavigation.onCreatedNavigationTarget` + `onCommitted` scoped to email-spawned tabs:** Track only `tabId`s opened directly from a supported webmail tab (`sourceTabId` in webmail tabs) for a brief hop window (e.g., 30 seconds or until settled). If any redirect hop lands on a `NXDOMAIN` / `<30d` / URIBL-listed / blocklisted domain, close or redirect the tab to `warning.html` before the user interacts with the credential form.
2. **Download guard (`downloads.onCreated`):** When a download originates from a webmail click or an email-spawned tab with a high-risk smuggling extension (`.svg`, `.html`, `.htm`, `.iso`, `.lnk`, `.vbs`, `.scr`, `.exe`, `.dmg` when not expected), pause it (`browser.downloads.pause`) and surface a clear confirmation prompt explaining HTML/SVG smuggling risks.

### 2.4 Privacy-Preserving Threat Lists: Local Bloom Filter vs. Safe Browsing v5 Hash-Prefix + OHTTP
Checking clicked domains against known phishing feeds shouldn't leak user browsing history or blow the `<500 KB` package budget.

| Approach | Privacy | Freshness | Bundle / Latency | Fit for This Extension |
|---|---|---|---|---|
| **Domain-only RDAP/DNS/URIBL** *(already built)* | Only registrable domain + user IP sent (`credentials: 'omit'`). | Real-time (24 h cache). | `~0 KB` bundle; `100–800 ms` click-time check. | **Core baseline** — already implemented and documented in [docs/privacy.md](file:///Users/cesardeltoro-lemire/email-detection/docs/privacy.md). |
| **Compact Static/Cached Domain Bloom Filter** | **Zero network queries** for safe/unknown misses; 0 URLs sent anywhere. | Depends on build/feed refresh cadence (e.g., OpenPhish/URLhaus domains). | `~50–150 KB` for 50k–100k domains at `<0.1%` FP rate; `<0.05 ms` check. | **Strong Tier 2 upgrade** if a clean verification fallback (domainIntel check) confirms probabilistic Bloom hits so FP rate stays `<=0.1%`. |
| **Google Safe Browsing API v5 + Oblivious HTTP (OHTTP)** | Sends only 4-byte SHA-256 hash prefixes via an OHTTP relay so neither IP nor full URL is revealed; leverages a benign Global Cache before real-time lookup. | Real-time. | Requires API key + OHTTP relay backend infrastructure. | **Out of scope for standalone zero-server extension** unless a project-operated OHTTP proxy is ever introduced (would require updating `docs/privacy.md`). |

### 2.5 Guided "I Clicked by Mistake" Remediation Flow
When a user lands on `warning.html` or clicks a new **"I clicked a suspicious link"** help action inside the banner/popup, avoid panic and give concrete, ordered steps:
1. **Did you just click the link, without typing or downloading anything?** → *"Close the page now. Simply clicking a link in a modern browser rarely compromises an account on its own."*
2. **Did you enter a password, 2FA code, or payment card?** → *"Change that account's password immediately from the real website (type the address yourself), turn on 2FA / passkeys, and sign out of all active sessions."*
3. **Did a file download (`.html`, `.svg`, `.zip`, `.dmg`, `.exe`)?** → *"Do not open it. Delete it from your Downloads folder and empty the Trash."*

---

## 3. Pillar 2 — Detection Effectiveness (2025–2026 Phishing Evasion Techniques)

Modern phishing bypasses simple keyword and domain checks using techniques documented by CISA, NIST, and industry threat telemetry:

### 3.1 Living off Trusted Sites (LOTS) & Redirect Abuse
Attackers host phishing kits and intermediate redirectors on legitimate cloud and SaaS infrastructure whose root domains have clean reputations:
- **Raw object storage HTML** *(partially fixed in `fd7828f` for S3, GCS, Azure Blob, Firebase Storage, R2, IPFS, Backblaze, DigitalOcean Spaces)*.
- **Free static web hosting & serverless endpoints** commonly abused for credential kits: `*.web.app`, `*.firebaseapp.com`, `*.pages.dev`, `*.workers.dev`, `*.netlify.app`, `*.vercel.app`, `*.github.io`, `*.glitch.me`, `*.trycloudflare.com`, `*.ngrok-free.app`.
  - *Crucial precision rule:* Because legitimate companies sometimes send `github.io` docs or `vercel.app` previews, **never flag static hosts alone as `danger`**. Give them a weak score (e.g., `+0.15` to `+0.2` when paired with urgency, brand claims, or form/credential keywords) so FPR stays `<=0.1%`!
- **Legitimate open redirects & tracking wrappers:** unwrap known benign/tracking redirect query parameters locally before scoring (`google.com/url?q=`, `l.facebook.com/l.php?u=`, `urldefense.proofpoint.com`, `statics.teams.cdn...`, `nam*.safelinks.protection.outlook.com` already done for Outlook) so hidden malicious targets inside trusted wrappers are inspected properly.
- **URL shorteners:** flag shortened URLs (`bit.ly`, `tinyurl.com`, `t.co`, `rebrand.ly`, `rb.gy`, `cutt.ly`, `shorturl.at`, `is.gd`, `ow.ly`) as a moderate obfuscation signal (`+0.2`), because legitimate transactional security alerts from banks/Google/Apple rarely obscure links with public third-party shorteners.

### 3.2 Quishing (QR Code Phishing) & Image-Only Emails
Attackers increasingly embed the phishing URL exclusively inside a QR code image or turn the entire email body into images so DOM link extractors find zero `<a>` tags:
- **Zero-dependency QR scanning with `BarcodeDetector`:** MDN Web Docs documents the browser's built-in `BarcodeDetector({ formats: ['qr_code'] })` available in secure HTTPS contexts in Chromium/Chrome extensions with zero bundle cost.
  - *Implementation cautions:* Only run when an email contains images (`<img>`) and few/no text links; cap to e.g. the first `5` reasonably sized images (`width >= 80 && height >= 80`) and run asynchronously after initial DOM scan so `<10 ms` synchronous scoring budget isn't violated. Note that cross-origin `<img>` elements served without CORS headers may fail canvas/image-bitmap extraction unless fetched with host permissions or inspected when accessible (`img.complete`).
- **Image-heavy / low-text heuristic:** Emails with `<80` characters of visible text, `>=1` large clickable image or `<map>`/`<area>`, and urgency words in the subject or `alt` text should receive a boost (`+0.2`). Also include `img[alt]` text in `shownHost` mismatch checks if an image's `alt` displays a spoofed domain/URL.

### 3.3 Header, Relay & Structural Evasion Signals
Observed directly in our live Gmail sample and 2025–2026 campaigns:
- **Gmail `via` relay mismatch:** In `h3.iw.gFxsud`, Gmail displays `via <relay-domain>` (`span.go` sibling after `a.acP`). When the `via` relay domain differs from the `From` address's domain AND has deep subdomains (4+ labels like `442.320397.jnc7.one.bss0019.narodaro.my.id`) or low-reputation TLDs, surface a clear sender warning (`"Sent through an unrelated relay server (...)"`).
- **Whole-card clickable wrappers:** Legitimate newsletters rarely wrap an entire multi-paragraph card/table inside a single giant `<a href="...">` element so clicking anywhere opens the lure. Detecting an `<a>` enclosing `>150` chars or multiple block elements (`div`/`p`/`table`) is a strong structural phishing signal.
- **Deceptive inline trust badges/text:** Strings like `"-This message was sent from a trusted sender."` or fake `[Verified]` / `"Passed security scan"` prefixes inside the message body (`div.a3s`) are classic social-engineering ploys.
- **Hidden `<form>` & `formaction` URLs:** Extract `<form action>` and `button[formaction]` / `input[formaction]` destinations in `extract.ts` as links so `scoreEmail` inspects form exfiltration targets identically to `<a href>`.

### 3.4 Replacing Heuristic Thresholds with Calibrated Local ML (Roadmap T1–T6)
Hardcoded weights (`+0.3`, `+0.4`) have fixed tradeoffs. Completing [docs/ROADMAP.md](file:///Users/cesardeltoro-lemire/email-detection/docs/ROADMAP.md) **T1–T6** solves this systematically:
- **T1 Parity fixtures** guarantee identical feature vectors between Python (`ml/src/phishml/features.py`) and TypeScript (`extension/src/features.ts`).
- **T3/T4 Time-split training + evaluation** trains calibrated models (logistic regression baseline → shallow GBDT + hashed character/word n-grams under `200 KB` JSON) evaluated strictly at **`<=0.1%` FPR** on future time-held-out emails.
- **T8 Explainability** converts top per-feature SHAP/tree/linear contributions directly into plain-English banner reasons.

---

## 4. Pillar 3 — Usable Security & User-Friendliness

Seminal usable-security research provides concrete, counterintuitive lessons on why users ignore warnings:

- **Akhawe & Felt (USENIX Security 2013, *"Alice in Warningland"*)** studied millions of real Chrome and Firefox warning impressions and found that roughly **25–33%** of browser phishing/malware warnings were clicked through anyway, and users overwhelmingly ignored secondary `"Advanced"` / `"Learn more"` links. Core lessons:
  1. **Put the crucial warning reason on the main surface immediately** — never bury the concrete proof behind an expandable toggle.
  2. **Fight habituation ("warning fatigue"):** Keep clean mail silent and reserve high-urgency red UI (`danger`) for high-confidence threats.
  3. **Use Opinionated Design:** Make the safe path visually dominant and frictionless; make bypassing a dangerous alert require deliberate effort rather than an equally weighted button next to it.
- **NIST Technical Note 2276 (*NIST Phish Scale*)** establishes that human susceptibility depends heavily on **premise alignment** (how well the email pretext matches what the user expects in daily life, e.g., cloud storage full, delivery, password alert) vs **observable cues**. Highlighting the **exact mismatch** between premise and cue is what actually breaks the illusion.

### Concrete UX Improvements for Our Banner & Popup
1. **Tiered Friction on Bypass ("Opinionated Design"):**
   - For **`warning`** (sender/domain check only): keep 1-click **"I trust this email"** unlock.
   - For **`danger`** (`likely-phishing` / `suspicious` content): move **"Unlock links anyway"** into a secondary/subdued action (or require a 2-step confirmation: *"These links look dangerous — unlock anyway?"*) while keeping **"Back / Keep links paused"** visually prominent.
2. **Concrete Side-by-Side Cue Comparison on the Main Card:**
   - Instead of abstract warnings, render a clean visual pill pair right on the main banner card when spoofing/mismatch is present:
     - `Claims: Gmail` → `Real address: alert-442-320397@nozfr.itl`
     - `Link looks like: Review billing` → `Goes to: storage.googleapis.com`
3. **Interactive Feedback When Clicking a Paused Link:**
   - Currently, clicking a locked link silently does nothing (`e.preventDefault()`, `cursor: not-allowed`). Non-technical users often think the webmail page froze and immediately click **"I trust this email"** just to make the link work!
   - **Fix:** When a user clicks a locked link, display a small non-intrusive toast/popover right near the banner or cursor: *"Link paused for safety → points to `storage.googleapis.com`. Review the warning above before unlocking."*
4. **Reversible Post-Trust Feedback (`"Trusted ✓ [Undo]"`):**
   - After clicking **"I trust this email"**, keep a compact dismissible confirmation pill for that page view with an **Undo** button that removes the fingerprint from `trustedEmails` and re-locks links immediately if the user trusted by mistake.

---

## 5. Pillar 4 — Hardening the Extension's Own Security

A security extension running inside adversarial webmail DOMs (and parsing untrusted HTML emails) must resist bypasses against its own DOM locks, UI shadow root, allowlist, and model integrity.

### 5.1 Codebase Audit: Concrete Bypasses Found in Current Code

| File | Current Behavior | Vulnerability / Bypass | Concrete Fix |
|---|---|---|---|
| [linkLock.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/linkLock.ts) + [extract.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/adapters/extract.ts) | Stashes `href` on `a, area` and `action` on `form`; queries `a[href], area[href]`. | **1. `formaction` override:** Per MDN / HTML spec, `<button formaction="https://evil.example">` or `<input type="submit" formaction="...">` overrides `<form action>` and still submits even when `action` was removed from `<form>` (only `submit` listener prevents default if triggered via native submit, and `extract.ts` misses extracting `formaction` URLs for scoring!).<br>**2. SVG `xlink:href` & `<a ping>`:** Deprecated SVG 1.1 `<a xlink:href="...">` is ignored by `a[href]`; `<a ping="...">` sends background POST beacons on click.<br>**3. Keyboard / `keydown`:** Pressing `Enter` or `Space` on focused pseudo-interactive elements (`role="link"`, `[onclick]`) isn't captured by `click` in every handler.<br>**4. `MutationObserver` timing gap:** Links inserted dynamically between 400 ms debounced scans stay active until the next scan. | Stash/restore `formaction` (`data-ped-formaction`), `xlink:href` (`data-ped-xlink-href`), and `ping` (`data-ped-ping`); extract `form[action]`, `[formaction]`, and SVG links in `extract.ts`; block `keydown` (`Enter`/`Space`) on locked interactive controls; re-apply `lockLinks` immediately on DOM mutation when container already has `data-ped-locked`. |
| [banner.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/banner.ts) | Closed shadow root (`attachShadow({ mode: 'closed' })`), `:host { font-family: ... }`, appended to `(doc.body ?? doc.documentElement)`. | **Inherited CSS leakage & DOM removal:** Without `:host { all: initial !important; ... }`, inherited page styles (`font-size`, `line-height`, `color`, `letter-spacing`, `visibility`, `text-transform`) bleed across the Shadow DOM boundary (per MDN). Mounting inside `doc.body` also lets webmail SPA re-renders wipe `#ped-banner-host`. | Set `:host { all: initial !important; display: block !important; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif !important; }` inside shadow `<style>` and mount directly on `doc.documentElement`! |
| [allowlist.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/allowlist.ts) + [content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts) | `trustedSenders` skips scanning whenever normalized `sender.address` matches an allowlisted address. | **Allowlist spoofing (documented in [docs/threat-model.md](file:///Users/cesardeltoro-lemire/email-detection/docs/threat-model.md#L21-L22)):** If an attacker sends via an unauthenticated server with a forged `From` header (e.g., Gmail shows `via suspicious-relay.my.id` or `unauthenticated` badge), auto-trusting `sender.address` skips scanning and unlocks links! | Extract unauthenticated / `via`-mismatch flag in adapters (`gmail.ts`: detect `via` domain `!==` sender domain or Gmail question-mark / `"couldn't verify"` indicator). Never honor `trustedSenders` (and warn explicitly!) when header authentication / `via` relay conflicts with the claimed sender address. |
| [content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts) + [gmail.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/adapters/gmail.ts) | Scans only `h2.hP` + body text + `a`/`area` links. | **iCloud collapsed sender & Gmail Spoofed DOM:** On iCloud Mail, collapsed header shows display name only until `"Details"` is expanded; on Gmail, an email could spoof `.gD` classes *inside* `div.a3s` (already guarded in `gmail.ts` via `!container.contains(el)`). | Keep strict `!container.contains(el)` guards across all adapters; optionally add a non-invasive tip in iCloud banner when `senderAddress === ''` (*"Click Details in iCloud to check sender address"*). |

### 5.2 Manifest, CSP, and Model Integrity Hardening ([wxt.config.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/wxt.config.ts))
- **Explicit MV3 `content_security_policy`:** Pin `extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'"` in `wxt.config.ts` so extension pages (`popup.html`, future `warning.html`) forbid any inline scripts, `eval`, or external script loads.
- **Zero runtime dependencies:** `extension/package.json` currently ships zero runtime `dependencies` (only build/test `devDependencies`). Maintaining zero runtime third-party packages eliminates npm supply-chain compromise in production bundles.
- **SHA-256 verification of bundled ML model (T5/T6):** Verify `extension/public/model.json` against `model.sha256` at load time before evaluating JSON weights/trees, falling back cleanly to heuristics on mismatch.

---

## 6. Prioritized Implementation Matrix

| Priority | Improvement | Security / UX Impact | New Permissions? | Privacy Impact | Bundle / Perf Impact | Files Touched |
|---|---|---|---|---|---|---|
| **Tier 1 (Do First)** | **Harden `linkLock.ts` & `extract.ts`** (`formaction`, `xlink:href`, `ping`, `keydown`, instant re-lock on mutation) | Closes known HTML/SVG/formaction lock bypasses | None | None | `<0.5 KB`, `~0 ms` | [linkLock.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/linkLock.ts), [extract.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/adapters/extract.ts) |
| **Tier 1** | **Click-time destination inspector + local `warning.html` interstitial** (plus "I clicked a bad link" checklist) | Protects user **even on click** before leaving webmail | None | Domain-only (`getIntel`), URL stored only in `storage.session` | `~4–6 KB`, runs only on click | `extension/entrypoints/warning/`, [content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts), [linkLock.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/linkLock.ts) |
| **Tier 1** | **Eliminate 400 ms race-to-click gate + paused-link click tooltip** | Stops fast clicks before scan completes; prevents users blindly clicking "Trust" | None | None | `~1 KB`, `~0 ms` | [content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts), [linkLock.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/linkLock.ts), [banner.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/banner.ts) |
| **Tier 1** | **Banner CSS isolation (`all: initial`, mount on `documentElement`) + Opinionated 2-step `danger` unlock + Undo pill** | Prevents host CSS breakage; combats habituation per Akhawe & Felt | None | None | `~1.5 KB`, `~0 ms` | [banner.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/ui/banner.ts) |
| **Tier 2** | **LOTS static-host weak signal, shorteners, whole-card `<a>`, redirect unwrapping & `via` relay mismatch + allowlist auth guard** | Catches LOTS kits, shorteners, `via` spoofs, and spoofed allowlist bypass | None | None (requires parity update in `features.py`) | `~1.5 KB`, `<0.2 ms` | [features.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/features.ts), [features.py](file:///Users/cesardeltoro-lemire/email-detection/ml/src/phishml/features.py), [gmail.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/adapters/gmail.ts), [sender.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/src/sender.ts) |
| **Tier 2** | **Roadmap T1–T6 + T8 (Parity fixtures, time-split ML model `<200 KB`, SHAP/feature explainability)** | Calibrated `<=0.1%` FPR scoring instead of manual rule weights | None | Local-only inference + SHA-256 verification | `<200 KB` JSON, `<5 ms` | `ml/src/phishml/*`, `extension/src/model.ts`, `docs/results.md` |
| **Tier 3** | **Compact local Bloom filter + opt-in post-click Browser Shield (`optional_permissions`: `webNavigation`, `downloads`)** | Catches multi-hop redirects and HTML/SVG smuggling downloads outside webmail | **Opt-in only** (`optional_*` = 0 install warnings) | Zero queries on Bloom misses; user chooses opt-in | `~60–150 KB` cached list | [wxt.config.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/wxt.config.ts), [background.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/background.ts), [popup/main.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/popup/main.ts) |
| **Tier 3** | **Native `BarcodeDetector` QR ("Quishing") detection** | Decodes QR phishing images locally without bundle bloat | None (optional CORS caveat) | 100% local canvas/bitmap | `~1 KB` code, async on image-heavy mails only | `extension/src/qr.ts`, [content.ts](file:///Users/cesardeltoro-lemire/email-detection/extension/entrypoints/content.ts) |

---

## 7. Primary Sources Cited

1. **Chrome for Developers — Manifest V3 Permissions & `optional_host_permissions`:** [https://developer.chrome.com/docs/extensions/reference/api/permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions) and [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions) (install-time warning minimization via `optional_permissions` / `optional_host_permissions`).
2. **Chrome for Developers — `declarativeNetRequest` API:** [https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) (blocking vs. redirecting host-permission requirements).
3. **Chrome for Developers — `webNavigation` & `downloads` APIs:** [https://developer.chrome.com/docs/extensions/reference/api/webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation) and [https://developer.chrome.com/docs/extensions/reference/api/downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads).
4. **Google Safe Browsing API v5 & Oblivious HTTP (OHTTP) Documentation:** [https://developers.google.com/safe-browsing/v5](https://developers.google.com/safe-browsing/v5) (hash-prefix protocol, local Global Cache, and OHTTP privacy relay).
5. **MDN Web Docs — HTML `<button formaction>`, SVG `href`/`xlink:href`, Shadow DOM Encapsulation, and `BarcodeDetector` API:** [https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#formaction](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/button#formaction), [https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/xlink:href](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/xlink:href), [https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM), and [https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector](https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector).
6. **Akhawe, D., & Felt, A. P. (2013) — *"Alice in Warningland: A Large-Scale Field Study of Browser Security Warning Effectiveness"*:** USENIX Security Symposium 2013 ([https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/akhawe](https://www.usenix.org/conference/usenixsecurity13/technical-sessions/presentation/akhawe)) — empirical measurement of warning click-through rates, habituation, and opinionated warning UI design.
7. **NIST Technical Note 2276 (2023) — *NIST Phish Scale*:** National Institute of Standards and Technology ([https://csrc.nist.gov/pubs/tn/2276/final](https://csrc.nist.gov/pubs/tn/2276/final)) — observable cues vs. premise alignment in human phishing detection.
8. **CISA — HTML/SVG Smuggling & Phishing Delivery Advisories:** Cybersecurity and Infrastructure Security Agency ([https://www.cisa.gov/](https://www.cisa.gov/)).
