import { isValidDomain, registrableDomain } from './domain';
import { ageDays, type DomainIntel } from './domainIntel';
import { isCloudHtmlLink } from './features';

export interface LinkRisk {
  href: string;
  host: string;
  registrable: string;
  reasons: string[];
  level: 'safe' | 'warning' | 'danger';
  needsDomainCheck: boolean;
}

const IP_HOST = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

const SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'rebrand.ly', 'rb.gy', 'cutt.ly', 'shorturl.at', 'is.gd',
  'ow.ly', 'goo.gl', 'buff.ly', 'tiny.cc', 'bl.ink', 's.id', 'v.gd', 'clck.ru',
]);

const DANGEROUS_EXT_RE = /\.(exe|msi|dmg|pkg|apk|iso|img|lnk|scr|bat|cmd|ps1|vbs|hta|svg)$/i;

/** Returns true strictly for valid http(s) URLs. */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Unwrap common redirect/tracking wrappers locally to inspect the real http(s) target. */
export function unwrapRedirectUrl(href: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return href;
    const host = u.hostname.toLowerCase();
    let target: string | null = null;
    if (host.endsWith('.safelinks.protection.outlook.com')) {
      target = u.searchParams.get('url');
    } else if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') {
      target = u.searchParams.get('q') ?? u.searchParams.get('url');
    } else if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && u.pathname === '/l.php') {
      target = u.searchParams.get('u');
    }
    if (target && isSafeHttpUrl(target)) return target;
  } catch { /* keep original href */ }
  return href;
}

/** Analyze a clicked link destination locally and report whether online destination-domain intel is needed. */
export function analyzeLinkDestination(rawHref: string, senderRegistrable = '', pageOrigin = ''): LinkRisk {
  const href = unwrapRedirectUrl(rawHref);
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { href: rawHref, host: '', registrable: '', reasons: [], level: 'safe', needsDomainCheck: false };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { href: rawHref, host: '', registrable: '', reasons: [], level: 'safe', needsDomainCheck: false };
  }
  if (pageOrigin && u.origin === pageOrigin) {
    return { href, host: u.hostname.toLowerCase(), registrable: '', reasons: [], level: 'safe', needsDomainCheck: false };
  }

  const host = u.hostname.toLowerCase();
  const registrable = registrableDomain(host);
  const reasons: string[] = [];
  let hasDanger = false;
  let hasWarning = false;

  if (u.username || u.password) {
    hasDanger = true;
    reasons.push('This link uses a disguised address format (@) often used to fake a trusted website');
  }
  if (IP_HOST.test(host)) {
    hasDanger = true;
    reasons.push('This link goes to a raw numeric web address instead of a real website');
  }
  if (host.includes('xn--')) {
    hasDanger = true;
    reasons.push('This link uses lookalike characters in its web address');
  }
  if (isCloudHtmlLink(href)) {
    hasDanger = true;
    reasons.push('This link points to a web page hosted on raw cloud storage (commonly abused in phishing)');
  }
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch { /* keep raw pathname */ }
  const extMatch = path.match(DANGEROUS_EXT_RE);
  if (extMatch) {
    hasDanger = true;
    reasons.push(`This link leads directly to a risky file type (.${extMatch[1].toLowerCase()}) that can carry malware or hidden scripts`);
  }

  if (SHORTENER_HOSTS.has(host) || SHORTENER_HOSTS.has(registrable)) {
    hasWarning = true;
    reasons.push(`This link uses a URL shortener (${host}) that hides where it really goes`);
  }
  if (u.protocol === 'http:') {
    hasWarning = true;
    reasons.push('This link uses an unencrypted connection (http:// instead of https://)');
  }

  const level = hasDanger ? 'danger' : hasWarning ? 'warning' : 'safe';
  const senderReg = senderRegistrable.trim().toLowerCase();
  const needsDomainCheck =
    level === 'safe' && Boolean(registrable) && isValidDomain(registrable) && registrable !== senderReg;

  return { href, host, registrable, reasons, level, needsDomainCheck };
}

/** Destination-appropriate domain warnings (intentionally ignores missing MX on web-only hosts). */
export function destinationIntelWarnings(intel: DomainIntel, now = Date.now()): string[] {
  const w: string[] = [];
  const age = ageDays(intel.rdap.registered, now);
  if (age !== undefined && age < 30) {
    w.push(`This destination website (${intel.domain}) is brand new (${age} day${age === 1 ? '' : 's'} old)`);
  }
  if (intel.dns.status === 'ok' && intel.dns.nxdomain) {
    w.push(`This destination website (${intel.domain}) does not exist`);
  } else if (intel.rdap.status === 'notfound' && !(intel.dns.status === 'ok' && intel.dns.mx.length > 0)) {
    w.push(`This destination website (${intel.domain}) is not registered`);
  }
  if (intel.reputation.listed.some((l) => l === 'black' || l === 'red')) {
    w.push(`This destination website (${intel.domain}) has been reported for spam or phishing online`);
  }
  return w;
}

export function mergeLinkIntel(risk: LinkRisk, intel: DomainIntel | undefined, now = Date.now()): LinkRisk {
  if (!intel) return risk;
  const extra = destinationIntelWarnings(intel, now);
  if (extra.length === 0) return risk;
  const reasons = [...new Set([...risk.reasons, ...extra])];
  return { ...risk, reasons, level: 'danger' };
}
