// Online domain lookups. ONLY the sender's registrable domain is ever sent — never email content,
// addresses or URLs. Runs in the background script, results cached 24 h. Every lookup is best-effort.
//   RDAP (registry found via IANA bootstrap data.iana.org; rdap.org fallback): registration date, expiry, registrar
//   DNS-over-HTTPS (cloudflare-dns.com):  MX, SPF, DMARC
//   URIBL via DNS-over-HTTPS (Cloudflare, dns.google if refused): whether the domain has been reported in spam
import { isValidDomain } from './domain';
import type { KV } from './storage';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type Status = 'ok' | 'error';

export interface DomainIntel {
  domain: string;
  checkedAt: string;
  rdap: { status: Status | 'notfound'; registered?: string; expires?: string; registrar?: string; flags?: string[] };
  dns: { status: Status; mx: string[]; spf?: string; dmarc?: string; dmarcPolicy?: string };
  reputation: { status: Status | 'refused'; source: 'URIBL'; listed: string[] };
}

const TIMEOUT_MS = 5000;
const CACHE_KEY = 'domainIntelCache';
const TTL_MS = 24 * 3600 * 1000;
const MAX_CACHE = 200;
const DOH = { cloudflare: 'https://cloudflare-dns.com/dns-query', google: 'https://dns.google/resolve' } as const;
const IANA_RDAP = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_KEY = 'rdapBootstrap';
const BOOTSTRAP_TTL_MS = 7 * 24 * 3600 * 1000;

async function getJson(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS), credentials: 'omit', referrerPolicy: 'no-referrer' });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

interface DohAnswer { type: number; data: string }
async function doh(fetchFn: FetchFn, name: string, type: 'A' | 'MX' | 'TXT', via: keyof typeof DOH = 'cloudflare'): Promise<{ status: number; answers: DohAnswer[] }> {
  const { body } = await getJson(fetchFn, `${DOH[via]}?name=${encodeURIComponent(name)}&type=${type}`, { accept: 'application/dns-json' });
  if (!body) throw new Error('doh failed');
  return { status: body.Status, answers: body.Answer ?? [] };
}
const txt = (a: DohAnswer[]) => a.filter((x) => x.type === 16).map((x) => x.data.replace(/"\s*"/g, '').replace(/^"|"$/g, ''));

let bootstrapMemo: { at: number; map: Record<string, string> } | undefined;

/** TLD -> registry RDAP base URL, from IANA's bootstrap file (cached 7 days in memory and storage). */
export async function rdapBaseFor(fetchFn: FetchFn, tld: string, kv?: KV, now = Date.now()): Promise<string | undefined> {
  if (!bootstrapMemo && kv) bootstrapMemo = (await kv.get(BOOTSTRAP_KEY))[BOOTSTRAP_KEY] as typeof bootstrapMemo;
  if (!bootstrapMemo || now - bootstrapMemo.at > BOOTSTRAP_TTL_MS) {
    try {
      const { body } = await getJson(fetchFn, IANA_RDAP);
      const map: Record<string, string> = {};
      for (const [tlds, urls] of (body?.services ?? []) as [string[], string[]][]) {
        const https = urls.find((u) => u.startsWith('https://'));
        if (https) for (const t of tlds) map[t.toLowerCase()] = https.endsWith('/') ? https : `${https}/`;
      }
      if (Object.keys(map).length) {
        bootstrapMemo = { at: now, map };
        await kv?.set({ [BOOTSTRAP_KEY]: bootstrapMemo });
      }
    } catch { /* fall through to rdap.org */ }
  }
  return bootstrapMemo?.map[tld];
}

/** Test hook. */
export const resetRdapBootstrap = () => { bootstrapMemo = undefined; };

export async function lookupRdap(fetchFn: FetchFn, domain: string, kv?: KV, now = Date.now()): Promise<DomainIntel['rdap']> {
  try {
    const base = await rdapBaseFor(fetchFn, domain.split('.').pop()!, kv, now);
    const url = `${base ?? 'https://rdap.org/'}domain/${encodeURIComponent(domain)}`;
    const { status, body } = await getJson(fetchFn, url, { accept: 'application/rdap+json' });
    if (status === 404) return { status: 'notfound' };
    if (!body) return { status: 'error' };
    const ev = (a: string) => (body.events ?? []).find((e: any) => e.eventAction === a)?.eventDate as string | undefined;
    const reg = (body.entities ?? []).find((e: any) => (e.roles ?? []).includes('registrar'));
    const fn = reg?.vcardArray?.[1]?.find((v: any[]) => v[0] === 'fn')?.[3];
    return { status: 'ok', registered: ev('registration'), expires: ev('expiration'), registrar: typeof fn === 'string' ? fn : undefined, flags: body.status };
  } catch { return { status: 'error' }; }
}

export async function lookupDns(fetchFn: FetchFn, domain: string): Promise<DomainIntel['dns']> {
  try {
    const [mx, root, dmarc] = await Promise.all([doh(fetchFn, domain, 'MX'), doh(fetchFn, domain, 'TXT'), doh(fetchFn, `_dmarc.${domain}`, 'TXT')]);
    const spf = txt(root.answers).find((t) => t.toLowerCase().startsWith('v=spf1'));
    const dm = txt(dmarc.answers).find((t) => t.toLowerCase().startsWith('v=dmarc1'));
    return {
      status: 'ok',
      mx: mx.answers.filter((a) => a.type === 15).map((a) => a.data.split(' ').pop()!.replace(/\.$/, '')),
      spf,
      dmarc: dm,
      dmarcPolicy: dm?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase(),
    };
  } catch { return { status: 'error', mx: [] }; }
}

/**
 * URIBL multi: NXDOMAIN = not listed; 127.0.0.1 = query refused (URIBL limits public resolvers);
 * otherwise bitmask 2=black, 4=grey, 8=red. Tries Cloudflare, then dns.google if refused or failed.
 */
export async function lookupReputation(fetchFn: FetchFn, domain: string): Promise<DomainIntel['reputation']> {
  const first = await uribl(fetchFn, domain, 'cloudflare');
  return first.status === 'ok' ? first : uribl(fetchFn, domain, 'google');
}

async function uribl(fetchFn: FetchFn, domain: string, via: keyof typeof DOH): Promise<DomainIntel['reputation']> {
  try {
    const r = await doh(fetchFn, `${domain}.multi.uribl.com`, 'A', via);
    if (r.status === 3) return { status: 'ok', source: 'URIBL', listed: [] };
    const ip = r.answers.find((a) => a.type === 1)?.data;
    if (!ip) return { status: r.status === 0 ? 'ok' : 'error', source: 'URIBL', listed: [] };
    if (ip === '127.0.0.1') return { status: 'refused', source: 'URIBL', listed: [] };
    const bits = Number(ip.split('.').pop());
    const listed = [[2, 'black'], [4, 'grey'], [8, 'red']].filter(([bit]) => bits & (bit as number)).map(([, n]) => n as string);
    return { status: 'ok', source: 'URIBL', listed };
  } catch { return { status: 'error', source: 'URIBL', listed: [] }; }
}

export async function lookupDomain(domain: string, fetchFn: FetchFn, now = Date.now(), kv?: KV): Promise<DomainIntel> {
  if (!isValidDomain(domain)) throw new Error('invalid domain');
  const [rdap, dns, reputation] = await Promise.all([lookupRdap(fetchFn, domain, kv, now), lookupDns(fetchFn, domain), lookupReputation(fetchFn, domain)]);
  return { domain, checkedAt: new Date(now).toISOString(), rdap, dns, reputation };
}

/** Cached lookup (24 h, newest 200 domains). Results where every lookup failed are not cached. */
export async function getIntel(kv: KV, domain: string, fetchFn: FetchFn, now = Date.now()): Promise<DomainIntel> {
  const cache = ((await kv.get(CACHE_KEY))[CACHE_KEY] ?? {}) as Record<string, DomainIntel>;
  const hit = cache[domain];
  if (hit && now - Date.parse(hit.checkedAt) < TTL_MS) return hit;
  const intel = await lookupDomain(domain, fetchFn, now, kv);
  if (intel.rdap.status !== 'error' || intel.dns.status !== 'error' || intel.reputation.status !== 'error') {
    const entries = Object.entries({ ...cache, [domain]: intel }).sort((a, b) => b[1].checkedAt.localeCompare(a[1].checkedAt)).slice(0, MAX_CACHE);
    await kv.set({ [CACHE_KEY]: Object.fromEntries(entries) });
  }
  return intel;
}

export const ageDays = (iso: string | undefined, now = Date.now()) => (iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : undefined);

/** Warnings derived from lookups. Missing DMARC/SPF is shown in details but not warned (too common). */
export function intelWarnings(i: DomainIntel, now = Date.now()): string[] {
  const w: string[] = [];
  const age = ageDays(i.rdap.registered, now);
  if (age !== undefined && age < 30) w.push(`The sender's website (${i.domain}) is brand new (${age} day${age === 1 ? '' : 's'} old)`);
  if (i.rdap.status === 'notfound') w.push(`The sender's website (${i.domain}) is not registered`);
  if (i.reputation.listed.some((l) => l === 'black' || l === 'red')) w.push(`The sender's website (${i.domain}) has been reported for spam online`);
  if (i.dns.status === 'ok' && i.dns.mx.length === 0) w.push(`The sender's website (${i.domain}) is not set up to send normal email`);
  return w;
}
