import { isValidDomain } from '../src/domain';
import { getIntel, type DomainIntel } from '../src/domainIntel';
import { icloudFrameRole, isSupportedWebmailUrl } from '../src/hosts';
import { isSafeHttpUrl } from '../src/linkGuard';

const WARN_TTL_MS = 3600_000;
const MAX_BODY_CHARS = 20_000;
const MAX_LINKS = 500;

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

  browser.tabs?.onRemoved?.addListener((tabId: number) => {
    void browser.storage.session?.remove?.(`tab:${tabId}`).catch(() => {});
  });

  browser.runtime.onMessage.addListener(
    (
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
        void browser.storage.session?.set?.({ [`tab:${sender.tab.id}`]: m.payload });
        return undefined;
      }
      if (m?.type === 'domainIntel' && typeof m.domain === 'string' && isValidDomain(m.domain)) {
        const domain = m.domain;
        let p = inflight.get(domain);
        if (!p) {
          p = getIntel(browser.storage.local, domain, (u, i) => fetch(u, i)).finally(() => inflight.delete(domain));
          inflight.set(domain, p);
        }
        return p;
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
          senderAddress: typeof m.senderAddress === 'string' ? m.senderAddress : '',
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
              .slice(0, 50)
              .map((n) => n.slice(0, 160))
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
              .map((l) => ({ text: l.text.slice(0, 300), href: l.href.slice(0, 2048) }))
          : [];
        void browser.tabs
          .sendMessage(sender.tab.id, {
            type: 'icloudBody',
            frameId: sender.frameId,
            active: Boolean(m.active),
            body: typeof m.body === 'string' ? m.body.slice(0, MAX_BODY_CHARS) : '',
            links,
            attachmentNames,
          })
          .catch(() => {});
        return undefined;
      }
      if (m?.type === 'icloudLock' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'app') {
        const frameIds = Array.isArray(m.frameIds)
          ? m.frameIds.filter((id): id is number => typeof id === 'number').slice(0, 20)
          : [];
        const locked = Boolean(m.locked);
        const attachmentsLocked = Boolean(m.attachmentsLocked);
        for (const frameId of frameIds) {
          void browser.tabs
            .sendMessage(sender.tab.id, { type: 'icloudLock', locked, attachmentsLocked }, { frameId })
            .catch(() => {});
        }
        return undefined;
      }
      if (m?.type === 'icloudPing' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'app') {
        void browser.tabs.sendMessage(sender.tab.id, { type: 'icloudPing' }).catch(() => {});
        return undefined;
      }
      return undefined;
    },
  );
});
