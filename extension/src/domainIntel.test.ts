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
});
