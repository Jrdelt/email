import { ARCHIVE_EXTS, RISKY_DOWNLOAD_EXTS } from './attachments';
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

// Free hosting services where anyone can publish a site under a subdomain in seconds. The registrable domain of
// <site>.pages.dev is pages.dev, whose years-old, clean record says nothing about who runs the site, so a click is
// never cleared by that lookup: it goes to the warning page (with a way to continue), like a URL shortener.
const FREE_SITE_SUFFIXES = [
  'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'netlify.app', 'vercel.app', 'github.io', 'gitlab.io',
  'glitch.me', 'onrender.com', 'herokuapp.com', 'azurewebsites.net', 'azurestaticapps.net', 'blogspot.com',
  'weebly.com', 'wixsite.com', 'webflow.io', 'framer.app', 'surge.sh', 'replit.app', 'trycloudflare.com',
  'ngrok-free.app', 'ngrok.io', '000webhostapp.com', 'on.aws',
];

/** The free hosting service a host is a site on (never the service's own apex), or ''. */
const freeSiteSuffix = (host: string): string => FREE_SITE_SUFFIXES.find((s) => host.endsWith(`.${s}`)) ?? '';

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
 * benign first value must not be what gets inspected. Names are tried in order, skipping one whose values are all
 * empty or rejected by `isTarget` (Google search results carry "q=&url=<target>", or the search words in q=).
 * Several distinct usable values, under one name or several, mark the link as ambiguous.
 */
function redirectParam(
  u: URL,
  names: readonly string[],
  isTarget: (v: string) => boolean = () => true,
): { value: string | null; ambiguous: boolean } {
  let value: string | null = null;
  const seen = new Set<string>();
  for (const name of names) {
    const all = u.searchParams.getAll(name).map((v) => v.trim()).filter((v) => v !== '' && isTarget(v));
    if (!all.length) continue;
    value ??= all[all.length - 1]!;
    for (const v of all) seen.add(v);
  }
  return { value, ambiguous: seen.size > 1 };
}

// Google's own search domains (www.google.com/supported_domains). An explicit list, never a pattern: once a link is
// unwrapped only its target is checked, so a look-alike wrapper host (google.<a TLD anyone can register>) must not
// count as Google.
const GOOGLE_SUFFIXES = new Set(
  (
    'com ad ae com.af com.ag al am co.ao com.ar as at com.au az ba com.bd be bf bg com.bh bi bj com.bn com.bo com.br ' +
    'bs bt co.bw by com.bz ca cd cf cg ch ci co.ck cl cm cn com.co co.cr com.cu cv com.cy cz de dj dk dm com.do dz ' +
    'com.ec ee com.eg es com.et fi com.fj fm fr ga ge gg com.gh com.gi gl gm gr com.gt gy com.hk hn hr ht hu co.id ie ' +
    'co.il im co.in iq is it je com.jm jo co.jp co.ke com.kh ki kg co.kr com.kw kz la com.lb li lk co.ls lt lu lv ' +
    'com.ly co.ma md me mg mk ml com.mm mn com.mt mu mv mw com.mx com.my co.mz com.na com.ng com.ni ne nl no com.np nr ' +
    'nu co.nz com.om com.pa com.pe com.pg com.ph com.pk pl pn com.pr ps pt com.py com.qa ro ru rw com.sa com.sb sc se ' +
    'com.sg sh si sk com.sl sn so sm sr st com.sv td tg co.th com.tj tl tm tn to com.tr tt com.tw co.tz com.ua co.ug ' +
    'co.uk com.uy co.uz com.vc co.ve co.vi com.vn vu ws rs co.za co.zm co.zw cat'
  ).split(' '),
);
const isGoogleHost = (host: string): boolean => {
  const bare = host.startsWith('www.') ? host.slice(4) : host;
  return bare.startsWith('google.') && GOOGLE_SUFFIXES.has(bare.slice(7));
};
const BING_HOSTS = new Set(['www.bing.com', 'bing.com', 'cn.bing.com']);

/** UTF-8 text of an unpadded base64url string; throws when it is not valid base64 or UTF-8. */
function decodeBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Bing's click tracker /ck/a: u=a1<base64url target>. A target it cannot decode makes the link ambiguous. */
function decodeBingClick(u: URL): { next: string | null; ambiguous: boolean } {
  const p = redirectParam(u, ['u']);
  if (p.value === null) return { next: null, ambiguous: false };
  if (!p.value.startsWith('a1')) return { next: null, ambiguous: true };
  try {
    return { next: decodeBase64Url(p.value.slice(2)), ambiguous: p.ambiguous };
  } catch {
    return { next: null, ambiguous: true };
  }
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
  if (isGoogleHost(host) && path === '/url') return toNext(redirectParam(u, ['q', 'url'], isSafeHttpUrl));
  if (isGoogleHost(host) && path.startsWith('/amp/')) {
    // Google AMP viewer: /amp/s/<host>/<path> is https://<host>/<path>, /amp/<host>/<path> is http.
    const rest = path.slice(5);
    if (!rest || rest === 's/') return { next: null, ambiguous: false };
    return { next: (rest.startsWith('s/') ? `https://${rest.slice(2)}` : `http://${rest}`) + u.search, ambiguous: false };
  }
  if (BING_HOSTS.has(host) && path === '/ck/a') return decodeBingClick(u);
  if ((host === 'l.facebook.com' || host === 'lm.facebook.com') && path === '/l.php') return toNext(redirectParam(u, ['u']));
  if ((host === 'www.youtube.com' || host === 'youtube.com') && path === '/redirect') return toNext(redirectParam(u, ['q']));
  if (host === 'linkprotect.cudasvc.com' && path === '/url') return toNext(redirectParam(u, ['a'])); // Barracuda
  if (host === 'urldefense.proofpoint.com' && path === '/v2/url') {
    // Proofpoint v2: u=https-3A__www.example.com_path  ('-XX' = %XX, '_' = '/')
    const p = redirectParam(u, ['u']);
    const decoded = p.value === null ? null : safeDecode(p.value.replace(/_/g, '/').replace(/-([0-9a-f]{2})/gi, '%$1'));
    return { next: decoded, ambiguous: p.ambiguous };
  }
  if (host === 'urldefense.com' && path.startsWith('/v3/__')) return decodeProofpointV3(current);
  if (host === 'secure-web.cisco.com') {
    // Cisco Secure Email: the original URL is the percent-encoded last path segment.
    const seg = path.slice(path.lastIndexOf('/') + 1);
    return { next: seg ? safeDecode(seg) : null, ambiguous: false };
  }
  return { next: null, ambiguous: false };
}

// Proofpoint v3 run lengths: '**X' stands for (index of X here) + 2 characters from the token.
const V3_RUN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Proofpoint URL Defense v3: https://urldefense.com/v3/__<url>__;<token>!<signature>$. Each '*' in the (percent-
 * decoded) URL stands for the next character of the base64url UTF-8 token and '**X' for a run of them, so a host or
 * path is never cut short at the first '*'. A token that cannot supply every character makes the link ambiguous.
 */
function decodeProofpointV3(current: string): { next: string | null; ambiguous: boolean } {
  const fail = { next: null, ambiguous: true };
  const inner = current.slice(current.indexOf('/v3/__') + 6);
  const end = inner.indexOf('__;');
  if (end <= 0) return fail;
  const url = safeDecode(inner.slice(0, end));
  if (!url.includes('*')) return { next: url, ambiguous: false };
  const rest = inner.slice(end + 3);
  const token = rest.slice(0, rest.includes('!') ? rest.indexOf('!') : rest.length);
  let chars: string[];
  try {
    chars = Array.from(decodeBase64Url(token));
  } catch {
    return fail;
  }
  let used = 0;
  let out = '';
  for (let i = 0; i < url.length; i++) {
    if (url[i] !== '*') {
      out += url[i];
      continue;
    }
    let len = 1;
    if (url[i + 1] === '*') {
      const run = V3_RUN_ALPHABET.indexOf(url[i + 2] ?? '');
      if (run < 0) return fail;
      len = run + 2;
      i += 2;
    }
    if (used + len > chars.length) return fail;
    out += chars.slice(used, used + len).join('');
    used += len;
  }
  return { next: out, ambiguous: false };
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
    ambiguous ||= step.ambiguous; // includes a wrapper whose target could not be decoded
    const next = step.next?.trim() ?? null;
    if (!next || next === current || !isSafeHttpUrl(next)) return { href: current, ambiguous };
    current = next;
  }
  // Out of hops while still inside a known wrapper: the real target is unchecked, so never treat it as the wrapper.
  try {
    const more = unwrapOnce(current).next?.trim();
    if (more && more !== current && isSafeHttpUrl(more)) ambiguous = true;
  } catch {
    /* not a wrapper */
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
  } else if (ext && ARCHIVE_EXTS.has(ext)) {
    // Same file as an attachment carries an archive warning; as a link it goes to the warning page (which still
    // lets the user continue) instead of downloading straight away.
    hasWarning = true;
    reasons.push(`This link downloads an archive (.${ext}), a common way to deliver malware`);
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
  const freeSite = freeSiteSuffix(host);
  if (freeSite) {
    hasWarning = true;
    reasons.push(
      `This link goes to a site on a free hosting service (${freeSite}): anyone can publish there, so who runs it can't be checked`,
    );
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
