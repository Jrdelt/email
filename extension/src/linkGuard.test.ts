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
    for (const ext of ['exe', 'dmg', 'svg', 'hta', 'lnk', 'iso', 'docm', 'mhtml', 'jar', 'rdp', 'iqy', 'searchConnector-ms']) {
      const risk = analyzeLinkDestination(`https://cdn.example.com/files/doc.${ext}`);
      expect(risk.level).toBe('danger');
      expect(risk.reasons.join(' ')).toContain(`.${ext.toLowerCase()}`);
    }
    const wrapped = analyzeLinkDestination('https://www.google.com/url?q=https%3A%2F%2Fevil.example%2Fpayload.svg');
    expect(wrapped.level).toBe('danger');
    expect(wrapped.href).toBe('https://evil.example/payload.svg');
  });

  it('sends archive downloads (.zip, .rar, .7z...) to the warning page instead of opening them', () => {
    for (const ext of ['zip', 'rar', '7z', 'tgz', 'cab']) {
      const r = analyzeLinkDestination(`https://evil.example/files/Invoice_7781.${ext}`, 'attacker.example');
      expect(r.level).toBe('warning');
      expect(r.reasons.join(' ')).toContain(`archive (.${ext})`);
      expect(r.needsDomainCheck).toBe(false);
    }
    // Upper case and percent-encoded dots in the path still count; the query string does not.
    expect(analyzeLinkDestination('https://evil.example/files/INVOICE%2EZIP').level).toBe('warning');
    expect(analyzeLinkDestination('https://shop.example.com/search?q=a.zip').level).toBe('safe');
    // IIS ISAPI web apps are served as /app.dll?...: a .dll path is not treated as a risky download.
    expect(analyzeLinkDestination('https://portal.example.com/scripts/app.dll?login').level).toBe('safe');
    // A risky type inside a wrapped link still wins over the archive warning.
    expect(analyzeLinkDestination('https://cdn.example.com/files/setup.exe').level).toBe('danger');
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
    // .mail is permanently undelegated by ICANN with .corp and .home (name collision): on-prem Exchange uses it.
    for (const d of ['hospital.lan', 'ehr.corp', 'printer.local', 'svc.internal', 'x.onion', 'hospital.mail', 'ehr.hospital.mail']) {
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

  it("decodes Proofpoint v3 '*' and '**X' tokens instead of cutting the URL at the first '*'", () => {
    const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // 'é' and '+' moved into the token; '**B' is a run of 3 characters.
    const href = `https://urldefense.com/v3/__https://caf*.example/a*b/**Bx__;${b64('é+xyz')}!!sig$`;
    expect(unwrapRedirectUrl(href)).toBe('https://café.example/a+b/xyzx');
    const r = analyzeLinkDestination(href, 'shop.example');
    expect(r.host).toBe('xn--caf-dma.example');
    // A token that cannot supply the characters keeps the wrapper and marks the link ambiguous (a warning).
    const bad = analyzeLinkDestination('https://urldefense.com/v3/__https://pay*al.example/__;!!sig$', 'shop.example');
    expect(bad.level).not.toBe('safe');
  });

  it('never treats a wrapper as the destination when nesting exceeds the unwrap depth', () => {
    let href = 'http://192.168.4.20/login';
    for (let i = 0; i < 6; i++) href = `https://www.google.com/url?q=${encodeURIComponent(href)}`;
    const r = analyzeLinkDestination(href, 'shop.example');
    expect(r.level).not.toBe('safe');
  });
});

describe('Google /url with an empty or non-URL q=', () => {
  // Real search-result redirects carry q= empty (or the search words) and the target in url=; the first present name
  // used to win, so the destination checks saw www.google.com.
  it('falls through to url= and warns when q= and url= name different targets', () => {
    const exe = analyzeLinkDestination('https://www.google.com/url?q=&url=https%3A%2F%2Fevil.example%2Fpayload.exe', 'shop.example');
    expect(exe.host).toBe('evil.example');
    expect(exe.level).toBe('danger');
    expect(exe.reasons.join(' ')).toMatch(/risky file type \(\.exe\)/);
    expect(
      unwrapRedirectUrl('https://www.google.com/url?sa=t&rct=j&q=&esrc=s&source=web&cd=1&url=https://evil.example/login&usg=x'),
    ).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://www.google.com/url?sa=t&q=invoice+portal&url=https%3A%2F%2Fevil.example%2F')).toBe(
      'https://evil.example/',
    );
    const both = analyzeLinkDestination(
      'https://www.google.com/url?q=https%3A%2F%2Fpaypal.com%2F&url=https%3A%2F%2Fevil.example%2Flogin',
      'shop.example',
    );
    expect(both.level).not.toBe('safe');
    expect(both.reasons.join(' ')).toMatch(/more than one destination/);
    // Same target in both: not ambiguous.
    const same = analyzeLinkDestination('https://www.google.com/url?q=https://shop.example/a&url=https://shop.example/a', 'shop.example');
    expect(same).toMatchObject({ host: 'shop.example', level: 'safe' });
  });
});

describe('redirectors that carry their target in the URL', () => {
  const b64 = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  it('unwraps Google /url on Google country domains', () => {
    expect(unwrapRedirectUrl('https://www.google.co.uk/url?q=https%3A%2F%2Fevil.example%2Flogin')).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://google.com.au/url?url=https://evil.example/login')).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://www.google.de/url?sa=t&q=&url=https://evil.example/x')).toBe('https://evil.example/x');
    // Not Google's: a look-alike wrapper host is never unwrapped (only its target would be checked).
    for (const fake of ['https://www.google.evil/url?q=https://shop.example/', 'https://google.co.zz/url?q=https://shop.example/',
      'https://www.google.com.evil.example/url?q=https://shop.example/']) {
      expect(unwrapRedirectUrl(fake)).toBe(fake);
    }
  });

  it('unwraps the Google AMP viewer', () => {
    expect(unwrapRedirectUrl('https://www.google.com/amp/s/evil.example/login')).toBe('https://evil.example/login');
    expect(unwrapRedirectUrl('https://www.google.co.uk/amp/s/evil.example/a/b?x=1')).toBe('https://evil.example/a/b?x=1');
    expect(unwrapRedirectUrl('https://www.google.com/amp/evil.example/page')).toBe('http://evil.example/page');
    const r = analyzeLinkDestination('https://www.google.com/amp/s/evil.example/invoice.exe', 'shop.example');
    expect(r).toMatchObject({ host: 'evil.example', level: 'danger' });
  });

  it("decodes Bing's /ck/a click tracker and fails closed on a target it cannot decode", () => {
    const href = `https://www.bing.com/ck/a?!&&p=1b2c3d&u=a1${b64('https://evil.example/login')}&ntb=1`;
    expect(unwrapRedirectUrl(href)).toBe('https://evil.example/login');
    const r = analyzeLinkDestination(href, 'shop.example');
    expect(r).toMatchObject({ host: 'evil.example', registrable: 'evil.example', needsDomainCheck: true });
    expect(unwrapRedirectUrl(`https://bing.com/ck/a?u=a1${b64('https://café.example/é')}`)).toBe('https://café.example/é');
    for (const bad of ['https://www.bing.com/ck/a?u=zz' + b64('https://evil.example/'), 'https://www.bing.com/ck/a?u=a1%%%%']) {
      const risk = analyzeLinkDestination(bad, 'shop.example');
      expect(risk.level, bad).not.toBe('safe');
      expect(risk.reasons.join(' ')).toMatch(/more than one destination|could not be read/);
    }
    // Without a u= target it is just a Bing page.
    expect(analyzeLinkDestination('https://www.bing.com/ck/a?p=1', 'shop.example').level).toBe('safe');
  });
});

describe('sites on free hosting services', () => {
  // The registrable domain of <anything>.pages.dev is pages.dev: its years-old, clean record used to vouch for every
  // site anyone publishes there, so the click opened silently.
  it.each([
    ['https://account-verify-demo.pages.dev/login', 'pages.dev'],
    ['https://m365-login-demo.web.app/', 'web.app'],
    ['https://demo-portal.firebaseapp.com/__/auth', 'firebaseapp.com'],
    ['https://docs-share-demo.netlify.app/a', 'netlify.app'],
    ['https://invoice-demo.vercel.app/', 'vercel.app'],
    ['https://someone.github.io/page', 'github.io'],
    ['https://w.someone.workers.dev/', 'workers.dev'],
    ['https://abc123.lambda-url.us-east-1.on.aws/', 'on.aws'],
    ['https://site-demo.blogspot.com/', 'blogspot.com'],
  ])('%s warns and does not look up the platform domain', (href, suffix) => {
    const r = analyzeLinkDestination(href, 'shop.example');
    expect(r.level).toBe('warning');
    expect(r.needsDomainCheck).toBe(false);
    expect(r.reasons.join(' ')).toContain(`free hosting service (${suffix})`);
  });
  it('leaves the platform itself and look-alike names alone', () => {
    for (const href of ['https://pages.dev/', 'https://evilpages.dev/x', 'https://pages.dev.shop-files.example/', 'https://github.com/a/b']) {
      expect(analyzeLinkDestination(href, 'shop.example').reasons.join(' '), href).not.toContain('free hosting');
    }
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
