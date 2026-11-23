// Mirror of ml/src/phishml/features.py — keep in sync (parity-tested via ml/tests/fixtures/parity.json).
import { hostOf, isIpHost, isValidDomain, registrableDomain } from './domain';

export interface Link { text: string; href: string }
export interface Verdict { score: number; level: 'safe' | 'suspicious' | 'likely-phishing'; reasons: string[] }

const URGENCY = [
  'urgent', 'immediately', 'verify', 'suspended', 'locked', 'password', 'confirm', 'act now', 'expires',
  'expiration', 'expired', 'will be deleted', 'billing details', 'payment method', 'unauthorized',
  'unusual activity', 'action required',
];
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

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/** Percent-decode valid %XX runs without throwing on malformed '%' tokens (matches Python urllib.parse.unquote). */
export function safePercentDecode(input: string): string {
  return input.replace(/(?:%[0-9a-fA-F]{2})+/g, (seq) => {
    try {
      return decodeURIComponent(seq);
    } catch {
      const bytes = new Uint8Array(seq.length / 3);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(seq.slice(i * 3 + 1, i * 3 + 3), 16);
      }
      return utf8Decoder.decode(bytes);
    }
  });
}

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
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!isCloudStorageHost(host)) return false;
    const path = safePercentDecode(u.pathname);
    return !path.endsWith('\n') && /\.(?:html?|shtml|xhtml)$/i.test(path);
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
    return isValidDomain(h) || isIpHost(h) ? h : '';
  }
  if (/\s/.test(t)) return '';
  const authority = t.split(/[/?#]/)[0];
  if (authority.includes('@') || authority.includes('://') || authority.endsWith('.')) return '';
  const bracketedIpv6 = authority.match(/^\[([0-9a-f:.]+)\](?::\d{1,5})?$/i)?.[1]?.toLowerCase();
  if (bracketedIpv6 && isIpHost(bracketedIpv6)) return bracketedIpv6;
  const rawHost = authority.replace(/:\d{1,5}$/, '').toLowerCase();
  if (isIpHost(rawHost)) return rawHost;
  if (!isValidDomain(rawHost)) return '';
  const tld = rawHost.slice(rawHost.lastIndexOf('.') + 1);
  return rawHost.startsWith('www.') || COMMON_TLDS.has(tld) ? rawHost : '';
}

function senderDomainOf(sender: string): string {
  const cleaned = sender.trim().replace(/>+$/, '').trim();
  if (!cleaned.includes('@')) return '';
  return cleaned.slice(cleaned.lastIndexOf('@') + 1).toLowerCase().replace(/\.$/, '');
}

/** Extract numerical feature vector matching ml/src/phishml/features.py extract_features(). */
export function extractFeatures(sender: string, body: string, links: readonly Link[]): Record<string, number> {
  const lower = body.toLowerCase();
  let mismatch = 0;
  let ipLinks = 0;
  let punycode = 0;
  let cloudHtml = 0;
  for (const link of links) {
    const h = hostOf(link.href);
    if (isIpHost(h)) ipLinks += 1;
    if (h.includes('xn--')) punycode += 1;
    if (isCloudHtmlLink(link.href)) cloudHtml += 1;
    const shown = shownHost(link.text);
    if (shown && h && registrableDomain(shown) !== registrableDomain(h)) mismatch += 1;
  }
  const senderReg = registrableDomain(senderDomainOf(sender));
  let external = 0;
  if (senderReg) {
    for (const l of links) {
      const linkReg = registrableDomain(hostOf(l.href));
      if (linkReg && linkReg !== senderReg) external += 1;
    }
  }
  const urgencyHits = URGENCY.reduce((n, w) => n + lower.split(w).length - 1, 0);
  const codePointLen = [...body].length;
  return {
    n_links: links.length,
    n_text_href_mismatch: mismatch,
    n_ip_links: ipLinks,
    n_punycode_links: punycode,
    n_cloud_html_links: cloudHtml,
    n_external_links: external,
    urgency_hits: urgencyHits,
    body_len: codePointLen,
  };
}

export const FEATURE_NAMES = Object.keys(extractFeatures('', '', []));

export function scoreEmail(_sender: string, body: string, links: Link[]): Verdict {
  const reasons: string[] = [];
  let score = 0;
  const lower = body.toLowerCase();
  for (const l of links) {
    const h = hostOf(l.href);
    if (isIpHost(h)) { score += 0.3; reasons.push('A link goes to a numeric web address instead of a real website'); }
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
