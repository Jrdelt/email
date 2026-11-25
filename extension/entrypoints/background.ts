import { isLookupDomain } from '../src/domain';
import { getIntel, type DomainIntel } from '../src/domainIntel';
import { icloudFrameRole, isSupportedWebmailUrl } from '../src/hosts';
import { MAX_ATTACHMENT_NAMES } from '../src/attachments';
import { MAX_LINK_TEXT_CHARS, MAX_LINKS } from '../src/adapters/extract';
import { WARN_TTL_MS, isSafeHttpUrl } from '../src/linkGuard';
import { clearLookupCaches, getSettings } from '../src/settings';

const MAX_BODY_CHARS = 21_000; // sandbox body (head + tail sample, see adapters/extract.ts bodyText) plus slack
const MAX_RELAY_FRAMES = 200; // every open message frame of a long thread must still receive its lock decision
const SIG_RE = /^[0-9a-f]{1,8}$/; // FNV-1a body signature from the iCloud sandbox
const PAIR_NONCE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // iCloud card/frame pairing token

function frameRoleOf(url?: string) {
  if (!url) return null;
  try {
    return icloudFrameRole(new URL(url));
  } catch {
    return null;
  }
}

async function openTab(url: string, active: boolean, openerTabId?: number) {
  if (openerTabId !== undefined) {
    try {
      return await browser.tabs.create({ url, active, openerTabId });
    } catch {
      // Fall back when openerTabId is closed or unsupported in the current window context.
    }
  }
  return browser.tabs.create({ url, active });
}

async function pruneOldWarnings(now: number): Promise<void> {
  const store = browser.storage.session;
  if (!store?.get || !store?.remove) return;
  try {
    const all = (await (store.get as (k?: null) => Promise<Record<string, unknown>>)(null)) ?? {};
    const stale = Object.entries(all)
      .filter(
        ([k, v]) =>
          k.startsWith('warn:') &&
          typeof (v as { createdAt?: unknown })?.createdAt === 'number' &&
          now - (v as { createdAt: number }).createdAt > WARN_TTL_MS,
      )
      .map(([k]) => k);
    if (stale.length) await store.remove(stale);
  } catch {
    /* best effort */
  }
}

export default defineBackground(() => {
  const inflight = new Map<string, Promise<DomainIntel>>();
  let lookupCachesCleared = false;

  browser.tabs?.onRemoved?.addListener((tabId: number) => {
    void browser.storage.session?.remove?.(`tab:${tabId}`).catch(() => {});
    void pruneOldWarnings(Date.now());
  });
  // A tab that starts loading a new page drops its stored verdict; webmail content scripts re-send theirs.
  browser.tabs?.onUpdated?.addListener((tabId: number, changeInfo: { status?: string }) => {
    if (changeInfo.status === 'loading') void browser.storage.session?.remove?.(`tab:${tabId}`)?.catch(() => {});
  });

  const handleMessage = (
    msg: unknown,
    sender: { id?: string; tab?: { id?: number }; frameId?: number; url?: string },
  ): Promise<unknown> | undefined => {
    if (browser.runtime?.id && sender.id && sender.id !== browser.runtime.id) return undefined;
    const m = msg as
      | {
          type?: string;
          payload?: unknown;
          domain?: unknown;
          active?: unknown;
          body?: unknown;
          links?: unknown;
          attachmentNames?: unknown;
          linksTruncated?: unknown;
          sig?: unknown;
          nonce?: unknown;
          locked?: unknown;
          attachmentsLocked?: unknown;
          frameIds?: unknown;
          href?: unknown;
          host?: unknown;
          registrable?: unknown;
          level?: unknown;
          reasons?: unknown;
          senderAddress?: unknown;
          intel?: unknown;
        }
      | undefined;
    if (
      m?.type === 'verdict' &&
      sender.tab?.id !== undefined &&
      isSupportedWebmailUrl(sender.url) &&
      (sender.frameId === 0 || frameRoleOf(sender.url) === 'app')
    ) {
      void browser.storage.session?.set?.({ [`tab:${sender.tab.id}`]: m.payload })?.catch(() => {});
      return undefined;
    }
    if (m?.type === 'domainIntel' && typeof m.domain === 'string' && isLookupDomain(m.domain)) {
      const domain = m.domain;
      return (async () => {
        const settings = await getSettings(browser.storage.local, browser.storage.managed);
        if (settings.strictLocalMode) {
          // Also covers Strict Local Mode enforced by managed policy: drop old lookup results once per worker.
          if (!lookupCachesCleared) {
            lookupCachesCleared = true;
            await clearLookupCaches(browser.storage.local).catch(() => {});
          }
          return null;
        }
        let p = inflight.get(domain);
        if (!p) {
          p = getIntel(browser.storage.local, domain, (u, i) => fetch(u, i)).finally(() => inflight.delete(domain));
          inflight.set(domain, p);
        }
        return p;
      })();
    }
    if (
      m?.type === 'openWarning' &&
      sender.tab?.id !== undefined &&
      isSupportedWebmailUrl(sender.url) &&
      typeof m.href === 'string' &&
      isSafeHttpUrl(m.href)
    ) {
      const tabId = sender.tab.id;
      const id = crypto.randomUUID();
      const now = Date.now();
      const reasons = Array.isArray(m.reasons)
        ? m.reasons.filter((r): r is string => typeof r === 'string').slice(0, 10)
        : [];
      const entry = {
        href: m.href,
        host: typeof m.host === 'string' ? m.host : '',
        registrable: typeof m.registrable === 'string' ? m.registrable : '',
        level: m.level === 'warning' ? 'warning' : 'danger',
        reasons,
        intel: m.intel && typeof m.intel === 'object' ? m.intel : undefined,
        createdAt: now,
      };
      return (async () => {
        await pruneOldWarnings(now);
        await browser.storage.session?.set?.({ [`warn:${id}`]: entry });
        await openTab(browser.runtime.getURL(`/warning.html?id=${encodeURIComponent(id)}`), true, tabId);
      })();
    }
    if (
      m?.type === 'openSafeLink' &&
      sender.tab?.id !== undefined &&
      isSupportedWebmailUrl(sender.url) &&
      typeof m.href === 'string' &&
      isSafeHttpUrl(m.href)
    ) {
      return openTab(m.href, m.active !== false, sender.tab.id);
    }
    if (
      m?.type === 'icloudBody' &&
      sender.tab?.id !== undefined &&
      sender.frameId !== undefined &&
      frameRoleOf(sender.url) === 'sandbox'
    ) {
      const attachmentNames = Array.isArray(m.attachmentNames)
        ? m.attachmentNames
            .filter((n): n is string => typeof n === 'string')
            .slice(0, MAX_ATTACHMENT_NAMES)
            .map((n) => (n.length > 1024 ? n.slice(-1024) : n)) // keep the end: the extension decides the risk
        : [];
      const links = Array.isArray(m.links)
        ? m.links
            .filter(
              (l): l is { text: string; href: string } =>
                Boolean(l) &&
                typeof l === 'object' &&
                typeof (l as { text?: unknown }).text === 'string' &&
                typeof (l as { href?: unknown }).href === 'string',
            )
            .slice(0, MAX_LINKS)
            .map((l) => ({ text: l.text.slice(0, MAX_LINK_TEXT_CHARS), href: l.href.slice(0, 2048) }))
        : [];
      void browser.tabs
        .sendMessage(sender.tab.id, {
          type: 'icloudBody',
          frameId: sender.frameId,
          active: Boolean(m.active),
          body: typeof m.body === 'string' ? m.body.slice(0, MAX_BODY_CHARS) : '',
          links,
          // Over-cap link lists are also truncated here, so report that the extras were not checked.
          linksTruncated: m.linksTruncated === true || (Array.isArray(m.links) && m.links.length > MAX_LINKS),
          attachmentNames,
          ...(typeof m.sig === 'string' && SIG_RE.test(m.sig) ? { sig: m.sig } : {}),
        })
        .catch(() => {});
      return undefined;
    }
    if (m?.type === 'icloudLock' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'app') {
      const frameIds = Array.isArray(m.frameIds)
        ? m.frameIds.filter((id): id is number => Number.isInteger(id) && id >= 0).slice(0, MAX_RELAY_FRAMES)
        : [];
      const locked = Boolean(m.locked);
      const attachmentsLocked = Boolean(m.attachmentsLocked);
      const sig = typeof m.sig === 'string' && SIG_RE.test(m.sig) ? { sig: m.sig } : {};
      for (const frameId of frameIds) {
        void browser.tabs
          .sendMessage(sender.tab.id, { type: 'icloudLock', locked, attachmentsLocked, ...sig }, { frameId })
          .catch(() => {});
      }
      return undefined;
    }
    if (
      m?.type === 'icloudPair' &&
      sender.tab?.id !== undefined &&
      sender.frameId !== undefined &&
      frameRoleOf(sender.url) === 'sandbox' &&
      typeof m.nonce === 'string' &&
      PAIR_NONCE_RE.test(m.nonce)
    ) {
      // Stateless relay: the app frame ties its card's iframe (which it sent the nonce to) to this verified frame id.
      void browser.tabs.sendMessage(sender.tab.id, { type: 'icloudPair', nonce: m.nonce, frameId: sender.frameId }).catch(() => {});
      return undefined;
    }
    if (m?.type === 'icloudBlocked' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'sandbox') {
      // Stateless relay: a paused click in a message frame asks the app frame to reopen its dismissed banner.
      void browser.tabs.sendMessage(sender.tab.id, { type: 'icloudBlocked' }).catch(() => {});
      return undefined;
    }
    if (m?.type === 'icloudPing' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'app') {
      void browser.tabs.sendMessage(sender.tab.id, { type: 'icloudPing' }).catch(() => {});
      return undefined;
    }
    return undefined;
  };

  // Reply via sendResponse + `return true`: older Chrome/Edge ignore a Promise returned from onMessage.
  browser.runtime.onMessage.addListener((msg: unknown, sender, sendResponse: (response?: unknown) => void) => {
    const pending = handleMessage(msg, sender);
    if (!pending) return undefined;
    pending.then(sendResponse, () => sendResponse(undefined));
    return true;
  });
});
