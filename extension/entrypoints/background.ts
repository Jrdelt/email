import { icloudFrameRole } from '../src/adapters/icloud';
import { isValidDomain } from '../src/domain';
import { getIntel, type DomainIntel } from '../src/domainIntel';

function frameRoleOf(url?: string) {
  if (!url) return null;
  try {
    return icloudFrameRole(new URL(url));
  } catch {
    return null;
  }
}

export default defineBackground(() => {
  const inflight = new Map<string, Promise<DomainIntel>>();

  browser.runtime.onMessage.addListener(
    (
      msg: unknown,
      sender: { tab?: { id?: number }; frameId?: number; url?: string },
    ): Promise<unknown> | undefined => {
      const m = msg as
        | {
            type?: string;
            payload?: unknown;
            domain?: unknown;
            active?: unknown;
            body?: unknown;
            links?: unknown;
            locked?: unknown;
            frameIds?: unknown;
          }
        | undefined;
      if (m?.type === 'verdict' && sender.tab?.id !== undefined) {
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
        m?.type === 'icloudBody' &&
        sender.tab?.id !== undefined &&
        sender.frameId !== undefined &&
        frameRoleOf(sender.url) === 'sandbox'
      ) {
        void browser.tabs
          .sendMessage(sender.tab.id, {
            type: 'icloudBody',
            frameId: sender.frameId,
            active: Boolean(m.active),
            body: typeof m.body === 'string' ? m.body : '',
            links: Array.isArray(m.links) ? m.links : [],
          })
          .catch(() => {});
        return undefined;
      }
      if (m?.type === 'icloudLock' && sender.tab?.id !== undefined && frameRoleOf(sender.url) === 'app') {
        const frameIds = Array.isArray(m.frameIds)
          ? m.frameIds.filter((id): id is number => typeof id === 'number').slice(0, 20)
          : [];
        const locked = Boolean(m.locked);
        for (const frameId of frameIds) {
          void browser.tabs.sendMessage(sender.tab.id, { type: 'icloudLock', locked }, { frameId }).catch(() => {});
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
