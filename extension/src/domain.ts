// Domain helpers. registrableDomain uses a small built-in list of multi-part public suffixes
// instead of the full Public Suffix List (keeps the package small). TODO: consider a trimmed PSL.
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.sg',
  'com.tr', 'co.kr', 'com.hk', 'com.tw', 'com.ar', 'co.id', 'com.my', 'com.ph', 'com.vn',
]);

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** True for a syntactically valid lowercase ASCII hostname (punycode allowed). Gate for every network lookup. */
export const isValidDomain = (d: string): boolean => d.length <= 253 && DOMAIN_RE.test(d);

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : '';
  } catch { return ''; }
}

export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const n = MULTI_SUFFIXES.has(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Non-ASCII or punycode ("xn--") labels: often used for lookalike domains. */
export const isInternational = (domain: string): boolean => /[^\x00-\x7f]/.test(domain) || /(^|\.)xn--/.test(domain);
