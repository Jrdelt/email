import { getIntel, type DomainIntel } from '../src/domainIntel';
import { isValidDomain } from '../src/domain';

export default defineBackground(() => {
  const inflight = new Map<string, Promise<DomainIntel>>();

  browser.runtime.onMessage.addListener((msg: unknown, sender: { tab?: { id?: number } }): Promise<unknown> | undefined => {
    const m = msg as { type?: string; payload?: unknown; domain?: unknown } | undefined;
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
    return undefined;
  });
});
