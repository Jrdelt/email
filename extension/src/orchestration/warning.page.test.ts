// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://extension.invalid/warning.html"}
// warning.html (entrypoints/warning/main.ts), booted for each case on the real page markup with WXT's fake browser:
// what it shows for a stored warn:* entry, which lookups it asks the background for, and what Back and "Open
// anyway" do. Each case re-imports main.ts (it renders once, at load) on a fresh copy of the page.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomainIntel } from '../domainIntel';
import { type Msg, fakeBrowser, tick, until } from './harness';

const html = readFileSync(resolve(process.cwd(), 'entrypoints/warning/index.html'), 'utf8');
const BODY = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));

interface Entry {
  href: string;
  host: string;
  registrable: string;
  level: 'warning' | 'danger';
  reasons: string[];
  intel?: DomainIntel;
  createdAt?: number;
}

const entry = (o: Partial<Entry> = {}): Entry => ({
  href: 'https://bit.ly/3xYz',
  host: 'bit.ly',
  registrable: 'bit.ly',
  level: 'warning',
  reasons: ['This link uses a URL shortener (bit.ly) that hides where it really goes'],
  createdAt: Date.now(),
  ...o,
});

const intel = (o: Partial<DomainIntel> = {}): DomainIntel => ({
  domain: 'bit.ly',
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: '2008-05-01T00:00:00Z', registrar: 'Example Registrar' },
  dns: { status: 'ok', mx: ['mx.bit.ly'] },
  reputation: { status: 'ok', source: 'URIBL', listed: [] },
  ...o,
});

const FAILED: Partial<DomainIntel> = {
  rdap: { status: 'error' },
  dns: { status: 'error', mx: [] },
  reputation: { status: 'error', source: 'URIBL', listed: [] },
};

const replace = vi.fn();
const text = (id: string) => document.getElementById(id)!.textContent ?? '';
const shown = (id: string) => !document.getElementById(id)!.hidden;

/**
 * Open warning.html?<query> with `stored` as its warn:w1 entry. Domain lookups (domainIntel messages) answer
 * `answer`; `strict` turns on Strict Local Mode. Resolves once the page has rendered (its title is set).
 */
async function openPage(
  stored: Entry | null,
  o: { query?: string; answer?: unknown; strict?: boolean } = {},
): Promise<{ sent: Msg[] }> {
  fakeBrowser.reset();
  vi.stubGlobal('browser', fakeBrowser);
  const sent: Msg[] = [];
  (fakeBrowser.runtime as unknown as { sendMessage: (m: Msg) => Promise<unknown> }).sendMessage = vi.fn(
    async (m: Msg) => {
      sent.push(m);
      return m.type === 'domainIntel' ? o.answer : undefined;
    },
  );
  if (stored) await fakeBrowser.storage.session.set({ 'warn:w1': stored });
  if (o.strict) await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } });
  history.replaceState(null, '', `/warning.html${o.query ?? '?id=w1'}`);
  document.title = '';
  document.body.innerHTML = BODY;
  replace.mockReset();
  Object.defineProperty(window.location, 'replace', { configurable: true, value: replace });
  vi.resetModules();
  await import('../../entrypoints/warning/main');
  await until(() => expect(document.title).not.toBe(''));
  await tick();
  return { sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('warning.html: the destination URL line', () => {
  // unwrapRedirect() percent-decodes the inner target of a wrapper such as google.com/url?q=, so the stored href can
  // hold a raw U+202E. Shown as-is it reverses the rest of the line: "http://evil.example/\u202emoc.lapyap.www//:sptth"
  // reads "http://evil.example/https://www.paypal.com", right where the page tells the user to verify the address.
  it('shows the URL as it is navigated to: bidi controls percent-encoded, not live', async () => {
    const href = 'http://evil.example/\u202emoc.lapyap.www//:sptth';
    await openPage(entry({ href, host: 'evil.example', registrable: 'evil.example' }), { answer: intel() });
    expect(text('dest-url')).toBe('http://evil.example/%E2%80%AEmoc.lapyap.www//:sptth');
    expect(text('dest-url')).not.toMatch(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
  });

  it('shows an ordinary URL unchanged', async () => {
    await openPage(entry({ href: 'https://bit.ly/3xYz' }), { answer: intel() });
    expect(text('dest-url')).toBe('https://bit.ly/3xYz');
  });
});

describe('warning.html: lookup answers in the meta line', () => {
  it('neutralises bidi controls in the registrar name a lookup returned', async () => {
    await openPage(entry(), { answer: intel({ rdap: { status: 'ok', registered: '2008-05-01T00:00:00Z', registrar: 'Good ‮Registrar' } }) });
    expect(text('dest-meta')).toContain('Registrar: Good �Registrar');
  });
});

describe('warning.html: which site the link opens', () => {
  // A brand-prefixed subdomain reads as the brand when only the full host is shown: the page must name the site
  // (the registrable domain) on its own, in the headline and in the "open anyway" button.
  const PHISH = entry({
    href: 'https://www.paypal.com.account-review.example/signin',
    host: 'www.paypal.com.account-review.example',
    registrable: 'account-review.example',
    level: 'danger',
    reasons: ['This destination website (account-review.example) is brand new (2 days old)'],
  });

  it('names the registrable domain in the headline, with the full host name under it', async () => {
    await openPage(PHISH, { answer: intel({ domain: 'account-review.example' }) });
    expect(text('dest-host')).toBe('account-review.example');
    expect(shown('dest-fullhost')).toBe(true);
    expect(text('dest-fullhost')).toBe('Full host name: www.paypal.com.account-review.example');
  });

  it('names the registrable domain in the "open anyway" button', async () => {
    await openPage(PHISH, { answer: intel({ domain: 'account-review.example' }) });
    expect(text('proceed-btn')).toBe('I understand the risk — open account-review.example');
  });

  it('shows no second host line when the host is the registrable domain', async () => {
    await openPage(entry(), { answer: intel() });
    expect(text('dest-host')).toBe('bit.ly');
    expect(shown('dest-fullhost')).toBe(false);
    expect(text('proceed-btn')).toBe('I understand the risk — open bit.ly');
  });

  it('falls back to the host when the entry has no registrable domain', async () => {
    await openPage(entry({ href: 'https://news.example.org/x', host: 'news.example.org', registrable: '' }));
    expect(text('dest-host')).toBe('news.example.org');
    expect(shown('dest-fullhost')).toBe(false);
    expect(text('proceed-btn')).toBe('I understand the risk — open news.example.org');
  });
});

describe('warning.html: when the destination lookups fail', () => {
  // Offline, behind a proxy that blocks the lookups, or a provider outage: every lookup answers 'error'. The page
  // must not say the domain was "checked" (read as a clean result) when nothing could be checked.
  it('says the details are unavailable when every lookup failed', async () => {
    await openPage(entry(), { answer: intel(FAILED) });
    expect(text('dest-meta')).not.toContain('checked');
    expect(text('dest-meta')).toBe('Domain details unavailable right now.');
  });

  it('says the same for failed lookups the click guard already made', async () => {
    await openPage(entry({ intel: intel(FAILED) }));
    expect(text('dest-meta')).toBe('Domain details unavailable right now.');
  });

  it('still says "checked" when a lookup succeeded but found nothing to report', async () => {
    await openPage(entry(), { answer: intel({ ...FAILED, dns: { status: 'ok', mx: [] } }) });
    expect(text('dest-meta')).toBe('Domain details checked.');
  });
});

describe('warning.html: domain age wording', () => {
  const day = 86_400_000;
  it('reads "Domain created today" / "Domain 2 days old", not "Registered created today"', async () => {
    await openPage(entry(), { answer: intel({ rdap: { status: 'ok', registered: new Date(Date.now() - 3600_000).toISOString() } }) });
    expect(text('dest-meta')).toMatch(/^Domain created today/);
    await openPage(entry(), { answer: intel({ rdap: { status: 'ok', registered: new Date(Date.now() - 2.5 * day).toISOString() } }) });
    expect(text('dest-meta')).toMatch(/^Domain 2 days old/);
    expect(text('dest-meta')).not.toContain('Registered');
  });
});

describe('warning.html: entries it must not act on', () => {
  const expiredView = () => {
    expect(text('title')).toBe('This warning link has expired');
    expect(shown('dest-box')).toBe(false);
    expect(shown('advanced-details')).toBe(false);
  };

  it('shows the expired view and removes an entry older than an hour', async () => {
    await openPage(entry({ createdAt: Date.now() - 3600_000 - 1000 }), { answer: intel() });
    expiredView();
    expect(await fakeBrowser.storage.session.get('warn:w1')).toEqual({});
  });

  it.each(['javascript:alert(document.domain)', 'data:text/html,<script>1</script>', 'file:///etc/passwd'])(
    'shows the expired view for a stored %s URL and offers no way to open it',
    async (href) => {
      const { sent } = await openPage(entry({ href }), { answer: intel() });
      expiredView();
      expect(document.body.textContent).not.toContain(href);
      expect(sent).toEqual([]);
    },
  );

  it('shows the expired view for a missing entry or no id, and the recovery guide in help mode', async () => {
    await openPage(null);
    expiredView();
    await openPage(entry(), { query: '' });
    expiredView();
    await openPage(entry(), { query: '?mode=help' });
    expect(text('title')).toBe('Clicked a suspicious link? Stay calm.');
    expect(shown('dest-box')).toBe(false);
    expect((document.getElementById('recovery-details') as HTMLDetailsElement).open).toBe(true);
  });
});

describe('warning.html: destination lookups', () => {
  it('asks the background about the registrable domain only', async () => {
    const { sent } = await openPage(
      entry({ href: 'https://login.bit.ly/a?b=c#d', host: 'login.bit.ly', registrable: 'bit.ly' }),
      { answer: intel() },
    );
    expect(sent).toEqual([{ type: 'domainIntel', domain: 'bit.ly' }]);
  });

  it('asks nothing in Strict Local Mode', async () => {
    const { sent } = await openPage(entry(), { answer: intel(), strict: true });
    expect(sent).toEqual([]);
    expect(text('dest-meta')).toBe('Domain lookup skipped (Strict Local Mode).');
  });

  it("treats the background's null answer as Strict Local Mode", async () => {
    await openPage(entry(), { answer: null });
    expect(text('dest-meta')).toBe('Domain lookup skipped (Strict Local Mode).');
    expect(text('title')).toBe('Check where this link goes');
  });

  it('asks nothing again when the click guard already looked the domain up', async () => {
    const { sent } = await openPage(entry({ intel: intel() }), { answer: intel() });
    expect(sent).toEqual([]);
    expect(text('dest-meta')).toContain('Not listed on URIBL');
  });

  it('escalates a "check link" warning to danger when the lookup finds a brand-new domain', async () => {
    await openPage(entry(), {
      answer: intel({ rdap: { status: 'ok', registered: new Date(Date.now() - 3600_000).toISOString() } }),
    });
    expect(text('title')).toBe('Dangerous link stopped');
    expect(text('sticker')).toBe('PHISHING RISK');
    expect(text('reasons')).toContain('This destination website (bit.ly) is brand new (0 days old)');
    expect(text('reasons')).toContain('URL shortener');
  });
});

describe('warning.html: Back and "Open anyway"', () => {
  it('Back removes the entry (it holds the clicked URL)', async () => {
    await openPage(entry(), { answer: intel() });
    document.getElementById('back-btn')!.click();
    await until(async () => expect(await fakeBrowser.storage.session.get('warn:w1')).toEqual({}));
    expect(replace).not.toHaveBeenCalled();
  });

  it('"Open anyway" removes the entry and opens the stored destination', async () => {
    await openPage(entry(), { answer: intel() });
    document.getElementById('proceed-btn')!.click();
    await until(() => expect(replace).toHaveBeenCalledWith('https://bit.ly/3xYz'));
    expect(await fakeBrowser.storage.session.get('warn:w1')).toEqual({});
  });
});
