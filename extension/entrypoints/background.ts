import type { Verdict } from '../src/features';

interface VerdictMessage { type: 'verdict'; verdict: Verdict }

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((msg: unknown, sender: { tab?: { id?: number } }) => {
    const m = msg as Partial<VerdictMessage> | undefined;
    if (m?.type === 'verdict' && m.verdict && sender.tab?.id !== undefined) {
      void browser.storage.session?.set?.({ [`tab:${sender.tab.id}`]: m.verdict });
    }
  });
});
