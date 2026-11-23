// Single source of truth for supported webmail. Used by wxt.config.ts (host_permissions)
// and the content script (matches). Adding a provider = add here + add an adapter.
export const ICLOUD_APP_MATCHES = ['https://www.icloud.com/applications/mail2/*'];
export const ICLOUD_SANDBOX_MATCHES = ['https://*.icloud-sandbox.com/applications/mail2-message/*'];

export const WEBMAIL_MATCHES = [
  'https://mail.google.com/*', // Gmail
  'https://outlook.live.com/*', // Outlook.com
  'https://outlook.office.com/*', // Microsoft 365
  'https://outlook.office365.com/*', // Microsoft 365 (alt)
  'https://outlook.cloud.microsoft/*', // Microsoft 365 (current Outlook Web)
  'https://mail.yahoo.com/*', // Yahoo Mail
  'https://mail.proton.me/*', // Proton Mail
  'https://www.icloud.com/mail/*', // iCloud Mail
  ...ICLOUD_APP_MATCHES,
  ...ICLOUD_SANDBOX_MATCHES,
];
