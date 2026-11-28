# Browser Support & Store Publishing Guide (2025–2026)

**Phishing Email Detector** builds from a single TypeScript codebase using [WXT](https://wxt.dev) and Manifest V3 (MV3), with zero runtime third-party npm dependencies and strict Extension Pages CSP (`script-src 'self'; object-src 'none'; base-uri 'none';`).

---

## Major Browser Support Matrix

| Browser | Engine | Manifest & API | Extension Store / Install Method | Current Build Status |
|---|---|---|---|---|
| **Google Chrome** (Desktop MV3) | Chromium / Blink | MV3 (`service_worker`, `storage.managed_schema`) | [Chrome Web Store](https://chromewebstore.google.com) (`0.1.0` in review; local `chrome-mv3/`) | Supported (`build:chrome`) |
| **Microsoft Edge** | Chromium / Blink | MV3 (`service_worker`, `storage.managed_schema`) | Microsoft Partner Center — Edge Add-ons | Supported (`build:edge`) |
| **Mozilla Firefox** (`142.0+` desktop) | Gecko | MV3 (`gecko.id`, `data_collection_permissions`) | addons.mozilla.org (AMO) (`0` errors, `0` warnings via `addons-linter`) | Supported on desktop (`build:firefox`); Firefox for Android is not tested or supported |
| **Brave** | Chromium / Blink | MV3 Chromium bundle | Installs directly from **Chrome Web Store** or unpacked via `brave://extensions` | Installs the Chrome build (not tested separately) |
| **Vivaldi & Arc** | Chromium / Blink | MV3 Chromium bundle | Installs directly from **Chrome Web Store** or unpacked | Installs the Chrome build (not tested separately) |
| **Opera** | Chromium / Blink | MV3 Chromium bundle | Opera Add-ons (`addons.opera.com`) or CWS compatibility | Installs the Chrome build (not tested separately; separate store review rules) |
| **Apple Safari** (macOS) | WebKit | MV3 (Xcode wrapper app) | Apple App Store via `xcrun safari-web-extension-converter` | **Not supported yet:** never built or tested; would need an Xcode wrapper app. iOS is out of scope (the adapters target desktop webmail pages) |

---

## Store Policies & Submission Requirements (Updated for 2025–2026)

### 1. Google Chrome Web Store

- **Manifest & Architecture:** MV2 is retired; MV3 is mandatory (`"manifest_version": 3`, bundled JS only, zero remote code execution or `eval`).
- **Privacy, "Limited Use", & "Strictly Necessary" Rules:**
  - Data collected or transmitted must be strictly necessary for the extension's single, prominently stated purpose.
  - Because default domain lookups transmit bare registrable domains off-device (and the user's IP plus the browser's standard request headers, including the extension's `Origin`, to public RDAP/DNS resolvers), **in-UI transparency** in [popup/index.html](../extension/entrypoints/popup/index.html) displays the data practice summary (which domains are checked online) and a **Strict Local Mode (0 network lookups)** toggle. Lookups start as soon as an untrusted email is opened, so enable Strict Local Mode first (or by policy) where none may run.
  - **Privacy Practices dashboard declarations** must match actual `fetch()` / `storage` calls and the public [Privacy Policy](privacy.md) verbatim.
- **Listing Copy & Metadata (`Yellow Argon` compliance):**
  - Never place comma-separated lists of website domains (`mail.google.com, outlook.live.com, ...`) inside the public **Detailed Description** — CWS automated scanners flag them as `Yellow Argon` keyword spam. Describe supported webmail services in plain prose in **Store listing**, and list explicit host patterns only in the private **Privacy practices** permission justifications.
- **Required Store Assets & Account Setup:**
  - One-time $5 Chrome Web Store developer registration fee and a **verified Publisher Contact Email** under **Account**.
  - `128×128` PNG icon, at least one `1280×800` (or `640×400`) **24-bit RGB PNG** screenshot (alpha channel stripped), optional `440×280` small promo tile, and an HTTP 200 public Privacy Policy URL.

### 2. Microsoft Edge Add-ons (Partner Center)

- **Account & Registration:** Register in Microsoft Partner Center with a personal **Microsoft Account (MSA)** (`$0` registration fee).
- **Package & Manifest:** Accepts the Edge Chromium MV3 ZIP (`extension/.output/phishing-email-detection-extension-*-edge.zip`), with `storage.managed_schema` supported for Intune / GPO Group Policy (`ExtensionSettings`). Strip Chrome-only `update_url` fields if manually ported (WXT already omits `update_url`).
- **Required Store Assets:**
  - **Store Logo:** Square **`300×300` PNG** required per locale (minimum `128×128`): [store/graphics/edge-logo-300x300.png](../store/graphics/edge-logo-300x300.png).
  - **Screenshots:** `1280×800` or `640×480` PNGs (up to 6).
  - **Optional Promo Tiles:** `440×280` (small) and `1400×560` (large) PNGs.
- **Review Process & Pitfalls:**
  - Single-purpose & Privacy disclosures in Partner Center must align with [docs/privacy.md](privacy.md).
  - First submissions and updates with host permissions typically review in **1–7 business days**. Do **not** upload a new package while an existing submission is still in review, as doing so cancels/restarts the queue.

### 3. Mozilla Firefox Add-ons (AMO)

- **Mandatory `data_collection_permissions` (effective Nov 3, 2025):**
  - All new AMO extensions must declare `browser_specific_settings.gecko.data_collection_permissions` in `manifest.json` (`extension/wxt.config.ts`).
  - Because **Phishing Email Detector** queries bare registrable website domains from opened emails and clicked external links against RDAP/DNS by default (unless the user or enterprise admin enables **Strict Local Mode**), Firefox declares, conservatively:
    ```json
    "data_collection_permissions": {
      "required": ["websiteContent", "browsingActivity", "personalCommunications"]
    }
    ```
    `browsingActivity` because Mozilla's definition names domains of sites visited (a clicked link's domain is looked up before it opens); `personalCommunications` because the looked-up sender domain comes from an email. Only bare registrable domains are sent, never URLs, addresses or email content. The Chrome Web Store form checks the matching categories (*Personal communications*, *Web history*, *Website content*: domain only; see [CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md)). Edge Partner Center asks a single question instead (whether the extension accesses, collects or transmits personal information): answer **Yes** and give the privacy policy URL ([docs/privacy.md](privacy.md)); check the current wording in Partner Center.
  - **Version interlock:** `strict_min_version` is set to `"142.0"` so every Firefox that can install it supports `data_collection_permissions` (Desktop 140+, Android 142+), yielding **0 errors and 0 warnings** from `addons-linter --warnings-as-errors`. The extension is for desktop webmail only: leave **Firefox for Android** unchecked on AMO until mobile webmail layouts have been verified.
- **Mandatory `-sources.zip` Reproducible Build Review:**
  - Because Vite / WXT bundles and minifies TypeScript, AMO requires uploading both the extension ZIP (`phishing-email-detection-extension-*-firefox.zip`) and the source archive (`phishing-email-detection-extension-*-sources.zip`) generated by `npm run zip:all`. The source archive is built from `extension/` only, so its step-by-step build instructions live in [extension/README.md](../extension/README.md), which is inside the archive (Node.js version, `npm ci`, `npm run build:firefox`, output in `.output/firefox-mv3/`).
- **Compatibility Differences Handled in Code:**
  - Firefox ignores Chromium `storage.managed_schema` in `manifest.json` (so `wxt.config.ts` emits `managed_schema` only on Chromium targets; Firefox reads `storage.managed` via native policy manifests wrapped in `try/catch` in `src/settings.ts`).
  - `details::details-content` transitions are gated behind `@supports (interpolate-size: allow-keywords)` so Firefox toggles accordions instantly without discrete delay.
  - Closing `warning.html` tries `browser.tabs.getCurrent()` + `browser.tabs.remove()` before `window.close()` / `history.back()`.

### 4. Brave, Vivaldi & Arc (Chromium Store Ecosystem)

- Brave, Vivaldi, and Arc have **no separate extension store** — they install directly from the **Chrome Web Store** once published, or load unpacked from `chrome-mv3/` during development (`brave://extensions` / `vivaldi://extensions`).
- Brave's built-in tracking protection is not expected to block the extension's own RDAP / DNS-over-HTTPS lookups or its closed Shadow DOM (`#ped-banner-host`, `#ped-toast-host`), but this has not been tested.

### 5. Opera Add-ons (`addons.opera.com`)

- Opera runs Chromium MV3 (the Edge/Chrome build is API-compatible), enforces a strict **"One Goal"** single-purpose rule, and **prohibits unreviewable minified/obfuscated bundles** unless full readable source code is provided or linked cleanly for moderation.
- Manual review queues on Opera Add-ons often take weeks; users can alternatively install directly from the Chrome Web Store via Opera's extension support while Opera Add-ons moderation completes.

### 6. Apple Safari Web Extensions (not supported yet)

- **Status:** no Safari build has been made or tested, and no CI job covers it. The notes below are the expected path for a future macOS release; iOS is out of scope because the adapters target desktop webmail pages.
- Safari supports MV3 content scripts, service workers, and `browser.storage.*` APIs, **but cannot be uploaded as a standalone `.zip`**.
- **Packaging Path (untested):**
  1. Build the Chromium MV3 unpacked output (`cd extension && npm run build:chrome`).
  2. Convert with Xcode's CLI tool on macOS:
     ```sh
     xcrun safari-web-extension-converter extension/.output/chrome-mv3 \
       --app-name "Phishing Email Detector" \
       --bundle-identifier io.github.jrdelt.phishing-email-detector \
       --macos-only
     ```
  3. Requires an active **Apple Developer Program** membership, App Sandbox configuration, and **App Store Connect Privacy Nutrition Labels** matching [docs/privacy.md](privacy.md) (with **Strict Local Mode** supporting zero network egress).

---

## Pre-Submission Technical Checks (`extension/`)

1. Unpacked size budget: Chrome `~237 kB`, Edge `~237 kB`, Firefox `~236 kB` (limit: `<500 KB`; CI checks it). Zipped: `~92 kB` each.
2. `npm run typecheck`, `npm test`, `npm run build:all`, `npm run zip:all` all green.
3. `npx addons-linter .output/firefox-mv3 --warnings-as-errors` → **0 errors, 0 warnings**.
4. Store copy and privacy forms match `CHROMEWEBSTORE.md` and `docs/privacy.md` with zero unused `host_permissions`.
5. Store API credentials from `wxt submit init` live in `extension/.env.submit`, which is gitignored (as is every `.env.*` except `.env.example`). Never commit them.
6. CI uses `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0 and `astral-sh/setup-uv` v10.3.3, pinned to commit SHAs; merge Dependabot's `github-actions` updates to keep them current.
