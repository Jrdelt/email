// Online domain lookups. ONLY validated registrable domains (sender domains and clicked external
// link destination domains) are ever sent — never email content, addresses, or full URLs.
// Runs in the background script, results cached 24 h. Every lookup is best-effort:
//   RDAP (registry found via IANA bootstrap data.iana.org; rdap.org fallback): registration date, expiry, registrar
//   DNS-over-HTTPS (cloudflare-dns.com): MX, SPF, DMARC, NXDOMAIN
//   URIBL via DNS-over-HTTPS (Cloudflare, dns.google if refused): whether the domain has been reported in spam
import { isValidDomain } from './domain';
import type { KV } from './storage';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Status = 'ok' | 'error';

export interface DomainIntel {
  domain: string;
  checkedAt: string;
  rdap: { status: Status | 'notfound' | 'unsupported'; registered?: string; expires?: string; registrar?: string; flags?: string[] };
  dns: { status: Status; mx: string[]; spf?: string; dmarc?: string; dmarcPolicy?: string; nxdomain?: boolean };
  reputation: { status: Status | 'refused'; source: 'URIBL'; listed: string[] };
}

const TIMEOUT_MS = 5000;
const CACHE_KEY = 'domainIntelCache';
const TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 200;
const DOH = { cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/resolve' } as const;
const IANA_RDAP = 'https://data.iana.org/rdap/dns.json';
const RDAP_FALLBACK = 'https://rdap.org/';
const BOOTSTRAP_KEY = 'rdapBootstrap';
const BOOTSTRAP_TTL_MS = 7 * 24 * 3600 * 1000;
const LABEL_RE = /^[a-z0-9-]{1,63}$/;

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
async function doh(fetchFn: FetchFn, name: string, type: 'A' | 'MX' | 'TXT', via: keyof typeof DOH = 'cloudflare'): Promise<{ status: number; answers: DohAnswer[] }> {
  const { status, body } = await getJson(fetchFn, `${DOH[via]}?name=${encodeURIComponent(name)}&type=${type}`, { accept: 'application/dns-json' });
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
    const ev = (a: string) => (body.events ?? []).find((e: any) => e.eventAction === a)?.eventDate as string | undefined;
    const reg = (body.entities ?? []).find((e: any) => (e.roles ?? []).includes('registrar'));
    const fn = reg?.vcardArray?.[1]?.find((v: any[]) => v[0] === 'fn')?.[3];
    return { status: 'ok', registered: ev('registration'), expires: ev('expiration'), registrar: typeof fn === 'string' ? fn : undefined, flags: body.status };
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
    const spf = txt(root.answers).find((t) => t.toLowerCase().startsWith('v=spf1'));
    const dm = dmarc.status === 0 ? txt(dmarc.answers).find((t) => t.toLowerCase().startsWith('v=dmarc1')) : undefined;
    return {
      status: 'ok',
      mx: mx.answers
        .filter((a) => a.type === 15 && typeof a.data === 'string')
        .map((a) => a.data.split(' ').pop()!.replace(/\.$/, '')),
      spf,
      dmarc: dm,
      dmarcPolicy: dm?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase(),
      nxdomain: mx.status === 3 && root.status === 3,
    };
  } catch { return { status: 'error', mx: [] }; }
}

/**
 * URIBL multi: NXDOMAIN = not listed; 127.0.0.1 = query refused (URIBL limits public resolvers);
 * otherwise 127.0.0.x bitmask 2=black, 4=grey, 8=red. Tries Cloudflare, then dns.google if refused or failed.
 */
export async function lookupReputation(fetchFn: FetchFn, domain: string): Promise<DomainIntel['reputation']> {
  const first = await uribl(fetchFn, domain, 'cloudflare');
  return first.status === 'ok' ? first : uribl(fetchFn, domain, 'google');
}

async function uribl(fetchFn: FetchFn, domain: string, via: keyof typeof DOH): Promise<DomainIntel['reputation']> {
  try {
    const r = await doh(fetchFn, `${domain}.multi.uribl.com`, 'A', via);
    if (r.status === 3) return { status: 'ok', source: 'URIBL', listed: [] };
    const ip = r.answers.find((a) => a.type === 1 && typeof a.data === 'string')?.data;
    if (!ip) return { status: r.status === 0 ? 'ok' : 'error', source: 'URIBL', listed: [] };
    if (!ip.startsWith('127.0.0.')) return { status: 'error', source: 'URIBL', listed: [] };
    if (ip === '127.0.0.1') return { status: 'refused', source: 'URIBL', listed: [] };
    const bits = Number(ip.split('.').pop());
    if (!Number.isInteger(bits) || bits < 0 || bits > 255) return { status: 'error', source: 'URIBL', listed: [] };
    const listed = [[2, 'black'], [4, 'grey'], [8, 'red']]
      .filter(([bit]) => bits & (bit as number))
      .map(([, n]) => n as string);
    return { status: 'ok', source: 'URIBL', listed };
  } catch { return { status: 'error', source: 'URIBL', listed: [] }; }
}

export async function lookupDomain(domain: string, fetchFn: FetchFn, now = Date.now(), kv?: KV): Promise<DomainIntel> {
  if (!isValidDomain(domain)) throw new Error('invalid domain');
  const [rdap, dns, reputation] = await Promise.all([
    lookupRdap(fetchFn, domain, kv, now),
    lookupDns(fetchFn, domain),
    lookupReputation(fetchFn, domain),
  ]);
  return { domain, checkedAt: new Date(now).toISOString(), rdap, dns, reputation };
}

/** Cached lookup (24 h, newest 200 domains). Concurrent writes are serialized and expired entries pruned. */
export async function getIntel(kv: KV, domain: string, fetchFn: FetchFn, now = Date.now()): Promise<DomainIntel> {
  if (!isValidDomain(domain)) throw new Error('invalid domain');
  const rawCache = (await kv.get(CACHE_KEY))[CACHE_KEY];
  if (rawCache && typeof rawCache === 'object' && Object.hasOwn(rawCache, domain)) {
    const hit = (rawCache as Record<string, DomainIntel>)[domain];
    if (hit && typeof hit.checkedAt === 'string' && now - Date.parse(hit.checkedAt) < TTL_MS) return hit;
  }
  const intel = await lookupDomain(domain, fetchFn, now, kv);
  if (intel.rdap.status !== 'error' || intel.dns.status !== 'error' || intel.reputation.status !== 'error') {
    const writeOp = cacheWriteChain.then(async () => {
      const latestRaw = (await kv.get(CACHE_KEY))[CACHE_KEY];
      const merged = Object.create(null) as Record<string, DomainIntel>;
      if (latestRaw && typeof latestRaw === 'object') {
        for (const [k, v] of Object.entries(latestRaw as Record<string, DomainIntel>)) {
          if (!isValidDomain(k) || !v || typeof v.checkedAt !== 'string') continue;
          if (now - Date.parse(v.checkedAt) < TTL_MS) merged[k] = v;
        }
      }
      merged[domain] = intel;
      const entries = Object.entries(merged)
        .sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt))
        .slice(0, MAX_CACHE);
      await kv.set({ [CACHE_KEY]: Object.fromEntries(entries) });
    });
    cacheWriteChain = writeOp.catch(() => {});
    await writeOp;
  }
  return intel;
}

export const ageDays = (iso: string | undefined, now = Date.now()) =>
  iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : undefined;

function buildDomainWarnings(
  i: DomainIntel,
  now: number,
  opts: { subject: string; spamVerb: string; checkMissingMx: boolean },
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
  if (i.reputation.listed.some((l) => l === 'black' || l === 'red')) {
    w.push(`${opts.subject} (${i.domain}) has been reported for ${opts.spamVerb} online`);
  }
  return w;
}

/** Sender-domain warnings derived from lookups. Missing DMARC/SPF is shown in details but not warned (too common). */
export const intelWarnings = (i: DomainIntel, now = Date.now()): string[] =>
  buildDomainWarnings(i, now, { subject: "The sender's website", spamVerb: 'spam', checkMissingMx: true });

/** Destination-domain warnings for clicked links (ignores missing MX on web-only hosts). */
export const destinationIntelWarnings = (i: DomainIntel, now = Date.now()): string[] =>
  buildDomainWarnings(i, now, { subject: 'This destination website', spamVerb: 'spam or phishing', checkMissingMx: false });
