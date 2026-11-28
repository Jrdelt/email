# Building Phishing Email Detector from source

This folder is the complete source of the browser extension. It is also what the `-sources.zip` archive (made by
`npm run zip:all`) contains, so these steps are enough to rebuild the add-on exactly as uploaded to the stores.

## Requirements

- **Node.js 22.12+ or 24+** (not 23 or 25), as set in `package.json` `engines`: `^22.12.0 || ^24.0.0 || >=26.0.0`.
  It includes **npm 10** or newer.
- Linux, macOS or Windows. No other tools are needed: `npm ci` downloads the build tools from the npm registry.

## Build

Run these commands in this folder:

```sh
npm ci                  # installs the exact build tools pinned in package-lock.json (there are no runtime dependencies)
npm run build:firefox   # Firefox build -> .output/firefox-mv3/
```

Other targets:

```sh
npm run build:chrome    # Chrome build -> .output/chrome-mv3/ (also copied to ../chrome-mv3/)
npm run build:edge      # Edge build   -> .output/edge-mv3/
npm run zip:all         # store archives -> .output/*.zip (Chrome, Edge, Firefox, and the Firefox sources zip)
```

The build uses [WXT](https://wxt.dev) 0.21 (Vite) to bundle and minify the TypeScript in `entrypoints/` and `src/`.
Files in `public/` (icons, `managed_schema.json`) are copied unchanged. `wxt.config.ts` writes the manifest.

## Checks

```sh
npm run typecheck   # TypeScript, no output files
npm test            # unit and orchestration tests (vitest + happy-dom)
```

Project overview, privacy policy and threat model: <https://github.com/Jrdelt/email> (`README.md`, `docs/`).
