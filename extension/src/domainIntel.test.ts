import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getIntel, intelWarnings, lookupDomain, resetRdapBootstrap, type FetchFn } from './domainIntel';

beforeEach(() => resetRdapBootstrap());
import { memoryKV } from './storage';

const NOW = Date.parse('2026-11-22T00:00:00Z');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(opts: { registered?: string; urible?: string | null; uribleGoogle?: string; mx?: boolean; rdap404?: boolean; rdapTitle?: string } = {}): FetchFn {
  return vi.fn(async (url: string) => {
    const u = new URL(url);
    if (u.hostname === 'data.iana.org') return json({ services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']]] });
    if (u.hostname === 'rdap.verisign.com' || u.hostname === 'rdap.org') {
      if (opts.rdap404) return json(opts.rdapTitle ? { errorCode: 404, title: opts.rdapTitle } : {}, 404);
      return json({
        events: [{ eventAction: 'registration', eventDate: opts.registered ?? '2010-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }],
        entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Example Registrar']]] }],
        status: ['active'],
      });
    }
    const name = u.searchParams.get('name')!;
    const type = u.searchParams.get('type');
    if (name.endsWith('.multi.uribl.com')) {
      const ip = u.hostname === 'dns.google' && opts.uribleGoogle !== undefined ? opts.uribleGoogle : opts.urible;
      return ip ? json({ Status: 0, Answer: [{ type: 1, data: ip }] }) : json({ Status: 3 });
    }
    if (type === 'MX') return json({ Status: 0, Answer: opts.mx === false ? [] : [{ type: 15, data: '10 mx.example.com.' }] });
    if (name.startsWith('_dmarc.')) return json({ Status: 0, Answer: [{ type: 16, data: '"v=DMARC1; p=reject"' }] });
    return json({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 " "-all"' }] });
  }) as FetchFn;
}

describe('lookupDomain', () => {
  it('parses RDAP, DNS and URIBL', async () => {
    const i = await lookupDomain('example.com', fakeFetch(), NOW);
    expect(i.rdap).toMatchObject({ status: 'ok', registrar: 'Example Registrar', registered: '2010-01-01T00:00:00Z' });
    expect(i.dns).toMatchObject({ status: 'ok', mx: ['mx.example.com'], spf: 'v=spf1 -all', dmarcPolicy: 'reject' });
    expect(i.reputation).toEqual({ status: 'ok', source: 'URIBL', listed: [] });
    expect(intelWarnings(i, NOW)).toEqual([]);
  });
  it('warns on new, spam-listed, mail-less domains', async () => {
    const i = await lookupDomain('evil.example', fakeFetch({ registered: '2026-11-20T00:00:00Z', urible: '127.0.0.10', mx: false }), NOW);
    expect(i.reputation.listed).toEqual(['black', 'red']);
    const w = intelWarnings(i, NOW).join(' | ');
    expect(w).toMatch(/brand new \(2 days old\)/);
    expect(w).toMatch(/reported for spam online/);
    expect(w).toMatch(/not set up to send normal email/);
  });
  it('uses the registry from IANA bootstrap for known TLDs, rdap.org otherwise', async () => {
    const f = fakeFetch();
    await lookupDomain('example.com', f, NOW);
    await lookupDomain('example.xyz', f, NOW);
    const urls = (f as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(urls).toContain('https://rdap.verisign.com/com/v1/domain/example.com');
    expect(urls).toContain('https://rdap.org/domain/example.xyz');
    expect(urls.filter((u: string) => u.includes('data.iana.org'))).toHaveLength(1); // bootstrap fetched once
  });
  it('falls back to dns.google when Cloudflare is refused by URIBL', async () => {
    const i = await lookupDomain('evil.example', fakeFetch({ urible: '127.0.0.1', uribleGoogle: '127.0.0.2' }), NOW);
    expect(i.reputation).toEqual({ status: 'ok', source: 'URIBL', listed: ['black'] });
  });
  it('treats URIBL 127.0.0.1 from both resolvers as refused, not listed', async () => {
    const i = await lookupDomain('example.com', fakeFetch({ urible: '127.0.0.1' }), NOW);
    expect(i.reputation.status).toBe('refused');
    expect(intelWarnings(i, NOW)).toEqual([]);
  });
  it('unregistered domain on supported TLD', async () => {
    const i = await lookupDomain('nope.com', fakeFetch({ rdap404: true, mx: false }), NOW);
    expect(i.rdap.status).toBe('notfound');
    expect(intelWarnings(i, NOW)[0]).toMatch(/not registered/);
  });
  it('unsupported TLD RDAP 404 (e.g. .io) does not falsely warn not registered', async () => {
    const i = await lookupDomain(
      'interviewing.io',
      fakeFetch({ rdap404: true, rdapTitle: 'No RDAP service is available for this resource' }),
      NOW,
    );
    expect(i.rdap.status).toBe('unsupported');
    expect(intelWarnings(i, NOW)).toEqual([]);
  });
  it('flags NXDOMAIN on DNS even when RDAP TLD is unsupported (e.g. .itl)', async () => {
    const nxFetch: FetchFn = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'data.iana.org') return json({ services: [] });
      if (u.hostname === 'rdap.org') return json({ errorCode: 404, title: 'No RDAP service is available for this resource' }, 404);
      const name = u.searchParams.get('name')!;
      if (name.endsWith('.multi.uribl.com')) return json({ Status: 3 });
      return json({ Status: 3 });
    }) as FetchFn;
    const i = await lookupDomain('nozfr.itl', nxFetch, NOW);
    expect(i.rdap.status).toBe('unsupported');
    expect(i.dns.nxdomain).toBe(true);
    expect(intelWarnings(i, NOW)).toContain("The sender's website (nozfr.itl) does not exist");
  });
  it('network failure degrades to error states, never throws', async () => {
    const i = await lookupDomain('example.com', (async () => { throw new Error('offline'); }) as FetchFn, NOW);
    expect([i.rdap.status, i.dns.status, i.reputation.status]).toEqual(['error', 'error', 'error']);
  });
  it('refuses invalid domains (never builds a URL from junk)', async () => {
    await expect(lookupDomain('evil.com/../x', fakeFetch(), NOW)).rejects.toThrow();
  });
  it('sends only the domain', async () => {
    const f = fakeFetch();
    await lookupDomain('example.com', f, NOW);
    for (const [url] of (f as any).mock.calls) expect(String(url)).not.toMatch(/@/);
  });
  it('treats DNS SERVFAIL (Status: 2) as error instead of warning that MX is missing', async () => {
    const servfailFetch: FetchFn = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'data.iana.org') return json({ services: [] });
      if (u.hostname === 'rdap.org') {
        return json({ events: [{ eventAction: 'registration', eventDate: '2015-01-01T00:00:00Z' }] });
      }
      if (u.searchParams.get('name')?.endsWith('.multi.uribl.com')) return json({ Status: 3 });
      return json({ Status: 2 }); // SERVFAIL
    }) as FetchFn;
    const i = await lookupDomain('example.org', servfailFetch, NOW);
    expect(i.dns.status).toBe('error');
    expect(intelWarnings(i, NOW)).toEqual([]);
  });
  it('falls back to rdap.org when an authoritative TLD RDAP server fails CORS/network, and rejects unsafe bootstrap URLs', async () => {
    const fallbackFetch: FetchFn = vi.fn(async (url: string) => {
      const u = new URL(url);
      if (u.hostname === 'data.iana.org') {
        return json({
          services: [
            [['com'], ['https://rdap.broken-cors.example/v1/']],
            [['org'], ['http://insecure.example/rdap/', 'https://127.0.0.1/rdap/']],
          ],
        });
      }
      if (u.hostname === 'rdap.broken-cors.example') throw new TypeError('Failed to fetch');
      if (u.hostname === 'rdap.org') {
        return json({ events: [{ eventAction: 'registration', eventDate: '2012-05-01T00:00:00Z' }] });
      }
      if (u.searchParams.get('name')?.endsWith('.multi.uribl.com')) return json({ Status: 3 });
      return json({ Status: 0, Answer: [{ type: 15, data: '10 mx.example.com.' }] });
    }) as FetchFn;

    const comIntel = await lookupDomain('example.com', fallbackFetch, NOW);
    expect(comIntel.rdap).toMatchObject({ status: 'ok', registered: '2012-05-01T00:00:00Z' });

    const orgIntel = await lookupDomain('example.org', fallbackFetch, NOW);
    expect(orgIntel.rdap).toMatchObject({ status: 'ok', registered: '2012-05-01T00:00:00Z' });
    const calledUrls = (fallbackFetch as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(calledUrls.some((u: string) => u.startsWith('http://') || u.includes('127.0.0.1'))).toBe(false);
  });
  it('ignores non-127.0.0.x captive-portal IPs returned for URIBL queries', async () => {
    const i = await lookupDomain('example.com', fakeFetch({ urible: '198.51.100.42' }), NOW);
    expect(i.reputation).toEqual({ status: 'error', source: 'URIBL', listed: [] });
    expect(intelWarnings(i, NOW)).toEqual([]);
  });
});

describe('getIntel cache', () => {
  it('caches for 24h', async () => {
    const kv = memoryKV();
    const f = fakeFetch();
    const lookups = () => (f as any).mock.calls.filter((c: any[]) => !String(c[0]).includes('data.iana.org')).length;
    await getIntel(kv, 'example.com', f, NOW);
    const calls = lookups();
    await getIntel(kv, 'example.com', f, NOW + 3600_000);
    expect(lookups()).toBe(calls);
    await getIntel(kv, 'example.com', f, NOW + 25 * 3600_000);
    expect(lookups()).toBe(calls * 2);
  });
  it('does not cache total failures', async () => {
    const kv = memoryKV();
    await getIntel(kv, 'example.com', (async () => { throw new Error('x'); }) as FetchFn, NOW);
    expect((await kv.get('domainIntelCache')).domainIntelCache).toBeUndefined();
  });
  it('preserves both entries when two getIntel lookups resolve concurrently', async () => {
    const kv = memoryKV();
    const f = fakeFetch();
    await Promise.all([getIntel(kv, 'alpha.com', f, NOW), getIntel(kv, 'beta.com', f, NOW)]);
    const cached = (await kv.get('domainIntelCache')).domainIntelCache as Record<string, unknown>;
    expect(Object.keys(cached).sort()).toEqual(['alpha.com', 'beta.com']);
  });
});
