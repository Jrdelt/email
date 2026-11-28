// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://extension.invalid/warning.html?id=w1"}
// warning.html shows the destination the click guard checked (behind any Safe Links / URL Defense wrapper). "Open
// anyway" must open the clicked gateway URL when the warn:* entry carries one that leads exactly there, so the
// organisation's time-of-click check, block page and click log still apply; the gateway URL itself is never shown
// (Safe Links data= can name the recipient). Any other stored `via` is ignored and the checked destination opens.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fakeBrowser, until } from './harness';

const DEST = 'http://news.example.org/offer';
const SAFE_LINKS = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(DEST)}&data=05%7C01%7Cpat%40corp.example%7C&reserved=0`;
const html = readFileSync(resolve(process.cwd(), 'entrypoints/warning/index.html'), 'utf8');

const replace = vi.fn();

beforeAll(async () => {
  fakeBrowser.reset();
  vi.stubGlobal('browser', fakeBrowser);
  document.body.innerHTML = html.slice(html.indexOf('<body>') + 6, html.indexOf('<script'));
  await fakeBrowser.storage.session.set({
    'warn:w1': {
      href: DEST,
      via: SAFE_LINKS,
      host: 'news.example.org',
      registrable: '', // no destination lookup in this test
      level: 'warning',
      reasons: ['This link uses an unencrypted connection (http:// instead of https://)'],
      createdAt: Date.now(),
    },
  });
  Object.defineProperty(window.location, 'replace', { configurable: true, value: replace });
  await import('../../entrypoints/warning/main');
  await until(() => expect(document.getElementById('proceed-btn')!.textContent).toContain('news.example.org'));
});

describe('warning.html: "Open anyway" for a link that went through Safe Links', () => {
  it('shows the checked destination, never the gateway URL', () => {
    expect(document.getElementById('dest-url')!.textContent).toBe(DEST);
    expect(document.body.textContent).not.toContain('safelinks');
    expect(document.body.textContent).not.toContain('pat@corp.example');
  });

  it('opens the gateway URL, which leads to that destination', async () => {
    document.getElementById('proceed-btn')!.click();
    await until(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(replace).toHaveBeenCalledWith(SAFE_LINKS);
    expect(await fakeBrowser.storage.session.get('warn:w1')).toEqual({});
  });
});
