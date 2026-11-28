// Domain helpers. registrableDomain uses a small built-in list of multi-part public suffixes
// instead of the full Public Suffix List (keeps the package small).
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.sg',
  'com.tr', 'co.kr', 'com.hk', 'com.tw', 'com.ar', 'co.id', 'com.my', 'com.ph', 'com.vn',
]);

// Generic second-level labels under 2-letter country TLDs (co.il, com.pl, org.br, ac.jp, gob.mx, ...) and the
// common CentralNic-style suffixes. Without them every domain under such a suffix collapses to the suffix itself,
// merging unrelated organisations. Mirrored in ml/src/phishml/features.py (parity).
const GENERIC_SLDS = new Set([
  'com', 'net', 'org', 'co', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'mil', 'nic', 'ltd', 'plc', 'sch', 'nom',
  'info', 'biz',
]);
const EXTRA_SUFFIXES = new Set([
  'us.com', 'uk.com', 'eu.com', 'ru.com', 'sa.com', 'za.com', 'br.com', 'cn.com', 'de.com', 'jpn.com', 'gb.net', 'uk.net',
]);

/** True when a two-label name is itself a public suffix (e.g. com.pl, co.il, us.com). */
export function isMultiPartSuffix(twoLabels: string): boolean {
  const dot = twoLabels.indexOf('.');
  if (dot <= 0 || twoLabels.indexOf('.', dot + 1) !== -1) return false;
  const [sld, tld] = [twoLabels.slice(0, dot), twoLabels.slice(dot + 1)];
  return MULTI_SUFFIXES.has(twoLabels) || EXTRA_SUFFIXES.has(twoLabels) || (tld.length === 2 && GENERIC_SLDS.has(sld));
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const IP_V4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** True for IPv4 dotted-quad or IPv6 literal hostnames (with or without outer brackets). */
export function isIpHost(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return IP_V4_RE.test(bare) || (bare.includes(':') && /^[0-9a-f:.]+$/i.test(bare));
}

/** True for a syntactically valid lowercase ASCII hostname (punycode allowed). Gate for every network lookup. */
export const isValidDomain = (d: string): boolean => d.length <= 253 && DOMAIN_RE.test(d);

// Private-use and special-use TLDs never resolve publicly, so looking them up can only leak intranet names
// (e.g. an EHR host on hospital.lan) to DNS/RDAP providers. RFC 2606 documentation names (.example, .test) are
// harmless and stay checkable. .mail, .corp and .home are permanently undelegated by ICANN (name-collision risk)
// and are common internal namespaces (on-prem Exchange: ehr.hospital.mail).
const PRIVATE_TLDS = new Set([
  'local', 'localhost', 'localdomain', 'lan', 'home', 'corp', 'mail', 'internal', 'intranet', 'private', 'arpa',
  'onion', 'alt', 'invalid',
]);

/** True when a domain may be sent for an online lookup: valid syntax and not on a private/special-use TLD. */
export const isLookupDomain = (d: string): boolean =>
  isValidDomain(d) && !PRIVATE_TLDS.has(d.slice(d.lastIndexOf('.') + 1));

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
  const n = isMultiPartSuffix(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}

/** Non-ASCII or punycode ("xn--") labels: often used for lookalike domains. */
export const isInternational = (domain: string): boolean =>
  /[^\x00-\x7f]/.test(domain) || /(^|\.)xn--/.test(domain);
