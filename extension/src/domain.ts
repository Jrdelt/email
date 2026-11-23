// Domain helpers. registrableDomain uses a small built-in list of multi-part public suffixes
// instead of the full Public Suffix List (keeps the package small).
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.sg',
  'com.tr', 'co.kr', 'com.hk', 'com.tw', 'com.ar', 'co.id', 'com.my', 'com.ph', 'com.vn',
]);

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const IP_V4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True for IPv4 dotted-quad or IPv6 literal hostnames (with or without outer brackets). */
export function isIpHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return IP_V4_RE.test(bare) || (bare.includes(':') && /^[0-9a-f:.]+$/i.test(bare));
}

/** True for a syntactically valid lowercase ASCII hostname (punycode allowed). Gate for every network lookup. */
export const isValidDomain = (d: string): boolean => d.length <= 253 && DOMAIN_RE.test(d);

/** Normalized lowercase hostname for http(s) URLs (strips IPv6 brackets and trailing FQDN dot), or '' otherwise. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function registrableDomain(host: string): string {
  const cleaned = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!cleaned || isIpHost(cleaned)) return cleaned;
  const parts = cleaned.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = MULTI_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Non-ASCII or punycode ("xn--") labels: often used for lookalike domains. */
export const isInternational = (domain: string): boolean =>
  /[^\x00-\x7f]/.test(domain) || /(^|\.)xn--/.test(domain);
