# Chrome Web Store listing files

Everything the store listing needs, ready to upload or paste. `graphics/preview-all-graphics.png` shows the screenshots, promo tiles and marquee together, at the size the store shows them.

## Text (`listing/`)

| File | Where it goes | Note |
|------|---------------|------|
| `description-0.1.0.txt` | Store listing → Description, **now** | Matches the 0.1.0 package submitted on 2026-11-23 (Gmail, Outlook, iCloud only; it still describes that package's spam-list check, which later versions removed). |
| `description-0.2.0.txt` | Store listing → Description, **with the 0.2.0 package** | Adds Yahoo Mail, Proton Mail and Strict Local Mode. Never paste it before 0.2.0 is uploaded. |
| `name.txt`, `summary.txt` | `extension/wxt.config.ts` (manifest `name` / `description`) | **Not applied yet:** `wxt.config.ts` still has the 0.1.0 name and description. The store takes the name and short description from the package, so copy these in together with the 0.2.0 version bump (`extension/package.json` is still `0.1.0`). |

**Version label (open owner decision):** archives built now are still labelled `0.1.0` (`extension/package.json`) although they contain the 0.2.0 features. Bump the version, and apply `name.txt` / `summary.txt`, before uploading a new package to any store. See [CHROMEWEBSTORE.md](../CHROMEWEBSTORE.md).

**How to paste the description:** open the `.txt` file in a plain-text editor, select all, copy, and paste into the dashboard. Never copy it from a terminal, a chat or a rendered Markdown page: that adds hard line breaks and indents, and the store shows them exactly as pasted.

## Graphics (`graphics/`)

| File | Dashboard field | When |
|------|-----------------|------|
| `screenshot-1-spot-phishing.png` … `screenshot-4-attachments-locked.png` | Screenshots, in this order (1280×800) | Now |
| `screenshot-5-private.png` | Screenshot 5 | With 0.2.0 (shows Strict Local Mode) |
| `small-promo-440x280.png` | Small promo tile | Now (the no-text version; the store prints the name under it) |
| `marquee-1400x560.png` | Marquee promo tile | Now |
| `store-icon-128-padded.png` | Store icon | Now (artwork padded the way the store expects) |
| `edge-logo-300x300.png` | Edge Add-ons store logo (Partner Center) | With the Edge submission (same artwork, 300×300) |
| `demo-video-draft-1280x800.mp4` | Not uploaded directly | Silent draft of a demo; add captions and publish on YouTube if you want a video on the listing. |

All screenshots and the demo video show the real extension on an invented webmail page with made-up `.example` names and addresses. They were last re-captured on 2026-11-28, after the spam-list check was removed (no more "Spam check" row or "reported for spam" reasons). Re-capture them whenever the banner, popup or warning page wording changes, so the listing keeps showing what users really see.
