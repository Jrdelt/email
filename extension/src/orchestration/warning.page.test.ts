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
