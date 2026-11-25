// Single source of truth for supported webmail. Used by wxt.config.ts (host_permissions),
// content.ts (matches), and background.ts (sender URL verification).
export type ICloudFrameRole = 'shell' | 'app' | 'sandbox' | null;

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

const STANDARD_WEBMAIL_HOSTS = new Set([
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'outlook.office365.com',
  'outlook.cloud.microsoft',
  'mail.yahoo.com',
  'mail.proton.me',
]);

/** Identify which iCloud Mail frame a URL belongs to, or null if not iCloud Mail. */
export function icloudFrameRole(url: URL): ICloudFrameRole {
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Same paths as the manifest match patterns (…/mail/*, …/applications/mail2/*, …/applications/mail2-message/*),
  // so the background's sender-URL checks are no looser than where the content script can run.
  const path = url.pathname;
  if (host === 'www.icloud.com' && path.startsWith('/applications/mail2/')) return 'app';
  if (host === 'www.icloud.com' && path.startsWith('/mail/')) return 'shell';
  if (host.endsWith('.icloud-sandbox.com') && path.startsWith('/applications/mail2-message/')) return 'sandbox';
  return null;
}

/** True only when a sender URL belongs to one of the manifest-permitted webmail origins/paths. */
export function isSupportedWebmailUrl(rawUrl?: string): boolean {
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return STANDARD_WEBMAIL_HOSTS.has(host) || icloudFrameRole(u) !== null;
  } catch {
    return false;
  }
}
