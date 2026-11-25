# Browser Support and Store Publishing

The extension is built from one TypeScript codebase with [WXT](https://wxt.dev) and Manifest V3 (MV3). It has no runtime third-party npm dependencies, and its extension pages use a strict Content Security Policy (`script-src 'self'; object-src 'none'; base-uri 'none';`). To load a development build, see [Load Unpacked in Your Browser](../README.md#load-unpacked-in-your-browser).

## Browser support

| Browser | Engine | How it is installed | Status |
|---|---|---|---|
| **Google Chrome** (desktop) | Chromium | [Chrome Web Store](https://chromewebstore.google.com) (version `0.1.0` submitted for review) or unpacked from `chrome-mv3/` | Supported (`npm run build:chrome`) |
| **Microsoft Edge** | Chromium | Edge Add-ons (Microsoft Partner Center) | Supported (`npm run build:edge`) |
| **Mozilla Firefox 142+** (desktop and Android) | Gecko | addons.mozilla.org (AMO) | Supported (`npm run build:firefox`) |
| **Brave, Vivaldi, Arc** | Chromium | Chrome Web Store, or unpacked from `chrome-mv3/` | Compatible (Chrome build) |
| **Opera** | Chromium | Opera Add-ons (`addons.opera.com`) or the Chrome Web Store | Compatible (Chrome build); separate store review |
| **Apple Safari 16.4+** (macOS and iOS) | WebKit | Apple App Store, inside an Xcode wrapper app | Same code; needs the Xcode wrapper |

## Store requirements

### 1. Chrome Web Store

- **MV3 only.** All code must be bundled in the package. No remote code and no `eval`.
- **Data must be strictly necessary** for the extension's single, clearly stated purpose. Default lookups send bare domains (and the user's IP address) to public RDAP and DNS services, so the [popup](../extension/entrypoints/popup/index.html) summarizes this and offers the **Strict Local Mode (0 network lookups)** switch.
- **Privacy Practices answers** must match the code's real `fetch()` and `storage` use and the public [privacy policy](privacy.md).
- **No domain lists in the description.** Comma-separated webmail domains (`mail.google.com, outlook.live.com, ...`) in the public Detailed Description are flagged as keyword spam (rejection code "Yellow Argon"). Name the supported webmail in plain prose, and list host patterns only in the private permission justifications.
- **Account and assets:** a one-time $5 developer fee, a verified publisher contact email, a 128×128 PNG icon, at least one 1280×800 (or 640×400) 24-bit RGB PNG screenshot with no alpha channel, an optional 440×280 promo tile, and a public privacy policy URL that returns HTTP 200.

### 2. Microsoft Edge Add-ons (Partner Center)

- **Account:** register in Microsoft Partner Center with a personal Microsoft account (no fee).
- **Package:** upload the Edge ZIP (`extension/.output/phishing-email-detection-extension-<version>-edge.zip`). Edge supports `storage.managed_schema` for Intune and Group Policy (`ExtensionSettings`). WXT does not add Chrome's `update_url`, so nothing needs to be removed.
- **Assets:** a 300×300 PNG store logo for each language (minimum 128×128), up to 6 screenshots at 1280×800 or 640×480, and optional 440×280 and 1400×560 promo tiles.
- **Review:** single-purpose and privacy answers must match [privacy.md](privacy.md). Reviews of new submissions or updates with host permissions usually take 1 to 7 business days. Do not upload a new package while one is still in review, because that cancels and restarts the queue.

### 3. Firefox Add-ons (AMO)

- **`data_collection_permissions` (required for new extensions since November 3, 2025).** It is declared under `browser_specific_settings.gecko` in `extension/wxt.config.ts`. By default (unless the user or an admin turns on Strict Local Mode), the extension looks up bare domains from opened emails and clicked links, so it declares:

  ```json
  "data_collection_permissions": {
    "required": ["websiteContent"]
  }
  ```

- **Minimum version 142.0.** `strict_min_version` is `"142.0"` because Firefox desktop (140+) and Firefox for Android (142+) both support `data_collection_permissions` from that point.
- **Source upload.** WXT bundles and minifies the code, so AMO needs both the extension ZIP (`phishing-email-detection-extension-<version>-firefox.zip`) and the source ZIP (`phishing-email-detection-extension-<version>-sources.zip`). `npm run zip:all` creates both. Build steps are in [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Firefox differences handled in code:**
  - Firefox ignores `storage.managed_schema` in `manifest.json`, so `wxt.config.ts` adds it only for Chromium builds. Firefox gets `storage.managed` values from its own enterprise policy setup, and `src/settings.ts` reads them inside `try/catch`.
  - Accordion animations are wrapped in `@supports (interpolate-size: allow-keywords)`, so Firefox opens them instantly.
  - Closing `warning.html` tries `browser.tabs.getCurrent()` and `browser.tabs.remove()` before falling back to `window.close()` and `history.back()`.

### 4. Brave, Vivaldi and Arc

These browsers have **no separate extension store**. They install from the Chrome Web Store once the extension is published there, or load the unpacked `chrome-mv3/` build during development (`brave://extensions`, `vivaldi://extensions`).

### 5. Opera Add-ons

Opera runs Chromium MV3, and the Chrome and Edge build is API-compatible with it. Its store enforces a strict single-purpose ("One Goal") rule and **rejects minified bundles it cannot review** unless readable source code is provided or linked. Manual reviews can take weeks. Meanwhile, users can install from the Chrome Web Store through Opera's extension support.

### 6. Apple Safari (macOS and iOS App Store)

Safari supports MV3 content scripts, service workers and `browser.storage.*`, but **cannot accept a plain ZIP**. To package it:

1. Build the Chromium version: `cd extension && npm run build:chrome`.
2. On macOS, from the repo root, convert it with Xcode's command-line tool:

   ```sh
   xcrun safari-web-extension-converter extension/.output/chrome-mv3 \
     --app-name "Phishing Email Detector" \
     --bundle-identifier io.github.jrdelt.phishing-email-detector \
     --macos-only
   ```

3. You need an **Apple Developer Program** membership, App Sandbox settings, and **App Store Connect privacy labels** that match [privacy.md](privacy.md). Strict Local Mode supports zero network traffic.

## Checks before submitting (run in `extension/`)

1. Each unpacked build is about 210 kB (limit: 500 KB).
2. `npm run typecheck`, `npm test`, `npm run build:all` and `npm run zip:all` all pass.
3. `npx addons-linter .output/firefox-mv3 --warnings-as-errors` reports 0 errors and 0 warnings.
4. Store text and privacy forms match [CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md) and [privacy.md](privacy.md), and every `host_permissions` entry is used.
