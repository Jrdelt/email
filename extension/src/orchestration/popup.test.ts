// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://extension.invalid/popup.html"}
// The toolbar popup (entrypoints/popup/main.ts), booted for each case on the real page markup with WXT's fake
// browser. It shows the stored verdict of the active tab only when that tab is a supported webmail page (tab.url is
// only visible for host-permitted pages; anywhere else an old email's verdict must not be shown), and "Clear all
// local data" also removes the per-tab verdicts and link warnings in session storage (they hold sender details and
// clicked URLs).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeSender } from '../sender';
import { fakeBrowser, tick, until } from './harness';

const html = readFileSync(resolve(process.cwd(), 'entrypoints/popup/index.html'), 'utf8');
const BODY = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
const IDLE = 'Open an email to check it.';

const phishingState = () => ({
  verdict: { level: 'likely-phishing', score: 0.97, reasons: ['Asks you to verify your account urgently'] },
  sender: analyzeSender('PayPal', 'service@paypa1-alerts.example', []),
  trusted: false,
});

async function openPopup(tab: { id?: number; url?: string } | undefined, session: Record<string, unknown> = {}) {
  fakeBrowser.reset();
  vi.stubGlobal('browser', fakeBrowser);
  (fakeBrowser.tabs as unknown as { query: () => Promise<unknown[]> }).query = vi.fn(async () => (tab ? [tab] : []));
  await fakeBrowser.storage.session.set(session);
  document.body.innerHTML = BODY;
  vi.resetModules();
  await import('../../entrypoints/popup/main');
  // Rendered once the privacy note (always written) has its runtime text.
  await until(() => expect(document.getElementById('privacy-note')!.textContent).toContain('stay local'));
  await tick();
}

const out = () => document.getElementById('out')!.textContent ?? '';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('popup: the active tab verdict', () => {
  it('shows the stored verdict on a webmail tab', async () => {
    await openPopup({ id: 7, url: 'https://mail.google.com/mail/u/0/#inbox' }, { 'tab:7': phishingState() });
    expect(out()).toContain('Possible phishing.');
    expect(out()).toContain('Asks you to verify your account urgently');
  });

  it.each([
    ['another site', 'https://news.example.org/'],
    ['a look-alike host', 'https://mail.google.com.evil.example/'],
    ['no visible URL (no host permission)', undefined],
  ])('ignores a stored tab:<id> verdict on %s', async (_name, url) => {
    await openPopup({ id: 7, url }, { 'tab:7': phishingState() });
    expect(out()).toBe(IDLE);
    expect(document.getElementById('it-details')!.textContent).toBe('Open an email to view technical details.');
  });

  it('shows nothing when there is no active tab', async () => {
    await openPopup(undefined, { 'tab:7': phishingState() });
    expect(out()).toBe(IDLE);
  });
});

describe('popup: "Clear all local data"', () => {
  it('also removes every per-tab verdict and link warning, and only those, from session storage', async () => {
    await openPopup(
      { id: 7, url: 'https://news.example.org/' },
      { 'tab:7': phishingState(), 'warn:abc': { href: 'https://evil.example/' }, other: 1 },
    );
    document.getElementById('clear-all-data')!.click();
    await until(() => expect(document.getElementById('clear-all-status')!.textContent).toBe('All local data cleared.'));
    expect(await fakeBrowser.storage.session.get(null)).toEqual({ other: 1 });
  });
});
