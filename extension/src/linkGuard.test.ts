import { describe, expect, it } from 'vitest';
import type { DomainIntel } from './domainIntel';
import {
  analyzeLinkDestination,
  destinationIntelWarnings,
  isSafeHttpUrl,
  mergeLinkIntel,
  unwrapRedirectUrl,
} from './linkGuard';

const NOW = Date.parse('2026-11-22T00:00:00Z');

describe('isSafeHttpUrl', () => {
  it('accepts http/https and rejects javascript, data, file, and chrome URLs', () => {
    expect(isSafeHttpUrl('https://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('http://example.com/a')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeHttpUrl('chrome://settings')).toBe(false);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
});

describe('unwrapRedirectUrl', () => {
  it('unwraps Outlook Safe Links, Google redirect, and Facebook redirect for http(s) targets', () => {
    expect(
      unwrapRedirectUrl('https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example%2Flogin'),
    ).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://www.google.com/url?q=https%3A%2F%2Fevil.example%2Fverify&sa=D')).toBe(
      'https://evil.example/verify',
    );
    expect(unwrapRedirectUrl('https://l.facebook.com/l.php?u=https%3A%2F%2Fevil.example%2Fa')).toBe(
      'https://evil.example/a',
    );
  });

  it('unwraps multi-hop redirect chains (Safe Links -> Google -> target) and handles trailing dots', () => {
    const inner = encodeURIComponent('https://www.google.com/url?q=https%3A%2F%2Fevil.example%2Fsteal.svg');
    expect(unwrapRedirectUrl(`https://nam04.safelinks.protection.outlook.com./?url=${inner}`)).toBe(
      'https://evil.example/steal.svg',
    );
  });

  it('ignores non-http(s) wrapped targets and leaves normal URLs alone', () => {
    const js = 'https://www.google.com/url?q=javascript%3Aalert(1)';
    expect(unwrapRedirectUrl(js)).toBe(js);
    expect(unwrapRedirectUrl('https://account.mongodb.com/reset')).toBe('https://account.mongodb.com/reset');
  });
});

describe('analyzeLinkDestination', () => {
  it('flags danger for @ credential disguises, IPv4/IPv6 literals, punycode, trailing-dot cloud HTML, and risky file extensions', () => {
    expect(analyzeLinkDestination('https://paypal.com@evil.example/login').level).toBe('danger');
    expect(analyzeLinkDestination('http://1.2.3.4/a').level).toBe('danger');
    expect(analyzeLinkDestination('http://[2001:db8::1]/login').level).toBe('danger');
    expect(analyzeLinkDestination('https://xn--pple-43d.com/verify').level).toBe('danger');
    expect(analyzeLinkDestination('https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl').level).toBe('danger');
    expect(analyzeLinkDestination('https://storage.googleapis.com./hmdbox/hmd_v2.html').level).toBe('danger');
    for (const ext of ['exe', 'dmg', 'svg', 'hta', 'lnk', 'iso', 'docm', 'mhtml', 'jar']) {
      const risk = analyzeLinkDestination(`https://cdn.example.com/files/doc.${ext}`);
      expect(risk.level).toBe('danger');
      expect(risk.reasons.join(' ')).toContain(`.${ext}`);
    }
    const wrapped = analyzeLinkDestination('https://www.google.com/url?q=https%3A%2F%2Fevil.example%2Fpayload.svg');
    expect(wrapped.level).toBe('danger');
    expect(wrapped.href).toBe('https://evil.example/payload.svg');
  });

  it('flags danger for IP-logger/Grabify links like urlto.me before opening', () => {
    const r = analyzeLinkDestination('https://urlto.me/2r7Nf');
    expect(r.level).toBe('danger');
    expect(r.needsDomainCheck).toBe(false);
    expect(r.reasons[0]).toContain('urlto.me');
  });

  it('flags warning for URL shorteners (including trailing-dot FQDNs) and unencrypted http links', () => {
    for (const u of ['https://bit.ly/3xyz', 'https://bit.ly./3xyz', 'https://rebrand.ly/abc']) {
      const r = analyzeLinkDestination(u);
      expect(r.level).toBe('warning');
      expect(r.needsDomainCheck).toBe(false);
    }
    const plainHttp = analyzeLinkDestination('http://example.com/login');
    expect(plainHttp.level).toBe('warning');
    expect(plainHttp.reasons[0]).toMatch(/unencrypted/i);
  });

  it('keeps benign links safe and scopes needsDomainCheck accurately', () => {
    const sameDomain = analyzeLinkDestination('https://account.mongodb.com/reset', 'mongodb.com', 'https://mail.google.com');
    expect(sameDomain.level).toBe('safe');
    expect(sameDomain.needsDomainCheck).toBe(false);

    const externalClean = analyzeLinkDestination('https://account.mongodb.com/reset', 'vendor.com', 'https://mail.google.com');
    expect(externalClean.level).toBe('safe');
    expect(externalClean.needsDomainCheck).toBe(true);

    expect(analyzeLinkDestination('https://storage.googleapis.com/assets/logo.png').level).toBe('safe');
    expect(analyzeLinkDestination('https://bucket.s3.amazonaws.com/invoice.pdf').level).toBe('safe');

    const sameOriginWebmail = analyzeLinkDestination('https://mail.google.com/mail/u/0/#inbox', 'google.com', 'https://mail.google.com');
    expect(sameOriginWebmail.level).toBe('safe');
    expect(sameOriginWebmail.needsDomainCheck).toBe(false);

    const mailto = analyzeLinkDestination('mailto:help@example.com');
    expect(mailto.level).toBe('safe');
    expect(mailto.needsDomainCheck).toBe(false);
  });
});

describe('mergeLinkIntel & destinationIntelWarnings', () => {
  const baseIntel = (overrides: Partial<DomainIntel> = {}): DomainIntel => ({
    domain: 'dest.example',
    checkedAt: '2026-11-22T00:00:00Z',
    rdap: { status: 'ok', registered: '2010-01-01T00:00:00Z' },
    dns: { status: 'ok', mx: ['mx.dest.example'] },
    reputation: { status: 'ok', source: 'URIBL', listed: [] },
    ...overrides,
  });

  it('upgrades to danger on brand-new (<30d), NXDOMAIN, notfound, or URIBL black/red destinations', () => {
    const base = analyzeLinkDestination('https://dest.example/login', 'sender.com');

    const brandNew = mergeLinkIntel(
      base,
      baseIntel({ rdap: { status: 'ok', registered: '2026-11-18T00:00:00Z' } }),
      NOW,
    );
    expect(brandNew.level).toBe('danger');
    expect(brandNew.reasons[0]).toMatch(/brand new \(4 days old\)/);

    const nx = mergeLinkIntel(base, baseIntel({ rdap: { status: 'unsupported' }, dns: { status: 'ok', mx: [], nxdomain: true } }), NOW);
    expect(nx.level).toBe('danger');
    expect(nx.reasons[0]).toMatch(/does not exist/);

    const notFound = mergeLinkIntel(base, baseIntel({ rdap: { status: 'notfound' }, dns: { status: 'ok', mx: [] } }), NOW);
    expect(notFound.level).toBe('danger');
    expect(notFound.reasons[0]).toMatch(/not registered/);

    const spam = mergeLinkIntel(base, baseIntel({ reputation: { status: 'ok', source: 'URIBL', listed: ['black'] } }), NOW);
    expect(spam.level).toBe('danger');
    expect(spam.reasons[0]).toMatch(/reported for spam or phishing/);
  });

  it('does not false-positive on web-only domains without MX records or unsupported RDAP TLDs', () => {
    const base = analyzeLinkDestination('https://app.interviewing.io/start', 'sender.com');
    const webOnly = baseIntel({
      domain: 'interviewing.io',
      rdap: { status: 'unsupported' },
      dns: { status: 'ok', mx: [], nxdomain: false },
    });
    expect(destinationIntelWarnings(webOnly, NOW)).toEqual([]);
    expect(mergeLinkIntel(base, webOnly, NOW).level).toBe('safe');
  });
});

describe('private-use domains are never looked up online', () => {
  it('does not request a domain check for intranet TLDs but still does for public ones', async () => {
    const { isLookupDomain } = await import('./domain');
    for (const d of ['hospital.lan', 'ehr.corp', 'printer.local', 'svc.internal', 'x.onion']) {
      expect(isLookupDomain(d)).toBe(false);
      expect(analyzeLinkDestination(`https://${d}/patient/123`).needsDomainCheck).toBe(false);
    }
    expect(isLookupDomain('evil.example')).toBe(true);
    expect(analyzeLinkDestination('https://shop.example.com/x').needsDomainCheck).toBe(true);
  });
});

describe('redirect wrappers', () => {
  it('follows the parameter the redirector uses and warns when targets conflict', () => {
    const href = 'https://www.google.com/url?q=https%3A%2F%2Fshop.example%2F&q=http%3A%2F%2F192.168.4.20%2Finvoice.exe';
    const r = analyzeLinkDestination(href, 'shop.example');
    expect(r.host).toBe('192.168.4.20');
    expect(r.level).toBe('danger');
    expect(r.reasons.join(' ')).toMatch(/more than one destination/);
  });

  it('unwraps enterprise link-rewriting gateways locally', () => {
    expect(unwrapRedirectUrl('https://urldefense.proofpoint.com/v2/url?u=https-3A__evil.example_login-3Fa-3D1&d=x&c=y')).toBe(
      'https://evil.example/login?a=1',
    );
    expect(unwrapRedirectUrl('https://urldefense.com/v3/__https://evil.example/login__;!!ABC$')).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://linkprotect.cudasvc.com/url?a=https%3A%2F%2Fevil.example%2Fx&c=E')).toBe('https://evil.example/x');
    expect(unwrapRedirectUrl('https://secure-web.cisco.com/1AbC/https%3A%2F%2Fevil.example%2Fy')).toBe('https://evil.example/y');
  });
});

describe('click-time risky download list', () => {
  it('covers the attachment danger types but not ordinary web pages', () => {
    for (const p of ['setup.exe', 'macro.dotm', 'reg.reg', 'x.cpl', 'note.one', 'disk.vhd', 'image.svg', 'a.ps1']) {
      expect(analyzeLinkDestination(`https://shop.example/${p}`, 'shop.example').level).toBe('danger');
    }
    expect(analyzeLinkDestination('https://shop.example/index.html', 'shop.example').level).toBe('safe');
  });
});
