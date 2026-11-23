import { isIpHost, isValidDomain, registrableDomain } from './domain';
import { destinationIntelWarnings, type DomainIntel } from './domainIntel';
import { IP_LOGGER_HOSTS, isCloudHtmlLink, safePercentDecode, SHORTENER_HOSTS } from './features';

export { destinationIntelWarnings };

export interface LinkRisk {
  href: string;
  host: string;
  registrable: string;
  reasons: string[];
  level: 'safe' | 'warning' | 'danger';
  needsDomainCheck: boolean;
}

const MAX_UNWRAP_DEPTH = 4;

const DANGEROUS_EXT_RE =
  /\.(exe|msi|dmg|pkg|apk|iso|img|lnk|scr|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|hta|jar|mht|mhtml|docm|xlsm|pptm|svg)$/i;

/** Returns true strictly for valid http(s) URLs. */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Unwrap common redirect/tracking wrappers locally (up to 4 nested hops) to inspect the real http(s) target. */
export function unwrapRedirectUrl(href: string): string {
  let current = href;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    let next: string | null = null;
    try {
      const u = new URL(current);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') break;
      const host = u.hostname.toLowerCase().replace(/\.$/, '');
      if (host.endsWith('.safelinks.protection.outlook.com')) {
        next = u.searchParams.get('url');
      } else if ((host === 'www.google.com' || host === 'google.com') && u.pathname === '/url') {
        next = u.searchParams.get('q') ?? u.searchParams.get('url');
      } else if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && u.pathname === '/l.php') {
        next = u.searchParams.get('u');
      } else if ((host === 'www.youtube.com' || host === 'youtube.com') && u.pathname === '/redirect') {
        next = u.searchParams.get('q');
      }
    } catch {
      break;
    }
    if (!next || next === current || !isSafeHttpUrl(next)) break;
    current = next;
  }
  return current;
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
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (pageOrigin && u.origin === pageOrigin) {
    return { href, host, registrable: '', reasons: [], level: 'safe', needsDomainCheck: false };
  }

  const registrable = registrableDomain(host);
  const reasons: string[] = [];
  let hasDanger = false;
  let hasWarning = false;

  if (u.username || u.password) {
    hasDanger = true;
    reasons.push('This link uses a disguised address format (@) often used to fake a trusted website');
  }
  if (isIpHost(host)) {
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
  const path = safePercentDecode(u.pathname);
  const extMatch = path.match(DANGEROUS_EXT_RE);
  if (extMatch) {
    hasDanger = true;
    reasons.push(`This link leads directly to a risky file type (.${extMatch[1].toLowerCase()}) that can carry malware or hidden scripts`);
  }

  if (IP_LOGGER_HOSTS.has(host) || IP_LOGGER_HOSTS.has(registrable)) {
    hasDanger = true;
    reasons.push(
      `This link uses a tracking/IP-logger service (${host}) that captures your IP address and hides the real destination`,
    );
  } else if (SHORTENER_HOSTS.has(host) || SHORTENER_HOSTS.has(registrable)) {
    hasWarning = true;
    reasons.push(`This link uses a URL shortener (${host}) that hides where it really goes`);
  }
  if (u.protocol === 'http:') {
    hasWarning = true;
    reasons.push('This link uses an unencrypted connection (http:// instead of https://)');
  }

  const level = hasDanger ? 'danger' : hasWarning ? 'warning' : 'safe';
  const senderReg = senderRegistrable.trim().toLowerCase().replace(/\.$/, '');
  const needsDomainCheck =
    level === 'safe' && Boolean(registrable) && isValidDomain(registrable) && registrable !== senderReg;

  return { href, host, registrable, reasons, level, needsDomainCheck };
}

export function mergeLinkIntel(risk: LinkRisk, intel: DomainIntel | undefined, now = Date.now()): LinkRisk {
  if (!intel) return risk;
  const extra = destinationIntelWarnings(intel, now);
  if (extra.length === 0) return risk;
  const reasons = [...new Set([...risk.reasons, ...extra])];
  return { ...risk, reasons, level: 'danger' };
}
