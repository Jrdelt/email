// Mirror of ml/src/phishml/features.py — keep in sync (parity-tested).
import { hostOf, isValidDomain, registrableDomain } from './domain';

export interface Link { text: string; href: string }
export interface Verdict { score: number; level: 'safe' | 'suspicious' | 'likely-phishing'; reasons: string[] }

const URGENCY = [
  'urgent', 'immediately', 'verify', 'suspended', 'locked', 'password', 'confirm', 'act now', 'expires',
  'expiration', 'expired', 'will be deleted', 'billing details', 'payment method', 'unauthorized',
  'unusual activity', 'action required',
];
const IP_HOST = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const EXPLICIT_URL = /https?:\/\/[^\s<>"'()]+/i;

const CLOUD_STORAGE_HOSTS = new Set([
  'storage.googleapis.com',
  'storage.cloud.google.com',
  'firebasestorage.googleapis.com',
  'ipfs.io',
  'cloudflare-ipfs.com',
  'gateway.pinata.cloud',
  's3.amazonaws.com',
]);
const CLOUD_STORAGE_SUFFIXES = [
  '.s3.amazonaws.com',
  '.blob.core.windows.net',
  '.r2.dev',
  '.backblazeb2.com',
  '.digitaloceanspaces.com',
];
const REGIONAL_S3_HOST = /^s3[.-][a-z0-9-]+\.amazonaws\.com$/;

// Intentionally omits common non-web file extensions (pdf, js, py, sh, pl, rs, md, zip, mov).
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'co', 'ai', 'app', 'dev', 'me',
  'us', 'uk', 'ca', 'au', 'de', 'fr', 'jp', 'cn', 'br', 'in', 'nl', 'es', 'it', 'se',
  'ch', 'ru', 'kr', 'nz', 'za', 'mx', 'sg', 'hk', 'tw', 'eu', 'be', 'at', 'cz', 'dk',
  'no', 'fi', 'ie', 'pt', 'gr', 'tr', 'il', 'ae', 'sa', 'ar', 'cl', 'id', 'my', 'ph',
  'th', 'vn', 'info', 'biz', 'xyz', 'top', 'site', 'online', 'store', 'shop', 'club',
  'live', 'cloud', 'tech', 'page', 'link', 'click', 'pro', 'tv', 'gg', 'cc', 'ly', 'to',
  'bank', 'support', 'security', 'login', 'account', 'mail', 'email', 'news', 'work',
  'life', 'world', 'today', 'digital', 'agency', 'services', 'solutions', 'network',
  'systems', 'center', 'company', 'group', 'finance', 'pay', 'example', 'test',
]);

function isCloudStorageHost(host: string): boolean {
  return (
    CLOUD_STORAGE_HOSTS.has(host) ||
    REGIONAL_S3_HOST.test(host) ||
    CLOUD_STORAGE_SUFFIXES.some((s) => host.endsWith(s))
  );
}

/** True when a link points to an HTML page hosted directly on raw cloud object storage. */
export function isCloudHtmlLink(href: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!isCloudStorageHost(u.hostname.toLowerCase())) return false;
    let path = u.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep raw pathname */ }
    return /\.(?:html?|shtml|xhtml)$/i.test(path);
  } catch {
    return false;
  }
}

/**
 * Extract a hostname only when the link text looks like an explicit URL or bare domain/IP,
 * so prose like "please reset your password immediately." or filenames like "report.pdf" return ''.
 */
export function shownHost(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const m = t.match(EXPLICIT_URL);
  if (m) {
    const candidate = m[0].replace(/[.,;:!?]+$/, '');
    const h = hostOf(candidate);
    return isValidDomain(h) || IP_HOST.test(h) ? h : '';
  }
  if (/\s/.test(t)) return '';
  const authority = t.split(/[/?#]/)[0];
  if (authority.includes('@') || authority.includes('://') || authority.endsWith('.')) return '';
  const rawHost = authority.replace(/:\d{1,5}$/, '').toLowerCase();
  if (IP_HOST.test(rawHost)) return rawHost;
  if (!isValidDomain(rawHost)) return '';
  const tld = rawHost.slice(rawHost.lastIndexOf('.') + 1);
  return rawHost.startsWith('www.') || COMMON_TLDS.has(tld) ? rawHost : '';
}

export function scoreEmail(_sender: string, body: string, links: Link[]): Verdict {
  const reasons: string[] = [];
  let score = 0;
  const lower = body.toLowerCase();
  for (const l of links) {
    const h = hostOf(l.href);
    if (IP_HOST.test(h)) { score += 0.3; reasons.push('A link goes to a numeric web address instead of a real website'); }
    if (h.includes('xn--')) { score += 0.3; reasons.push('A link uses lookalike characters in its web address'); }
    if (isCloudHtmlLink(l.href)) { score += 0.4; reasons.push('A link points to a web page hosted on raw cloud storage'); }
    const shown = shownHost(l.text);
    if (shown && h && registrableDomain(shown) !== registrableDomain(h)) {
      score += 0.4; reasons.push(`A link says ${shown} but actually goes to ${h}`);
    }
  }
  const hits = URGENCY.reduce((n, w) => n + lower.split(w).length - 1, 0);
  if (hits >= 2) { score += 0.2; reasons.push('Uses urgent wording about passwords or your account'); }
  score = Math.min(1, score);
  const level = score >= 0.6 ? 'likely-phishing' : score >= 0.3 ? 'suspicious' : 'safe';
  return { score, level, reasons: [...new Set(reasons)] };
}
