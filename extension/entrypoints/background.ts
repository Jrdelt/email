import { isLookupDomain } from '../src/domain';
import { getIntel, pruneIntelCache, type DomainIntel, type FetchFn } from '../src/domainIntel';
import { icloudFrameRole, isSupportedWebmailUrl } from '../src/hosts';
import { MAX_CLASSIFIED_ATTACHMENTS } from '../src/attachments';
import { MAX_LINKS, capLinkText } from '../src/adapters/extract';
import { WARN_TTL_MS, isSafeHttpUrl, proceedTarget } from '../src/linkGuard';
import { clearLookupCaches, getSettings } from '../src/settings';

const MAX_BODY_CHARS = 21_000; // sandbox body (head + tail sample, see adapters/extract.ts bodyText) plus slack
const MAX_RELAY_FRAMES = 200; // every open message frame of a long thread must still receive its lock decision
const SIG_RE = /^[0-9a-f]{1,32}$/; // body signature from the iCloud sandbox (128 bits of SHA-256)
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

/** Drop warn:* entries older than WARN_TTL_MS, and those of a warning tab that was just closed. */
async function pruneOldWarnings(now: number, closedTabId?: number): Promise<void> {
  const store = browser.storage.session;
  if (!store?.get || !store?.remove) return;
  try {
    const all = (await (store.get as (k?: null) => Promise<Record<string, unknown>>)(null)) ?? {};
    const stale = Object.entries(all)
      .filter(([k, v]) => {
        if (!k.startsWith('warn:') || !v || typeof v !== 'object') return false;
        const e = v as { createdAt?: unknown; warnTabId?: unknown };
        if (closedTabId !== undefined && e.warnTabId === closedTabId) return true;
        return typeof e.createdAt === 'number' && now - e.createdAt > WARN_TTL_MS;
      })
      .map(([k]) => k);
    if (stale.length) await store.remove(stale);
  } catch {
    /* best effort */
  }
}

const originOf = (url?: string): string => {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
};

export default defineBackground(() => {
  const inflight = new Map<string, Promise<DomainIntel>>();
  // Strict Local Mode as last read (user setting or managed policy). Turning it on purges the lookup caches here,
  // so a policy pushed by IT applies even though content scripts then never ask for a lookup. Every request and
  // cache write of an in-flight lookup re-checks it, and any purge bumps `generation` so a lookup that started
  // before cannot write its results back.
  let strictNow = false;
  let generation = 0;
  const refreshStrict = async (): Promise<boolean> => {
    const { strictLocalMode } = await getSettings(browser.storage.local, browser.storage.managed);
    if (strictLocalMode && !strictNow) {
      generation++;
      inflight.clear();
      await clearLookupCaches(browser.storage.local).catch(() => {});
    }
    strictNow = strictLocalMode;
    return strictNow;
  };
  // Lookup-cache access for work started in generation `gen`: writes are dropped once Strict Local Mode is on or
  // the cache was purged since, so they can never bring purged results back.
  const cacheKV = (gen: number) => {
    const allowed = () => !strictNow && gen === generation;
    return {
      allowed,
      kv: {
        get: (k: string) => browser.storage.local.get(k),
        set: async (items: Record<string, unknown>) => {
          if (allowed()) await browser.storage.local.set(items);
        },
      },
    };
  };
  // Expired data is deleted when the background starts, not only at the next lookup or link warning: cached
  // sender/clicked-link domains (24 h, 15 min for partial results) and warn:* entries holding a full URL (1 h).
  const startGen = generation;
  void refreshStrict()
    .then((strict) => (strict ? undefined : pruneIntelCache(cacheKV(startGen).kv)))
    .catch(() => {});
  void pruneOldWarnings(Date.now());
  browser.storage?.onChanged?.addListener((changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area === 'managed' || (area === 'local' && 'privacySettings' in changes)) void refreshStrict();
    // Cleared from elsewhere (popup "Clear all local data"): results of lookups already running are discarded.
    if (area === 'local' && changes.domainIntelCache && changes.domainIntelCache.newValue === undefined) generation++;
  });

  browser.tabs?.onRemoved?.addListener((tabId: number) => {
    void browser.storage.session?.remove?.(`tab:${tabId}`).catch(() => {});
    void pruneOldWarnings(Date.now(), tabId);
  });
  // A tab that starts loading a page of another site drops its stored verdict. Subframe loads and same-site
  // navigations also report 'loading'; there the webmail's content script keeps or replaces the verdict itself.
  const onTabUpdated = (tabId: number, changeInfo: { status?: string; url?: string }, tab?: { url?: string }) => {
    if (changeInfo.status !== 'loading') return;
    const key = `tab:${tabId}`;
    void (async () => {
      const store = browser.storage.session;
      const stored = (await store.get(key))[key] as { origin?: unknown } | null | undefined;
      if (stored === undefined) return;
      const origin = originOf(changeInfo.url ?? tab?.url);
      if (!origin || !stored || stored.origin !== origin) await store.remove(key);
    })().catch(() => {});
  };
  // This fires for every tab on every site, so ask for status changes only: Firefox then no longer wakes the
  // background for title and favicon updates. Chrome and Edge throw "This event does not support filters" (a URL
  // filter would also hide navigations away from webmail), so they get the unfiltered listener.
  const tabEvents = browser.tabs?.onUpdated as unknown as
    | { addListener(cb: typeof onTabUpdated, filter?: { properties: string[] }): void }
    | undefined;
  try {
    tabEvents?.addListener(onTabUpdated, { properties: ['status'] });
  } catch {
    tabEvents?.addListener(onTabUpdated);
  }

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
          via?: unknown;
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
      const payload = m.payload && typeof m.payload === 'object' ? { ...m.payload, origin: originOf(sender.url) } : null;
      void browser.storage.session?.set?.({ [`tab:${sender.tab.id}`]: payload })?.catch(() => {});
      return undefined;
    }
    if (m?.type === 'domainIntel' && typeof m.domain === 'string' && isLookupDomain(m.domain)) {
      const domain = m.domain;
      return (async () => {
        if (await refreshStrict()) return null;
        let p = inflight.get(domain);
        if (!p) {
          const { allowed, kv } = cacheKV(generation);
          const guardedFetch: FetchFn = (u, i) => (allowed() ? fetch(u, i) : Promise.reject(new Error('lookups stopped')));
          // Delete only this lookup's own entry: after a Strict Local Mode purge the map may hold a newer one.
          const own: Promise<DomainIntel> = getIntel(kv, domain, guardedFetch).finally(() => {
            if (inflight.get(domain) === own) inflight.delete(domain);
          });
          p = own;
          inflight.set(domain, own);
        }
        const result = await p;
        return strictNow ? null : result;
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
      // The clicked gateway URL, only when it leads exactly to the checked destination (see proceedTarget).
      const via = proceedTarget(m.href, m.via);
      const entry = {
        href: m.href,
        ...(via !== m.href ? { via } : {}),
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
        const tab = await openTab(browser.runtime.getURL(`/warning.html?id=${encodeURIComponent(id)}`), true, tabId);
        // Remember which tab shows it, so closing that tab removes the entry (it holds the full clicked URL).
        if (tab?.id !== undefined) {
          const cur = (await browser.storage.session.get(`warn:${id}`))[`warn:${id}`];
          if (cur && typeof cur === 'object') await browser.storage.session.set({ [`warn:${id}`]: { ...cur, warnTabId: tab.id } });
        }
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
            .slice(0, MAX_CLASSIFIED_ATTACHMENTS) // the app frame classifies every name the message frame found
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
            .map((l) => ({ text: capLinkText(l.text), href: l.href.slice(0, 2048) }))
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
