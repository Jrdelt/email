import { isTrusted, normalizeSender, trustSender } from '../src/allowlist';
import { scoreEmail } from '../src/features';
import { recordFalsePositive } from '../src/feedback';
import { WEBMAIL_MATCHES } from '../src/hosts';
import { removeBanner, showBanner } from '../src/ui/banner';
import { lockLinks, unlockLinks } from '../src/ui/linkLock';

const MAX_BODY_CHARS = 20_000; // cap work per email
const DEBOUNCE_MS = 400;

export default defineContentScript({
  matches: WEBMAIL_MATCHES,
  main() {
    const kv = browser.storage.local;
    // Selectors are best-effort; TODO(T7) replace with src/adapters/.
    const SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];
    const trustedThisSession = new Set<string>(); // emails the user unlocked ("I trust this email"), in memory only
    let last = '';
    let current: HTMLElement | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = async () => {
      if (document.hidden) return; // never work in background tabs
      const el = SELECTORS.map((s) => document.querySelector<HTMLElement>(s)).find(Boolean);
      if (!el) return;
      const body = (el.textContent ?? '').slice(0, MAX_BODY_CHARS);
      if (body === last && el === current) return; // unchanged email => no work
      last = body;
      if (current && current !== el) unlockLinks(current);
      current = el;
      removeBanner();

      const sender = ''; // TODO(T7): adapter.extract().sender
      if (trustedThisSession.has(body) || (await isTrusted(kv, sender))) return;

      const links = [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0, 200).map((a) => ({ text: a.textContent ?? '', href: a.href }));
      const verdict = scoreEmail(sender, body, links);
      browser.runtime.sendMessage({ type: 'verdict', verdict }).catch(() => {});
      if (verdict.level === 'safe') return;

      lockLinks(el);
      showBanner(verdict, normalizeSender(sender) !== '', {
        onUnlock: () => { trustedThisSession.add(body); unlockLinks(el); },
        onTrustSender: () => trustSender(kv, sender),
        onReport: () => recordFalsePositive(kv, verdict),
      });
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
