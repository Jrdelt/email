# HIPAA and Compliance Notes

This page explains how the extension handles data, so a compliance team can judge whether it fits their environment. It is not a certification and does not guarantee HIPAA compliance. For the full data list, see the [privacy policy](privacy.md).

## 1. HIPAA background

- **HIPAA** (the Health Insurance Portability and Accountability Act, **45 CFR Parts 160 and 164**: the Privacy, Security and Breach Notification Rules) applies to **covered entities** (healthcare providers, health plans and clearinghouses) and to **business associates** that create, receive, keep or send electronic protected health information (**ePHI**).
- **No government agency or accreditation body issues an official "HIPAA Certified" badge** for software tools or browser extensions.
- Under the HIPAA Safe Harbor de-identification rule (**45 CFR § 164.514(b)(2)**) and **HHS/OCR guidance on online tracking technologies**, IP addresses combined with browsing context, as well as URLs, personal email addresses and clinical message content, can count as PHI/ePHI. A vendor service that receives this data without de-identification or a **Business Associate Agreement (BAA)** creates compliance risk.

## 2. Standard Mode and Strict Local Mode

| Data flow | Standard Mode (default) | Strict Local Mode (`strictLocalMode: true`) |
|---|---|---|
| Email subject, body, sender address, attachment names | Stay in browser memory; nothing is sent | Stay in browser memory; nothing is sent |
| Content, sender, link and attachment checks (`features.ts`, `sender.ts`, `linkGuard.ts`, `attachments.ts`) | Run locally | Run locally |
| Link and untrusted-attachment locking | Active on untrusted or flagged mail | Active on untrusted or flagged mail |
| Domain lookups (RDAP, Cloudflare/Google DNS, URIBL) | Bare registrable domain only (`example.com`); never paths, queries or addresses | **Off**: no `fetch()` calls, nothing leaves the device |
| Domain details in the banner, popup and `warning.html` | Domain age, registrar, MX/SPF/DMARC, URIBL | Says lookups are skipped (Strict Local Mode); all local checks still run |
| Developer servers or telemetry | None. Public RDAP and DNS services receive the bare domain and the user's IP address | None. No outside network connections of any kind |

## 3. Technical safeguards in the code

1. **Zero-network switch (`src/settings.ts`).** Turning on **"Strict Local Mode (0 network lookups)"** in the popup, or enforcing `strictLocalMode: true` by policy, stops domain lookups in four places before any `fetch()` is built: the email scan and the click guard in [content.ts](../extension/entrypoints/content.ts), the [warning page](../extension/entrypoints/warning/main.ts), and [background.ts](../extension/entrypoints/background.ts).
2. **Minimum necessary session data.** Click warnings kept in `browser.storage.session` (`warn:*`, 1-hour lifetime) leave out the sender's email address; it is never sent to `background.ts` or stored there. Per-tab results (`tab:*`), which include the sender details shown in the popup, are deleted automatically when the tab closes.
3. **Local redaction ([feedback.ts](../extension/src/feedback.ts)).** Before an optional false-positive note is saved to `storage.local`, email addresses, full `http(s)` URLs, IPv4 addresses and domain names are replaced with `[address]`, `[url]`, `[ip]` and `[domain]`. Admins can turn these notes off completely with `disableLocalReports: true`.
4. **One-way trust fingerprints.** Trusting an email stores a SHA-256 hash (`allowlist.ts`), not the email text or sender name. **"Clear all local data"** in the popup deletes trusted senders, hashes, false-positive notes and domain caches on demand.
5. **No sync and no remote code.** Data stays in `storage.local` and `storage.session` and is never synced to Google, Microsoft or Mozilla cloud profiles. There are no analytics SDKs or remote scripts.

## 4. Enforcing Strict Local Mode for an organization

Organizations under HIPAA, HITECH or SOC 2 policies can lock **Strict Local Mode** on managed computers with Chrome, Edge or Firefox enterprise policy, using the settings in [`extension/public/managed_schema.json`](../extension/public/managed_schema.json). When a policy sets `strictLocalMode`, the popup switch becomes **read-only**, so users cannot turn external lookups back on.

### Google Chrome and Microsoft Edge (`ExtensionSettings` and `3rdparty` policy)

Deploy with Windows Group Policy, Intune or a macOS configuration profile (`com.google.Chrome` or `com.microsoft.Edge`). The example uses the Chrome Web Store ID (`bdpnkkpanopdfhnclfcpllnlccphlejp`); use the Edge Add-ons ID for Edge:

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

### Mozilla Firefox (`policies.json` `3rdparty` policy)

Deploy with Firefox enterprise `policies.json`, using the add-on ID `phishing-email-detector@jrdelt.github.io`:

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

## 5. Webmail provider notes

| Provider | Sites | Notes |
|---|---|---|
| **Gmail and Google Workspace** | `https://mail.google.com/*` | Reads the page only and requests **no Gmail API or OAuth scopes** (such as `gmail.readonly`), so no Google Cloud project or restricted-scope security review (CASA) is needed. Reads Gmail's "via" relay and unverified-sender labels. Locks the attachment shelf and inline downloads. |
| **Outlook on the web and Microsoft 365** | `https://outlook.live.com/*`, `https://outlook.office.com/*`, `https://outlook.office365.com/*`, `https://outlook.cloud.microsoft/*` | Reads the reading pane, including its message frame. Unwraps Microsoft Defender **Safe Links** locally to check the real target. Uses no Microsoft Graph or Exchange OAuth scopes. Locks attachment cards. |
| **Apple iCloud Mail** | `https://www.icloud.com/mail/*`, `https://www.icloud.com/applications/mail2/*`, `https://*.icloud-sandbox.com/applications/mail2-message/*` | Headers and message body load in separate frames. A stateless background relay connects them and checks each message's `sender.url`. Access is limited to these mail paths; it never touches iCloud Photos, Drive, Notes or Contacts. |
| **Yahoo Mail** | `https://mail.yahoo.com/*` | Reads the message view (with an iframe fallback) and locks attachment tiles. Compose drafts are skipped. |
| **Proton Mail** | `https://mail.proton.me/*` | Reads only the page **after** Proton has decrypted the message in your browser. Never touches private PGP keys, SRP login data or Proton APIs, and skips the composer. Pair with Strict Local Mode for no outside domain lookups. |
| **Other providers** (Fastmail, Zoho Mail, desktop apps) | Not supported in `0.1.x` | Desktop clients (Apple Mail, Outlook desktop, Thunderbird) and Fastmail or Zoho would need future adapters or separate integrations. |
