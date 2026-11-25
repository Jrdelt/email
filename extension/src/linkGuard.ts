import { RISKY_DOWNLOAD_EXTS } from './attachments';
import { isIpHost, isLookupDomain, registrableDomain } from './domain';
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
/** Lifetime of a link-warning (warn:*) session entry; shared by background.ts and warning.html. */
export const WARN_TTL_MS = 3600_000;

const PATH_EXT_RE = /\.([a-z0-9-]{1,20})$/i;

/** Returns true strictly for valid http(s) URLs. */
export function isSafeHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The value a redirector actually follows: Google /url and Facebook l.php use the LAST duplicate parameter, so a
 * benign first value must not be what gets inspected. Several distinct values mark the link as ambiguous.
 */
function redirectParam(u: URL, names: readonly string[]): { value: string | null; ambiguous: boolean } {
  for (const name of names) {
    const all = u.searchParams.getAll(name);
    if (all.length) return { value: all[all.length - 1]!, ambiguous: new Set(all).size > 1 };
  }
  return { value: null, ambiguous: false };
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** One unwrapping step for a known redirect or enterprise link-rewriting wrapper (all decoded locally). */
function unwrapOnce(current: string): { next: string | null; ambiguous: boolean } {
  const u = new URL(current);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { next: null, ambiguous: false };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const path = u.pathname;
  if (host.endsWith('.safelinks.protection.outlook.com')) return toNext(redirectParam(u, ['url']));
  if ((host === 'www.google.com' || host === 'google.com') && path === '/url') return toNext(redirectParam(u, ['q', 'url']));
  if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && path === '/l.php') return toNext(redirectParam(u, ['u']));
  if ((host === 'www.youtube.com' || host === 'youtube.com') && path === '/redirect') return toNext(redirectParam(u, ['q']));
  if (host === 'linkprotect.cudasvc.com' && path === '/url') return toNext(redirectParam(u, ['a'])); // Barracuda
  if (host === 'urldefense.proofpoint.com' && path === '/v2/url') {
    // Proofpoint v2: u=https-3A__www.example.com_path  ('-XX' = %XX, '_' = '/')
    const p = redirectParam(u, ['u']);
    const decoded = p.value === null ? null : safeDecode(p.value.replace(/_/g, '/').replace(/-([0-9a-f]{2})/gi, '%$1'));
    return { next: decoded, ambiguous: p.ambiguous };
  }
  if (host === 'urldefense.com' && path.startsWith('/v3/__')) {
    // Proofpoint v3: https://urldefense.com/v3/__<url>__;<token>$  ('*' marks characters moved into the token)
    const inner = current.slice(current.indexOf('/v3/__') + 6);
    const end = inner.indexOf('__;');
    if (end <= 0) return { next: null, ambiguous: false };
    const url = inner.slice(0, end);
    return { next: url.includes('*') ? url.slice(0, url.indexOf('*')) : url, ambiguous: false };
  }
  if (host === 'secure-web.cisco.com') {
    // Cisco Secure Email: the original URL is the percent-encoded last path segment.
    const seg = path.slice(path.lastIndexOf('/') + 1);
    return { next: seg ? safeDecode(seg) : null, ambiguous: false };
  }
  return { next: null, ambiguous: false };
}

function toNext(p: { value: string | null; ambiguous: boolean }): { next: string | null; ambiguous: boolean } {
  return { next: p.value, ambiguous: p.ambiguous };
}

/**
 * Unwrap redirect/tracking wrappers and enterprise link-rewriting gateways locally (up to 4 nested hops) to find
 * the real http(s) target. `ambiguous` is set when a wrapper carries several different targets.
 */
export function unwrapRedirect(href: string): { href: string; ambiguous: boolean } {
  let current = href;
  let ambiguous = false;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    let step: { next: string | null; ambiguous: boolean };
    try {
      step = unwrapOnce(current);
    } catch {
      break;
    }
    const next = step.next?.trim() ?? null;
    if (!next || next === current || !isSafeHttpUrl(next)) break;
    ambiguous ||= step.ambiguous;
    current = next;
  }
  return { href: current, ambiguous };
}

/** Unwrap redirect wrappers locally (see unwrapRedirect) and return the real http(s) target. */
export const unwrapRedirectUrl = (href: string): string => unwrapRedirect(href).href;

/** Analyze a clicked link destination locally and report whether online destination-domain intel is needed. */
export function analyzeLinkDestination(rawHref: string, senderRegistrable = '', pageOrigin = ''): LinkRisk {
  const { href, ambiguous } = unwrapRedirect(rawHref);
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
  const ext = path.match(PATH_EXT_RE)?.[1]?.toLowerCase() ?? '';
  if (ext && RISKY_DOWNLOAD_EXTS.has(ext)) {
    hasDanger = true;
    reasons.push(`This link leads directly to a risky file type (.${ext}) that can carry malware or hidden scripts`);
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
  if (ambiguous) {
    hasWarning = true;
    reasons.push('This link passes through a redirect that lists more than one destination');
  }

  const level = hasDanger ? 'danger' : hasWarning ? 'warning' : 'safe';
  const senderReg = senderRegistrable.trim().toLowerCase().replace(/\.$/, '');
  const needsDomainCheck =
    level === 'safe' && Boolean(registrable) && isLookupDomain(registrable) && registrable !== senderReg;

  return { href, host, registrable, reasons, level, needsDomainCheck };
}

export function mergeLinkIntel(risk: LinkRisk, intel: DomainIntel | undefined, now = Date.now()): LinkRisk {
  if (!intel) return risk;
  const extra = destinationIntelWarnings(intel, now);
  if (extra.length === 0) return risk;
  const reasons = [...new Set([...risk.reasons, ...extra])];
  return { ...risk, reasons, level: 'danger' };
}
