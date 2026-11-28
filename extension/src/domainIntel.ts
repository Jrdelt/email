// Online domain lookups. ONLY validated registrable domains (sender domains, and the destination domains of
// clicked external links and submitted forms) are ever sent — never email content, addresses, or full URLs.
// Runs in the background script, results cached 24 h. Every lookup is best-effort:
//   RDAP (registry found via IANA bootstrap data.iana.org; rdap.org fallback): registration date, expiry, registrar
//   DNS-over-HTTPS (cloudflare-dns.com): MX, SPF, DMARC, NXDOMAIN
// There is no spam-list (URIBL) lookup: URIBL refuses queries from public resolvers (Cloudflare, Google), so it
// answered "refused" for nearly every domain while the dns.google fallback received every looked-up domain.
import { isLookupDomain, isValidDomain } from './domain';
import type { KV } from './storage';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Status = 'ok' | 'error';

export interface DomainIntel {
  domain: string;
  checkedAt: string;
  rdap: { status: Status | 'notfound' | 'unsupported'; registered?: string; expires?: string; registrar?: string; flags?: string[] };
  dns: { status: Status; mx: string[]; spf?: string; dmarc?: string; dmarcPolicy?: string; nxdomain?: boolean };
}

const TIMEOUT_MS = 5000;
const CACHE_KEY = 'domainIntelCache';
const TTL_MS = 24 * 3600 * 1000;
// A partial result (RDAP or DNS failed, e.g. a registry rate limit) is retried soon: RDAP alone gives the
// "brand new domain" warning, and phishing domains are often used for less than a day.
const PARTIAL_TTL_MS = 15 * 60 * 1000;
const ttlOf = (i: DomainIntel): number =>
  i.rdap?.status === 'error' || i.dns?.status === 'error' ? PARTIAL_TTL_MS : TTL_MS;
const MAX_CACHE = 200;
const DOH = 'https://cloudflare-dns.com/dns-query';
const IANA_RDAP = 'https://data.iana.org/rdap/dns.json';
const RDAP_FALLBACK = 'https://rdap.org/';
const BOOTSTRAP_KEY = 'rdapBootstrap';
const BOOTSTRAP_TTL_MS = 7 * 24 * 3600 * 1000;
const LABEL_RE = /^[a-z0-9-]{1,63}$/;
// The sender's own DNS decides how many MX records and how long a TXT record it returns: only a bounded part is
// kept, so attacker-sized answers cannot fill storage.local (and stop later lookups from being cached).
const MAX_MX = 10;
const MAX_HOST = 253;
const MAX_TXT = 1024;
const MAX_REGISTRAR = 200;
const MAX_FLAGS = 20;
const MAX_FIELD = 64;
const clip = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' ? (v.length > max ? v.slice(0, max) : v) : undefined;

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetchFn(url, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });
  let body: any = null;
  if (res.ok || res.status === 404) {
    try { body = await res.json(); } catch { body = null; }
  }
  return { status: res.status, body };
}

function normalizeSafeRdapBase(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string' || !rawUrl.startsWith('https://')) return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash) return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!isValidDomain(host)) return null;
    const href = u.href;
    return href.endsWith('/') ? href : `${href}/`;
  } catch {
    return null;
  }
}

interface DohAnswer { type: number; data: string }
async function doh(fetchFn: FetchFn, name: string, type: 'MX' | 'TXT'): Promise<{ status: number; answers: DohAnswer[] }> {
  const { status, body } = await getJson(fetchFn, `${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { accept: 'application/dns-json' });
  if (status < 200 || status >= 300 || !body || typeof body.Status !== 'number') throw new Error('doh failed');
  return { status: body.Status, answers: Array.isArray(body.Answer) ? body.Answer : [] };
}

const txt = (a: DohAnswer[]) =>
  a.filter((x) => x.type === 16 && typeof x.data === 'string').map((x) => x.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''));

let bootstrapMemo: { at: number; map: Record<string, string> } | undefined;
let cacheWriteChain: Promise<void> = Promise.resolve();

/** TLD -> registry RDAP base URL, from IANA's bootstrap file (cached 7 days in memory and storage). */
export async function rdapBaseFor(fetchFn: FetchFn, tld: string, kv?: KV, now = Date.now()): Promise<string | undefined> {
  const key = tld.toLowerCase();
  if (!LABEL_RE.test(key)) return undefined;
  if (!bootstrapMemo && kv) {
    const stored = (await kv.get(BOOTSTRAP_KEY))[BOOTSTRAP_KEY] as { at?: unknown; map?: unknown } | undefined;
    if (stored && typeof stored.at === 'number' && stored.map && typeof stored.map === 'object') {
      const cleanMap = Object.create(null) as Record<string, string>;
      for (const [k, v] of Object.entries(stored.map as Record<string, unknown>)) {
        const safe = normalizeSafeRdapBase(v);
        if (LABEL_RE.test(k) && safe) cleanMap[k] = safe;
      }
      bootstrapMemo = { at: stored.at, map: cleanMap };
    }
  }
  if (!bootstrapMemo || now - bootstrapMemo.at > BOOTSTRAP_TTL_MS) {
    try {
      const { body } = await getJson(fetchFn, IANA_RDAP);
      const map = Object.create(null) as Record<string, string>;
      for (const entry of Array.isArray(body?.services) ? body.services : []) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [tlds, urls] = entry as [unknown, unknown];
        if (!Array.isArray(tlds) || !Array.isArray(urls)) continue;
        const safeBase = urls.map(normalizeSafeRdapBase).find((u): u is string => u !== null);
        if (!safeBase) continue;
        for (const t of tlds) {
          if (typeof t === 'string' && LABEL_RE.test(t.toLowerCase())) {
            map[t.toLowerCase()] = safeBase;
          }
        }
      }
      if (Object.keys(map).length > 0) {
        bootstrapMemo = { at: now, map };
        await kv?.set({ [BOOTSTRAP_KEY]: { at: now, map: { ...map } } });
      }
    } catch { /* fall through to rdap.org */ }
  }
  const map = bootstrapMemo?.map;
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

/** Test hook. */
export const resetRdapBootstrap = () => { bootstrapMemo = undefined; };

export async function lookupRdap(fetchFn: FetchFn, domain: string, kv?: KV, now = Date.now()): Promise<DomainIntel['rdap']> {
  try {
    const base = await rdapBaseFor(fetchFn, domain.split('.').pop()!, kv, now);
    const encoded = encodeURIComponent(domain);
    let usedBase = base;
    let resp: { status: number; body: any };
    try {
      resp = await getJson(fetchFn, `${base ?? RDAP_FALLBACK}domain/${encoded}`, { accept: 'application/rdap+json' });
    } catch (err) {
      // Retry via rdap.org when an authoritative TLD registry lacks CORS headers or fails network-side.
      if (!base) throw err;
      usedBase = undefined;
      resp = await getJson(fetchFn, `${RDAP_FALLBACK}domain/${encoded}`, { accept: 'application/rdap+json' });
    }
    const { status, body } = resp;
    if (status === 404) {
      const title = String(body?.title ?? '').toLowerCase();
      if (!usedBase || title.includes('no rdap service')) return { status: 'unsupported' };
      return { status: 'notfound' };
    }
    if (!body || status < 200 || status >= 300) return { status: 'error' };
    const ev = (a: string) => clip((body.events ?? []).find((e: any) => e.eventAction === a)?.eventDate, MAX_FIELD);
    const reg = (body.entities ?? []).find((e: any) => (e.roles ?? []).includes('registrar'));
    const fn = reg?.vcardArray?.[1]?.find((v: any[]) => v[0] === 'fn')?.[3];
    const flags = Array.isArray(body.status)
      ? body.status.filter((f: unknown): f is string => typeof f === 'string').slice(0, MAX_FLAGS).map((f: string) => clip(f, MAX_FIELD)!)
      : undefined;
    return { status: 'ok', registered: ev('registration'), expires: ev('expiration'), registrar: clip(fn, MAX_REGISTRAR), flags };
  } catch { return { status: 'error' }; }
}

export async function lookupDns(fetchFn: FetchFn, domain: string): Promise<DomainIntel['dns']> {
  try {
    const [mx, root, dmarc] = await Promise.all([
      doh(fetchFn, domain, 'MX'),
      doh(fetchFn, domain, 'TXT'),
      doh(fetchFn, `_dmarc.${domain}`, 'TXT'),
    ]);
    // Only NOERROR (0) and NXDOMAIN (3) are authoritative; SERVFAIL (2) / REFUSED (5) must not be cached as "no MX".
    if ((mx.status !== 0 && mx.status !== 3) || (root.status !== 0 && root.status !== 3)) {
      return { status: 'error', mx: [] };
    }
    const spf = clip(txt(root.answers).find((t) => t.toLowerCase().startsWith('v=spf1')), MAX_TXT);
    const dm = dmarc.status === 0 ? clip(txt(dmarc.answers).find((t) => t.toLowerCase().startsWith('v=dmarc1')), MAX_TXT) : undefined;
    return {
      status: 'ok',
      mx: mx.answers
        .filter((a) => a.type === 15 && typeof a.data === 'string')
        .map((a) => a.data.split(' ').pop()!.replace(/\.$/, ''))
        .filter((h) => h.length <= MAX_HOST)
        .slice(0, MAX_MX),
      spf,
      dmarc: dm,
      dmarcPolicy: dm?.match(/\bp=([a-z]{1,20})\b/i)?.[1]?.toLowerCase(),
      nxdomain: mx.status === 3 && root.status === 3,
    };
  } catch { return { status: 'error', mx: [] }; }
}

export async function lookupDomain(domain: string, fetchFn: FetchFn, now = Date.now(), kv?: KV): Promise<DomainIntel> {
  if (!isValidDomain(domain)) throw new Error('invalid domain');
  const [rdap, dns] = await Promise.all([lookupRdap(fetchFn, domain, kv, now), lookupDns(fetchFn, domain)]);
  return { domain, checkedAt: new Date(now).toISOString(), rdap, dns };
}

const isFresh = (k: string, v: unknown, now: number): v is DomainIntel =>
  isValidDomain(k) &&
  Boolean(v) &&
  typeof (v as DomainIntel).checkedAt === 'string' &&
  now - Date.parse((v as DomainIntel).checkedAt) < ttlOf(v as DomainIntel);

/**
 * Rewrite the cache without its expired entries (adding `add`, keeping the newest 200). Writes are serialized, and
 * nothing is written when there is nothing to add or delete.
 */
function writeCache(kv: KV, now: number, add?: DomainIntel): Promise<void> {
  const op = cacheWriteChain.then(async () => {
    const latestRaw = (await kv.get(CACHE_KEY))[CACHE_KEY];
    const merged = Object.create(null) as Record<string, DomainIntel>;
    let dropped = false;
    if (latestRaw && typeof latestRaw === 'object') {
      for (const [k, v] of Object.entries(latestRaw as Record<string, unknown>)) {
        if (isFresh(k, v, now)) merged[k] = v;
        else dropped = true;
      }
    }
    if (add) merged[add.domain] = add;
    else if (!dropped) return;
    const entries = Object.entries(merged)
      .sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt))
      .slice(0, MAX_CACHE);
    await kv.set({ [CACHE_KEY]: Object.fromEntries(entries) });
  });
  cacheWriteChain = op.catch(() => {});
  return op;
}

/**
 * Delete expired lookups (sender and clicked-link domains) from the cache. The background runs this when it
 * starts, so a cached domain is not kept past its 24 h (15 min) lifetime just because no new lookup happens.
 */
export const pruneIntelCache = (kv: KV, now = Date.now()): Promise<void> => writeCache(kv, now);

/** Cached lookup (24 h, newest 200 domains). Concurrent writes are serialized and expired entries pruned. */
export async function getIntel(kv: KV, domain: string, fetchFn: FetchFn, now = Date.now()): Promise<DomainIntel> {
  if (!isLookupDomain(domain)) throw new Error('invalid or private domain');
  const rawCache = (await kv.get(CACHE_KEY))[CACHE_KEY];
  if (rawCache && typeof rawCache === 'object' && Object.hasOwn(rawCache, domain)) {
    const hit = (rawCache as Record<string, unknown>)[domain];
    if (isFresh(domain, hit, now)) {
      const all = Object.entries(rawCache as Record<string, unknown>);
      if (all.some(([k, v]) => !isFresh(k, v, now))) await writeCache(kv, now).catch(() => {});
      return hit;
    }
  }
  const intel = await lookupDomain(domain, fetchFn, now, kv);
  // A failed cache write (e.g. storage quota) never discards a good result: the warnings still need it.
  if (intel.rdap.status !== 'error' || intel.dns.status !== 'error') await writeCache(kv, now, intel).catch(() => {});
  return intel;
}

export const ageDays = (iso: string | undefined, now = Date.now()) =>
  iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : undefined;

function buildDomainWarnings(
  i: DomainIntel,
  now: number,
  opts: { subject: string; checkMissingMx: boolean },
): string[] {
  const w: string[] = [];
  const age = ageDays(i.rdap.registered, now);
  if (age !== undefined && age < 30) {
    w.push(`${opts.subject} (${i.domain}) is brand new (${age} day${age === 1 ? '' : 's'} old)`);
  }
  if (i.dns.status === 'ok' && i.dns.nxdomain) {
    w.push(`${opts.subject} (${i.domain}) does not exist`);
  } else {
    if (i.rdap.status === 'notfound' && !(i.dns.status === 'ok' && i.dns.mx.length > 0)) {
      w.push(`${opts.subject} (${i.domain}) is not registered`);
    }
    if (opts.checkMissingMx && i.dns.status === 'ok' && i.dns.mx.length === 0) {
      w.push(`${opts.subject} (${i.domain}) is not set up to send normal email`);
    }
  }
  return w;
}

/** Sender-domain warnings derived from lookups. Missing DMARC/SPF is shown in details but not warned (too common). */
export const intelWarnings = (i: DomainIntel, now = Date.now()): string[] =>
  buildDomainWarnings(i, now, { subject: "The sender's website", checkMissingMx: true });

/** Destination-domain warnings for clicked links (ignores missing MX on web-only hosts). */
export const destinationIntelWarnings = (i: DomainIntel, now = Date.now()): string[] =>
  buildDomainWarnings(i, now, { subject: 'This destination website', checkMissingMx: false });
