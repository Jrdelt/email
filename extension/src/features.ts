// Mirror of ml/src/phishml/features.py — keep in sync (parity-tested via ml/tests/fixtures/parity.json).
import { hostOf, isIpHost, isValidDomain, registrableDomain } from './domain';

export interface Link { text: string; href: string }
export interface Verdict { score: number; level: 'safe' | 'suspicious' | 'likely-phishing'; reasons: string[] }

const URGENCY = [
  'urgent', 'immediately', 'verify', 'suspended', 'locked', 'password', 'confirm', 'act now', 'expires',
  'expiration', 'expired', 'will be deleted', 'billing details', 'payment method', 'unauthorized',
  'unusual activity', 'action required', 'temporarily limited', 'limited access', 'within 24 hours',
  'within 48 hours', 'avoid interruption', 'avoid suspension', 'restore access', 'unrecognized device',
  'sign-in attempt',
];
const EXPLICIT_URL = /https?:\/\/[^\s<>"'()]+/i;
const SHORT_TOKEN_PATH_RE = /^\/[A-Za-z0-9_-]{3,12}$/;
const SHORT_CTA_TEXT_RE = /\b(?:verify|confirm|reset|unlock|update|sign\s*in|log\s*in|login|review|secure|restore|reactivate|validate|click)\b/i;

export const IP_LOGGER_HOSTS = new Set([
  'urlto.me', 'grabify.link', 'grabify.icu', 'stopify.co', 'hd.gd', 'onbit.pro', 'snifferip.com', 'unl.one',
  'iplogger.org', 'iplogger.com', '2no.co', 'yip.su', 'ezstat.ru', 'leancoding.co', 'quickmessage.us',
  'spoofer.us', 'ps3cfw.com', 'bmwforum.co', 'blasze.com',
]);

export const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'rebrand.ly', 'rb.gy', 'cutt.ly', 'shorturl.at', 'is.gd',
  'ow.ly', 'goo.gl', 'buff.ly', 'tiny.cc', 'bl.ink', 's.id', 'v.gd', 'clck.ru', 't.ly', 'surl.li',
  'lnkd.in', 'mcaf.ee', 'su.pr', 'adf.ly', 'bc.vc', 'ouo.io', 'shrinke.me',
]);

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

/** Drop trailing . , ; : ! ? in linear time (an anchored regex retries at every position of a long run). */
function trimTrailingPunct(s: string): string {
  let end = s.length;
  while (end > 0 && '.,;:!?'.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
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
    const candidate = trimTrailingPunct(m[0]);
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

function isOpaqueShortTokenLink(link: Link): boolean {
  try {
    const u = new URL(link.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (u.search || u.hash) return false;
    if (!SHORT_TOKEN_PATH_RE.test(u.pathname) || !/\d/.test(u.pathname)) return false;
    return SHORT_CTA_TEXT_RE.test(link.text);
  } catch {
    return false;
  }
}

/** Extract numerical feature vector matching ml/src/phishml/features.py extract_features(). */
export function extractFeatures(sender: string, body: string, links: readonly Link[]): Record<string, number> {
  const lower = body.toLowerCase();
  const senderReg = registrableDomain(senderDomainOf(sender));
  let mismatch = 0;
  let ipLinks = 0;
  let punycode = 0;
  let cloudHtml = 0;
  let shortenerLinks = 0;
  let ipLoggerLinks = 0;
  let external = 0;
  for (const link of links) {
    const h = hostOf(link.href);
    const reg = registrableDomain(h);
    if (isIpHost(h)) ipLinks += 1;
    if (h.includes('xn--')) punycode += 1;
    if (isCloudHtmlLink(link.href)) cloudHtml += 1;
    if (IP_LOGGER_HOSTS.has(h) || IP_LOGGER_HOSTS.has(reg)) ipLoggerLinks += 1;
    else if (SHORTENER_HOSTS.has(h) || SHORTENER_HOSTS.has(reg)) shortenerLinks += 1;
    const shown = shownHost(link.text);
    if (shown && h && registrableDomain(shown) !== reg) mismatch += 1;
    if (senderReg && reg && reg !== senderReg) external += 1;
  }
  const urgencyHits = URGENCY.reduce((n, w) => n + lower.split(w).length - 1, 0);
  const codePointLen = [...body].length;
  return {
    n_links: links.length,
    n_text_href_mismatch: mismatch,
    n_ip_links: ipLinks,
    n_punycode_links: punycode,
    n_cloud_html_links: cloudHtml,
    n_shortener_links: shortenerLinks,
    n_iplogger_links: ipLoggerLinks,
    n_external_links: external,
    urgency_hits: urgencyHits,
    body_len: codePointLen,
  };
}

export const FEATURE_NAMES = Object.keys(extractFeatures('', '', []));

export function scoreEmail(sender: string, body: string, links: Link[]): Verdict {
  const reasons: string[] = [];
  let score = 0;
  const lower = body.toLowerCase();
  const senderReg = registrableDomain(senderDomainOf(sender));
  const hits = URGENCY.reduce((n, w) => n + lower.split(w).length - 1, 0);
  let hasExternalOrUnknownLink = false;
  let hasOpaqueUrgentShortToken = false;

  for (const l of links) {
    const h = hostOf(l.href);
    const reg = registrableDomain(h);
    const isExternal = Boolean(reg) && (!senderReg || reg !== senderReg);
    if (isExternal) hasExternalOrUnknownLink = true;
    if (isIpHost(h)) {
      score += 0.3;
      reasons.push('A link goes to a numeric web address instead of a real website');
    }
    if (h.includes('xn--')) {
      score += 0.3;
      reasons.push('A link uses lookalike characters in its web address');
    }
    if (isCloudHtmlLink(l.href)) {
      score += 0.4;
      reasons.push('A link points to a web page hosted on raw cloud storage');
    }
    if (IP_LOGGER_HOSTS.has(h) || IP_LOGGER_HOSTS.has(reg)) {
      score += 0.5;
      reasons.push(`A link uses a tracking/IP-logger service (${h}) that hides where it goes and logs your IP`);
    } else if ((SHORTENER_HOSTS.has(h) || SHORTENER_HOSTS.has(reg)) && isExternal) {
      score += 0.25;
      reasons.push(`A link uses a URL shortener (${h}) that hides its real destination`);
    } else if (isExternal && hits >= 2 && isOpaqueShortTokenLink(l)) {
      hasOpaqueUrgentShortToken = true;
    }
    const shown = shownHost(l.text);
    if (shown && h && registrableDomain(shown) !== reg) {
      score += 0.4;
      reasons.push(`A link says ${shown} but actually goes to ${h}`);
    }
  }
  if (hits >= 2) {
    score += 0.2;
    reasons.push('Uses urgent wording about passwords or your account');
  }
  if (hits >= 4 && hasExternalOrUnknownLink) {
    score += 0.15;
    reasons.push('Combines high-pressure account threats with an external verification link');
  }
  if (hasOpaqueUrgentShortToken) {
    score += 0.2;
    reasons.push('Urgent request uses a disguised short-code link whose destination is unclear');
  }
  score = Math.min(1, score);
  const level = score >= 0.6 ? 'likely-phishing' : score >= 0.3 ? 'suspicious' : 'safe';
  return { score, level, reasons: [...new Set(reasons)] };
}
