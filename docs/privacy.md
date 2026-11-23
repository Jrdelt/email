# Privacy

- All analysis runs locally in the browser.
- No email content, URLs, or sender addresses are transmitted.
- No analytics or telemetry.
- Permissions are limited to the supported webmail hosts and `storage`.
- Stored locally in `browser.storage.local` only:
  - **Trusted senders** you add (email addresses). View and remove them in the popup.
  - **False-positive reports** (up to 50): verdict level, score and reason text, with email addresses redacted.
    No email body or sender is stored. View the count and clear them in the popup. They are never sent anywhere.
- "I trust this email" is remembered in memory for the current page only.
