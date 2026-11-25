# HIPAA Readiness, Privacy Architecture & Email Provider Compatibility

## 1. Regulatory Scope & Honest HIPAA Framing

Under the **Health Insurance Portability and Accountability Act (HIPAA)** (**45 CFR Parts 160 and 164** — Privacy Rule, Security Rule, and Breach Notification Rule), **no government agency or accreditation body issues an official "HIPAA Certified" badge for software tools or browser extensions**. HIPAA regulates **Covered Entities** (healthcare providers, health plans, clearinghouses) and **Business Associates (BAs)** that create, receive, maintain, or transmit electronic Protected Health Information (**ePHI**).

Under **45 CFR § 164.514(b)(2)** (HIPAA Safe Harbor de-identification) and **HHS/OCR guidance on online tracking technologies**, **IP addresses combined with browsing context** (plus URLs, personal email addresses, and clinical message content) can constitute protected **PHI/ePHI**. Any vendor service receiving unencrypted PHI/ePHI or identifying metadata without de-identification or a **Business Associate Agreement (BAA)** creates compliance exposure.

---

## 2. Two Operating Modes: Default vs. HIPAA / Strict Local Mode

| Capability / Data Flow | Standard Mode (Default) | Strict Local Mode (`strictLocalMode: true` — HIPAA / Zero-Egress) |
|---|---|---|
| **Email subject, body, sender address, attachment names** | 100% local in browser RAM (0 bytes sent) | 100% local in browser RAM (0 bytes sent) |
| **Content scoring, sender checks, URL & attachment inspection** | Runs offline in JS (`features.ts`, `sender.ts`, `linkGuard.ts`, `attachments.ts`) | Runs offline in JS (`features.ts`, `sender.ts`, `linkGuard.ts`, `attachments.ts`) |
| **Link & untrusted-attachment blocking (`data-ped-*`)** | Active locally on untrusted/flagged mail | Active locally on untrusted/flagged mail |
| **Off-device bare domain lookups (RDAP, Cloudflare/Google DNS, URIBL)** | Queries **only** bare registrable domains (`example.com`), never paths/queries/addresses | **Completely disabled** (`0` `fetch()` calls, `0` bytes leave the device) |
| **Local UI & `warning.html` behavior** | Shows domain age, registrar, MX/SPF/DMARC, URIBL | Shows `Strict Local Mode (0 network lookups)` & runs all local checks without network traffic |
| **Third-party BAA needed for extension telemetry/cloud** | None (developer runs no servers; public RDAP/DNS receive bare domain + user IP) | **None** — zero external network connections of any kind |

### Technical Safeguards Implemented in Code

1. **Zero-Egress Switch (`src/settings.ts`):** Checking **"Strict Local Mode (0 network lookups)"** in the popup — or locking `strictLocalMode: true` via enterprise policy — blocks `{ type: 'domainIntel' }` at four independent gates: `evaluateAndRender` in [content.ts](../extension/entrypoints/content.ts), `installClickGuard` in [content.ts](../extension/entrypoints/content.ts), [warning/main.ts](../extension/entrypoints/warning/main.ts), and `background.ts` before any `fetch()` is constructed.
2. **Minimum-Necessary Ephemeral Session Storage:** Intercepted click warnings in `browser.storage.session` (`warn:*`) hold the clicked URL but no sender address, and are removed when the user backs out or proceeds, after 1 hour, or by *"Clear all local data"*. Tab verdicts (`tab:*`) hold the latest verdict shown in the popup, including the sender's display name and address and attachment names, in memory only; they are removed when the tab closes or navigates (`tabs.onRemoved` / `tabs.onUpdated`) and by *"Clear all local data"*. Enabling Strict Local Mode also deletes cached domain-lookup results.
3. **Aggressive Local Redaction ([feedback.ts](../extension/src/feedback.ts)):** When saving optional local false-positive notes (`falsePositiveReports`), attachment filenames (`[file]`), email addresses (`[address]`), full `http(s)` URLs (`[url]`), IPv4/IPv6 literals (`[ip]`), and domain names (`[domain]`) are redacted before writing to `storage.local`. Admins can also disable local false-positive notes altogether via `disableLocalReports: true`.
4. **One-Way Cryptographic Trust (`trustedEmails`):** Email trust uses SHA-256 digests (`allowlist.ts`) rather than storing email text or sender names on disk, and `"Clear all local data"` in the popup wipes all allowlists, hashes, false-alarm logs, and domain caches on demand.
5. **No `storage.sync` & No Remote Code:** All state stays strictly local in `storage.local` / `storage.session` (never synced to Google/Microsoft/Mozilla cloud profiles), with zero analytics SDKs or remote scripts.

---

## 3. Enterprise Deployment & Admin Policy Enforcement (GPO / MDM / Intune)

Organizations subject to HIPAA, HITECH, or SOC 2 policies can lock **Strict Local Mode** on managed endpoints using Chrome, Edge, or Firefox enterprise policies referencing [`extension/public/managed_schema.json`](../extension/public/managed_schema.json). When `strictLocalMode` is pushed via `browser.storage.managed`, the popup checkbox is **locked read-only** so end users cannot accidentally enable external lookups.

### Google Chrome & Microsoft Edge (`ExtensionSettings` / `3rdparty` Policy)

Chromium reads extension policy from a different place on each platform. Substitute the published Chrome Web Store ID (`bdpnkkpanopdfhnclfcpllnlccphlejp`) or your Edge Add-ons ID:

- **Linux:** the JSON below as a file in `/etc/opt/chrome/policies/managed/` (Chrome) or `/etc/opt/edge/policies/managed/` (Edge).
- **Windows (GPO / Intune):** registry values under `HKLM\Software\Policies\Google\Chrome\3rdparty\extensions\<ID>\policy` (Edge: `HKLM\Software\Policies\Microsoft\Edge\3rdparty\extensions\<ID>\policy`), e.g. `strictLocalMode` = REG_DWORD `1`; set `ExtensionSettings` through the normal browser policy.
- **macOS (Configuration Profile):** a payload for the domain `com.google.Chrome.extensions.<ID>` (Edge: `com.microsoft.Edge.extensions.<ID>`) with the key `strictLocalMode` = `true`; `ExtensionSettings` goes in the `com.google.Chrome` / `com.microsoft.Edge` payload.

Linux JSON (the `3rdparty` block is the extension's managed storage):

```json
{
  "ExtensionSettings": {
    "bdpnkkpanopdfhnclfcpllnlccphlejp": {
      "installation_mode": "force_installed",
      "update_url": "https://clients2.google.com/service/update2/crx"
    }
  },
  "3rdparty": {
    "extensions": {
      "bdpnkkpanopdfhnclfcpllnlccphlejp": {
        "strictLocalMode": true,
        "disableLocalReports": true
      }
    }
  }
}
```

### Mozilla Firefox (`policies.json` `3rdparty` Policy)

Deploy via Firefox Enterprise `policies.json` using Gecko add-on ID `phishing-email-detector@jrdelt.github.io`:

```json
{
  "policies": {
    "3rdparty": {
      "Extensions": {
        "phishing-email-detector@jrdelt.github.io": {
          "strictLocalMode": true,
          "disableLocalReports": true
        }
      }
    }
  }
}
```

---

## 4. Email Provider Security & Compliance Matrix

| Provider | Host Match Pattern(s) | DOM / Isolation Model | Auth, Relay & Redirect Support | Privacy / Compliance Notes |
|---|---|---|---|---|
| **Gmail & Google Workspace** | `https://mail.google.com/*` | Top-frame thread DOM (`div.a3s`, `h2.hP`); attachment shelf (`div.aQH`, `span.aZo`) | Extracts `via` relay domains (`a.acP`, `span.go`) & unauthenticated sender badges; locks inline & Drive/Gmail attachment downloads | Uses client-side DOM only — requests **zero Gmail API / OAuth scopes** (`gmail.readonly`, etc.), so no Google Cloud project or Workspace CASA restricted-scope review is required. |
| **Microsoft Outlook Web & Microsoft 365** (`Outlook.com`, enterprise M365) | `https://outlook.live.com/*`, `https://outlook.office.com/*`, `https://outlook.office365.com/*`, `https://outlook.cloud.microsoft/*` | Reading Pane (`[aria-label="Message body"]`, `[role="document"]`, same-origin `iframe`), Aria attachment wells | Unwraps Microsoft Defender **Safe Links** (`*.safelinks.protection.outlook.com`) locally to inspect true target URLs; guards iframe link clicks | Uses zero Microsoft Graph / Exchange OAuth scopes; compatible with HIPAA/M365 tenants when Strict Local Mode policy is applied. |
| **Apple iCloud Mail** | `https://www.icloud.com/mail/*`, `https://www.icloud.com/applications/mail2/*`, `https://*.icloud-sandbox.com/applications/mail2-message/*` | Cross-frame (`mail2` headers + `icloud-sandbox` message iframe) | Stateless `sender.url`-verified background message relay (`icloudBody` / `icloudLock` / `icloudPing`); ignores off-screen `0×0` pooled iframes & iCloud Photos/Drive | Scoped strictly to `/mail*`, `/applications/mail2/*`, and `*.icloud-sandbox.com/applications/mail2-message/*` — never accesses iCloud Photos, Drive, Notes, or Contacts. |
| **Yahoo Mail** | `https://mail.yahoo.com/*` | Reading-pane containers (`[data-test-id="message-view-body-content"]`, `.msg-body`) + iframe fallback | Multi-message extraction, compose editor exclusion (`[data-test-id="compose-editor"]`), attachment list/tile locking, iframe click guard | Runs purely inside rendered inbox DOM; compose drafts are explicitly excluded (`isCompose`). |
| **Proton Mail** | `https://mail.proton.me/*` | Locally decrypted DOM (`[data-testid="content-iframe"]` or `[data-testid="message-content:body"]`) | Extracts decrypted body, sender, links, and attachment cards (`[data-testid^="attachment-item"]`); excludes Proton composer | Strictly read-only on DOM **after** Proton decrypts locally in the user's browser; never inspects private PGP keys, SRP auth, or Proton APIs. Pair with Strict Local Mode for zero external domain lookups. |
| **Other Providers** (`Fastmail`, `Zoho Mail`, desktop IMAP clients) | Out of scope in `0.1.x` | — | — | Native desktop clients (Apple Mail, Outlook Desktop, Thunderbird) and Fastmail/Zoho require future adapters or separate integrations outside the MV3 webmail extension. |
