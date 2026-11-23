import { adapterFor } from '../src/adapters';
import { bodyText, linksIn } from '../src/adapters/extract';
import type { ExtractedEmail } from '../src/adapters/types';
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
const FALLBACK_SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];

function fallbackExtract(doc: Document): ExtractedEmail | null {
  const container = FALLBACK_SELECTORS.map((s) => doc.querySelector<HTMLElement>(s)).find(Boolean);
  return container ? { senderName: '', senderAddress: '', body: bodyText(container), links: linksIn(container), container } : null;
}

export default defineContentScript({
  matches: WEBMAIL_MATCHES,
  main() {
    const kv = browser.storage.local;
    const adapter = adapterFor(new URL(location.href));
    const trustedThisSession = new Set<string>(); // emails unlocked with "I trust this email" (memory only)
    const dismissed = new Set<string>();
    let lastKey = '';
    let current: HTMLElement | undefined;
    let token = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = async () => {
      if (document.hidden) return; // never work in background tabs
      const email = adapter?.extract(document) ?? fallbackExtract(document);
      if (!email) {
        if (current) { unlockLinks(current); current = undefined; }
        lastKey = '';
        ++token;
        removeBanner();
        browser.runtime.sendMessage({ type: 'verdict', payload: null }).catch(() => {});
        return;
      }
      const key = `${email.senderAddress}\n${email.body}`;
      if (key === lastKey && email.container === current) return; // unchanged email => no work
      lastKey = key;
      if (current && current !== email.container) unlockLinks(current);
      current = email.container;
      const my = ++token;
      removeBanner();

      const sender = analyzeSender(email.senderName, email.senderAddress, email.links);
      if (trustedThisSession.has(key) || (sender.valid && (await isTrusted(kv, sender.address)))) return;
      if (my !== token) return;

      const verdict = scoreEmail(sender.address, email.body, email.links);
      const danger = verdict.level !== 'safe';
      if (danger) lockLinks(email.container);
      let intel: IntelState = sender.registrable ? 'loading' : undefined;

      const render = () => {
        browser.runtime.sendMessage({ type: 'verdict', payload: { verdict, sender, intel } }).catch(() => {});
        const banner = decideBanner(verdict, sender, intel, trustedThisSession.has(key));
        if (!banner || dismissed.has(key)) { removeBanner(); return; }
        showBanner(banner, {
          onUnlock: () => { trustedThisSession.add(key); unlockLinks(email.container); },
          onTrustSender: () => trustSender(kv, sender.address),
          onReport: () => recordFalsePositive(kv, { ...verdict, reasons: banner.reasons }),
          onDismiss: () => dismissed.add(key),
        });
      };
      render();

      if (sender.registrable) {
        try {
          intel = ((await browser.runtime.sendMessage({ type: 'domainIntel', domain: sender.registrable })) as DomainIntel | undefined) ?? 'unavailable';
        } catch { intel = 'unavailable'; }
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
