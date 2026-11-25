// Orchestration tests for entrypoints/background.ts against WXT's in-memory fake browser. Each test boots a fresh
// copy of the background (vi.resetModules + fakeBrowser.reset(), which also drops the previous copy's listeners)
// and talks to it through runtime.onMessage / tabs / storage events exactly as the browser would.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GMAIL_URL, fakeBrowser, until } from './harness';

interface Sender {
  id?: string;
  tab?: { id?: number };
  frameId?: number;
  url?: string;
}

const NO_REPLY = Symbol('no reply');
const EXT_ID = fakeBrowser.runtime.id;
const ICLOUD_APP_URL = 'https://www.icloud.com/applications/mail2/current/en-us/index.html';
const ICLOUD_SANDBOX_URL = 'https://p55-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html';
// The only hosts docs/privacy.md allows the background to contact (registry RDAP servers come from the IANA
// bootstrap file, which these tests never serve).
const ALLOWED_LOOKUP_HOSTS = new Set(['data.iana.org', 'rdap.org', 'cloudflare-dns.com', 'dns.google']);

const gmailTop = (tabId = 7): Sender => ({ id: EXT_ID, tab: { id: tabId }, frameId: 0, url: GMAIL_URL });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0)); // fake storage settles in microtasks

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

async function boot(opts: { fetch?: Fetch } = {}) {
  vi.resetModules();
  fakeBrowser.reset();
  vi.stubGlobal('browser', fakeBrowser);
  vi.stubGlobal('defineBackground', (main: () => void) => main);
  const fetchSpy = vi.fn<Fetch>(opts.fetch ?? (async () => new Response('{}', { status: 404 })));
  vi.stubGlobal('fetch', fetchSpy);
  const tabsSend = vi.fn(async (..._args: unknown[]) => undefined);
  (fakeBrowser.tabs as unknown as { sendMessage: typeof tabsSend }).sendMessage = tabsSend;
  const createTab = vi.spyOn(fakeBrowser.tabs, 'create');
  const { default: main } = await import('../../entrypoints/background');
  (main as unknown as () => void)();
  await flush(); // let the boot-time Strict Local Mode read finish

  /** Deliver a runtime message; resolves to the reply, or NO_REPLY when the background does not answer. */
  const send = (msg: unknown, sender: Sender) =>
    new Promise<unknown>((resolve) => {
      const onMessage = fakeBrowser.runtime.onMessage as unknown as {
        trigger: (m: unknown, s: Sender, reply: (r: unknown) => void) => Promise<unknown[]>;
      };
      void onMessage.trigger(msg, sender, resolve).then((results) => {
        if (!results.includes(true)) resolve(NO_REPLY);
      });
    });
  return { send, fetchSpy, tabsSend, createTab };
}

const session = async (key: string): Promise<unknown> => (await fakeBrowser.storage.session.get(key))[key];
const local = async (key: string): Promise<unknown> => (await fakeBrowser.storage.local.get(key))[key];
const warnEntries = async () =>
  Object.entries(await fakeBrowser.storage.session.get(null)).filter(([k, v]) => k.startsWith('warn:') && v != null);

const tabUpdated = (tabId: number, changeInfo: { status?: string; url?: string }, tab: { url?: string } = {}) =>
  (fakeBrowser.tabs.onUpdated as unknown as { trigger: (...a: unknown[]) => Promise<unknown> }).trigger(
    tabId,
    changeInfo,
    { id: tabId, ...tab },
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('B1 Strict Local Mode gates every lookup before fetch', () => {
  it('answers null and never calls fetch when the user turned Strict Local Mode on', async () => {
    const { send, fetchSpy } = await boot();
    await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } });
    expect(await send({ type: 'domainIntel', domain: 'example.com' }, gmailTop())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await local('domainIntelCache')).toBeUndefined();
  });

  it('answers null and never calls fetch when an enterprise policy (storage.managed) enforces it', async () => {
    const { send, fetchSpy } = await boot();
    await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: false } });
    await fakeBrowser.storage.managed.set({ strictLocalMode: true });
    expect(await send({ type: 'domainIntel', domain: 'example.com' }, gmailTop())).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with Strict Local Mode off, reaches the lookup path and contacts only the documented hosts', async () => {
    const { send, fetchSpy } = await boot();
    const reply = await send({ type: 'domainIntel', domain: 'example.com' }, gmailTop());
    expect(reply).toMatchObject({ domain: 'example.com' });
    expect(fetchSpy).toHaveBeenCalled();
    for (const [url] of fetchSpy.mock.calls) {
      const u = new URL(url);
      expect(ALLOWED_LOOKUP_HOSTS.has(u.hostname), url).toBe(true);
      // Nothing but the registrable domain is sent (the IANA bootstrap file itself carries no domain).
      if (u.hostname !== 'data.iana.org') expect(decodeURIComponent(url), url).toContain('example.com');
    }
  });

  it('refuses non-registrable or URL-shaped domains without fetching', async () => {
    const { send, fetchSpy } = await boot();
    for (const domain of ['printer.local', 'https://example.com/path?q=secret', 'user@example.com', 42]) {
      expect(await send({ type: 'domainIntel', domain }, gmailTop())).toBe(NO_REPLY);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('turning Strict Local Mode on purges the lookup caches', async () => {
    const { send } = await boot();
    await fakeBrowser.storage.local.set({ domainIntelCache: { 'example.com': {} }, rdapBootstrap: { com: 'x' } });
    await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } });
    await until(async () => {
      expect(await local('domainIntelCache')).toBeUndefined();
      expect(await local('rdapBootstrap')).toBeUndefined();
    });
    expect(await send({ type: 'domainIntel', domain: 'example.com' }, gmailTop())).toBeNull();
  });

  it('a lookup already running when Strict Local Mode turns on sends no further requests and caches nothing', async () => {
    const held: (() => void)[] = [];
    const { send, fetchSpy } = await boot({
      fetch: () => new Promise((resolve) => held.push(() => resolve(new Response('{}', { status: 404 })))),
    });
    const reply = send({ type: 'domainIntel', domain: 'example.com' }, gmailTop());
    await until(() => expect(fetchSpy).toHaveBeenCalled());
    await fakeBrowser.storage.local.set({ privacySettings: { strictLocalMode: true } });
    await flush();
    const requestsBeforeStrict = fetchSpy.mock.calls.length;
    for (const release of held.splice(0)) release();
    expect(await reply).toBeNull();
    for (const release of held.splice(0)) release(); // nothing new should have been requested
    await flush();
    expect(fetchSpy.mock.calls.length).toBe(requestsBeforeStrict);
    expect(await local('domainIntelCache')).toBeUndefined();
  });
});

describe('B2 message validation', () => {
  it('stores a verdict only from the top frame of a supported webmail page, tagged with its origin', async () => {
    const { send } = await boot();
    await send({ type: 'verdict', payload: { level: 'danger' } }, { ...gmailTop(), frameId: 3 });
    await send({ type: 'verdict', payload: { level: 'danger' } }, { ...gmailTop(), url: 'https://evil.example/' });
    await send({ type: 'verdict', payload: { level: 'danger' } }, { ...gmailTop(), id: 'another-extension' });
    await flush();
    expect(await session('tab:7')).toBeUndefined();

    await send({ type: 'verdict', payload: { level: 'safe' } }, gmailTop());
    await until(async () =>
      expect(await session('tab:7')).toEqual({ level: 'safe', origin: 'https://mail.google.com' }),
    );
  });

  it('stores a verdict from the iCloud Mail app frame even though it is a subframe', async () => {
    const { send } = await boot();
    await send({ type: 'verdict', payload: { level: 'safe' } }, { id: EXT_ID, tab: { id: 4 }, frameId: 5, url: ICLOUD_APP_URL });
    await until(async () => expect(await session('tab:4')).toEqual({ level: 'safe', origin: 'https://www.icloud.com' }));
    // ...but not from an iCloud message (sandbox) frame.
    await send({ type: 'verdict', payload: { level: 'safe' } }, { id: EXT_ID, tab: { id: 5 }, frameId: 9, url: ICLOUD_SANDBOX_URL });
    await flush();
    expect(await session('tab:5')).toBeUndefined();
  });

  it('openSafeLink and openWarning never open a tab for javascript:/data: links or from unsupported pages', async () => {
    const { send, createTab } = await boot();
    for (const type of ['openSafeLink', 'openWarning']) {
      for (const href of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', ' JAVASCRIPT:alert(1)']) {
        expect(await send({ type, href, level: 'danger' }, gmailTop())).toBe(NO_REPLY);
      }
      expect(await send({ type, href: 'https://ok.example/' }, { ...gmailTop(), url: 'https://evil.example/' })).toBe(NO_REPLY);
      expect(await send({ type, href: 'https://ok.example/' }, { ...gmailTop(), tab: undefined })).toBe(NO_REPLY);
      expect(await send({ type, href: 'https://ok.example/' }, { ...gmailTop(), id: 'another-extension' })).toBe(NO_REPLY);
    }
    await flush();
    expect(createTab).not.toHaveBeenCalled();
    expect(await warnEntries()).toEqual([]);
  });

  it('openSafeLink opens a valid https link next to the webmail tab', async () => {
    const { send, createTab } = await boot();
    const tab = await send({ type: 'openSafeLink', href: 'https://ok.example/page', active: false }, gmailTop());
    expect(createTab).toHaveBeenCalledWith({ url: 'https://ok.example/page', active: false, openerTabId: 7 });
    expect(tab).toMatchObject({ url: 'https://ok.example/page' });
  });

  it('openWarning stores a sanitised warn:* entry and opens warning.html for it', async () => {
    const { send, createTab } = await boot();
    await send(
      {
        type: 'openWarning',
        href: 'https://evil.example/login',
        host: 'evil.example',
        registrable: 'evil.example',
        level: 'nonsense',
        reasons: ['Looks like a fake login page', 42, { html: '<b>x</b>' }],
      },
      gmailTop(),
    );
    expect(createTab).toHaveBeenCalledTimes(1);
    const { url } = createTab.mock.calls[0]![0] as { url: string };
    const id = new URL(url).searchParams.get('id');
    expect(url).toBe(`chrome-extension://${EXT_ID}/warning.html?id=${id}`);
    const entry = await session(`warn:${id}`);
    expect(entry).toMatchObject({
      href: 'https://evil.example/login',
      host: 'evil.example',
      registrable: 'evil.example',
      level: 'danger', // anything but 'warning' fails closed to 'danger'
      reasons: ['Looks like a fake login page'],
      warnTabId: expect.any(Number),
    });
  });
});

describe('B3 tabs.onUpdated keeps a verdict only for same-origin loads', () => {
  it('keeps tab:<id> for a same-origin load, ignores non-loading updates, drops it for another origin', async () => {
    const { send } = await boot();
    await send({ type: 'verdict', payload: { level: 'danger' } }, gmailTop(7));
    await until(async () => expect(await session('tab:7')).toMatchObject({ origin: 'https://mail.google.com' }));

    await tabUpdated(7, { status: 'loading', url: 'https://mail.google.com/mail/u/0/#inbox/FMfcgz' });
    await tabUpdated(7, { status: 'complete', url: 'https://evil.example/' });
    await flush();
    expect(await session('tab:7')).toMatchObject({ level: 'danger', origin: 'https://mail.google.com' });

    await tabUpdated(7, { status: 'loading', url: 'https://evil.example/' });
    await until(async () => expect(await session('tab:7')).toBeUndefined());
  });

  it('falls back to the tab URL when the update carries none, and onRemoved drops the verdict', async () => {
    const { send } = await boot();
    await send({ type: 'verdict', payload: { level: 'safe' } }, gmailTop(8));
    await send({ type: 'verdict', payload: { level: 'safe' } }, gmailTop(9));
    await until(async () => expect(await session('tab:9')).toBeDefined());

    await tabUpdated(8, { status: 'loading' }, { url: 'https://mail.google.com/mail/u/0/#sent' });
    await flush();
    expect(await session('tab:8')).toMatchObject({ origin: 'https://mail.google.com' });
    await tabUpdated(8, { status: 'loading' }, { url: 'https://outlook.live.com/mail/0/' });
    await until(async () => expect(await session('tab:8')).toBeUndefined());

    await (fakeBrowser.tabs.onRemoved as unknown as { trigger: (...a: unknown[]) => Promise<unknown> }).trigger(9, {});
    await until(async () => expect(await session('tab:9')).toBeUndefined());
  });
});

describe('B4 iCloud relays are stateless and trust only the browser-verified sender', () => {
  const sandbox = (frameId = 9): Sender => ({ id: EXT_ID, tab: { id: 4 }, frameId, url: ICLOUD_SANDBOX_URL });
  const app = (): Sender => ({ id: EXT_ID, tab: { id: 4 }, frameId: 2, url: ICLOUD_APP_URL });

  it('relays a message frame body to its tab with the verified frame id, capped and sanitised', async () => {
    const { send, tabsSend } = await boot();
    await send(
      {
        type: 'icloudBody',
        frameId: 0, // forged: the relay must use the sender's own frame id
        active: 1,
        body: 'x'.repeat(30_000),
        links: [{ text: 'Docs', href: 'https://docs.example/' }, 'junk', { text: 1, href: 'https://a.example/' }],
        attachmentNames: ['report.pdf', 7],
        sig: 'not-hex!',
      },
      sandbox(9),
    );
    expect(tabsSend).toHaveBeenCalledTimes(1);
    const [tabId, relayed] = tabsSend.mock.calls[0]! as [number, Record<string, unknown>];
    expect(tabId).toBe(4);
    expect(relayed).toMatchObject({
      type: 'icloudBody',
      frameId: 9,
      active: true,
      links: [{ text: 'Docs', href: 'https://docs.example/' }],
      linksTruncated: false,
      attachmentNames: ['report.pdf'],
    });
    expect((relayed.body as string).length).toBe(21_000);
    expect(relayed).not.toHaveProperty('sig');
  });

  it('relays icloudBody and icloudPair only from iCloud message frames', async () => {
    const { send, tabsSend } = await boot();
    const nonce = '0f8fad5b-d9cb-469f-a165-70867728950e';
    await send({ type: 'icloudBody', active: true, body: 'hi' }, gmailTop());
    await send({ type: 'icloudBody', active: true, body: 'hi' }, app());
    await send({ type: 'icloudPair', nonce }, app());
    await send({ type: 'icloudPair', nonce: 'not-a-uuid' }, sandbox());
    expect(tabsSend).not.toHaveBeenCalled();

    await send({ type: 'icloudPair', nonce, frameId: 1 }, sandbox(11));
    expect(tabsSend).toHaveBeenCalledWith(4, { type: 'icloudPair', nonce, frameId: 11 });
  });

  it('relays lock decisions only from the iCloud app frame, to valid frame ids only', async () => {
    const { send, tabsSend } = await boot();
    await send({ type: 'icloudLock', locked: false, frameIds: [9] }, sandbox(12)); // a message frame cannot unlock others
    await send({ type: 'icloudLock', locked: false, frameIds: [9] }, gmailTop());
    expect(tabsSend).not.toHaveBeenCalled();

    await send({ type: 'icloudLock', locked: 1, attachmentsLocked: 0, frameIds: [9, -1, 1.5, '3', 12], sig: 'abc123' }, app());
    expect(tabsSend.mock.calls).toEqual([
      [4, { type: 'icloudLock', locked: true, attachmentsLocked: false, sig: 'abc123' }, { frameId: 9 }],
      [4, { type: 'icloudLock', locked: true, attachmentsLocked: false, sig: 'abc123' }, { frameId: 12 }],
    ]);
  });
});
