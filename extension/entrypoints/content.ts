import { adapterFor } from '../src/adapters';
import { bodyText, linksIn } from '../src/adapters/extract';
import type { ExtractedEmail, WebmailAdapter } from '../src/adapters/types';
import { isTrusted, trustSender } from '../src/allowlist';
import type { DomainIntel } from '../src/domainIntel';
import { scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { WEBMAIL_MATCHES } from '../src/hosts';
import { analyzeSender } from '../src/sender';
import { decideBanner, removeBanner, showBanner } from '../src/ui/banner';
import type { IntelState } from '../src/ui/details';
import { lockLinks, unlockLinks } from '../src/ui/linkLock';

const DEBOUNCE_MS = 400;
const MAX_THREAD_MESSAGES = 20;
const FALLBACK_SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];

function fallbackExtract(doc: Document): ExtractedEmail | null {
  const container = FALLBACK_SELECTORS.map((s) => doc.querySelector<HTMLElement>(s)).find(Boolean);
  return container ? { senderName: '', senderAddress: '', body: bodyText(container), links: linksIn(container), container } : null;
}

function extractAll(adapter: WebmailAdapter | undefined, doc: Document): ExtractedEmail[] {
  if (adapter?.extractAll) return adapter.extractAll(doc);
  const one = adapter ? adapter.extract(doc) : fallbackExtract(doc);
  return one ? [one] : [];
}

const msgKey = (e: ExtractedEmail) => `${e.senderAddress}\n${e.body}`;

export default defineContentScript({
  matches: WEBMAIL_MATCHES,
  main() {
    const kv = browser.storage.local;
    const adapter = adapterFor(new URL(location.href));
    const trustedThisSession = new Set<string>(); // threads/emails unlocked with "I trust this email" (memory only)
    const dismissed = new Set<string>();
    let lastKey = '';
    let activeContainers: HTMLElement[] = [];
    let token = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = async () => {
      if (document.hidden) return; // never work in background tabs
      const emails = extractAll(adapter, document);
      if (emails.length === 0) {
        for (const c of activeContainers) unlockLinks(c);
        activeContainers = [];
        lastKey = '';
        ++token;
        removeBanner();
        browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
        return;
      }

      const messages = emails.slice(-MAX_THREAD_MESSAGES);
      const threadKey = messages.map(msgKey).join('\n---\n');
      if (
        threadKey === lastKey &&
        messages.length === activeContainers.length &&
        messages.every((m, i) => m.container === activeContainers[i])
      ) {
        return; // unchanged thread => no work
      }

      const newContainers = new Set(messages.map((m) => m.container));
      for (const c of activeContainers) {
        if (!newContainers.has(c)) unlockLinks(c);
      }
      activeContainers = messages.map((m) => m.container);
      lastKey = threadKey;
      const my = ++token;
      removeBanner();

      const threadUnlocked = trustedThisSession.has(threadKey);
      const items = await Promise.all(
        messages.map(async (email) => {
          const k = msgKey(email);
          const sender = analyzeSender(email.senderName, email.senderAddress, email.links);
          const trusted =
            threadUnlocked || trustedThisSession.has(k) || (sender.valid && (await isTrusted(kv, sender.address)));
          const verdict = trusted
            ? { score: 0, level: 'safe' as const, reasons: [] }
            : scoreEmail(sender.address, email.body, email.links);
          return { email, key: k, sender, trusted, verdict };
        }),
      );
      if (my !== token) return;

      const intelByDomain = new Map<string, IntelState>();
      for (const item of items) {
        if (!item.trusted && item.sender.registrable && !intelByDomain.has(item.sender.registrable)) {
          intelByDomain.set(item.sender.registrable, 'loading');
        }
      }

      const render = () => {
        const unlockedThread = trustedThisSession.has(threadKey);
        const evaluated = items.map((item) => {
          const intel = item.sender.registrable ? intelByDomain.get(item.sender.registrable) : undefined;
          const banner = item.trusted
            ? null
            : decideBanner(item.verdict, item.sender, intel, unlockedThread || trustedThisSession.has(item.key));
          return { item, intel, banner };
        });

        let primaryEntry = evaluated[evaluated.length - 1];
        let bestRank = -1;
        for (const entry of evaluated) {
          if (!entry.banner) continue;
          const rank = (entry.banner.level === 'danger' ? 10 : 0) + entry.item.verdict.score;
          if (rank >= bestRank) {
            bestRank = rank;
            primaryEntry = entry;
          }
        }

        const anyLinksLocked = evaluated.some((e) => e.banner?.linksLocked);
        for (const { item } of evaluated) {
          if (anyLinksLocked && !item.trusted) lockLinks(item.email.container);
          else unlockLinks(item.email.container);
        }

        const primaryBanner = primaryEntry.banner;
        browser.runtime
          .sendMessage({
            type: 'verdict',
            payload: {
              verdict: primaryEntry.item.verdict,
              sender: primaryEntry.item.sender,
              intel: primaryEntry.intel,
            },
          })
          .catch(() => {});

        if (!primaryBanner || dismissed.has(threadKey)) {
          removeBanner();
          return;
        }
        showBanner(
          { ...primaryBanner, linksLocked: anyLinksLocked },
          {
            onUnlock: () => {
              trustedThisSession.add(threadKey);
              for (const { item } of evaluated) unlockLinks(item.email.container);
            },
            onTrustSender: async () => {
              const addr = primaryEntry.item.sender.address;
              const ok = await trustSender(kv, addr);
              if (ok) {
                for (const { item } of evaluated) {
                  if (item.sender.address === addr) {
                    item.trusted = true;
                    item.verdict = { score: 0, level: 'safe', reasons: [] };
                    unlockLinks(item.email.container);
                  }
                }
                browser.runtime
                  .sendMessage({
                    type: 'verdict',
                    payload: { verdict: { score: 0, level: 'safe', reasons: [] }, sender: primaryEntry.item.sender, intel: undefined },
                  })
                  .catch(() => {});
              }
              return ok;
            },
            onReport: () => recordFalsePositive(kv, { ...primaryEntry.item.verdict, reasons: primaryBanner.reasons }),
            onDismiss: () => dismissed.add(threadKey),
          },
        );
      };
      render();

      if (intelByDomain.size > 0) {
        await Promise.all(
          [...intelByDomain.keys()].map(async (domain) => {
            try {
              const res = (await browser.runtime.sendMessage({ type: 'domainIntel', domain })) as DomainIntel | undefined;
              intelByDomain.set(domain, res ?? 'unavailable');
            } catch {
              intelByDomain.set(domain, 'unavailable');
            }
          }),
        );
        if (my === token) render();
      }
    };

    // Debounced: bursts of DOM changes (webmail is chatty) collapse into one scan, run when idle.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const run = () => void scan();
        'requestIdleCallback' in window ? requestIdleCallback(run) : run();
      }, DEBOUNCE_MS);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  },
});
