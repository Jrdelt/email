import { scoreEmail } from '../src/features';

const MAX_BODY_CHARS = 20_000; // cap work per email
const DEBOUNCE_MS = 400;

export default defineContentScript({
  matches: ['https://mail.google.com/*', 'https://outlook.live.com/*', 'https://outlook.office.com/*'],
  main() {
    // Selectors are best-effort; TODO(T7) move into src/adapters/.
    const SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];
    let last = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const scan = () => {
      if (document.hidden) return; // never work in background tabs
      const el = SELECTORS.map((s) => document.querySelector<HTMLElement>(s)).find(Boolean);
      if (!el) return;
      const body = (el.textContent ?? '').slice(0, MAX_BODY_CHARS);
      if (body === last) return; // unchanged email => no work
      last = body;
      const links = [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0, 200).map((a) => ({ text: a.textContent ?? '', href: a.href }));
      const verdict = scoreEmail('', body, links);
      browser.runtime.sendMessage({ type: 'verdict', verdict }).catch(() => {});
      document.getElementById('ped-banner')?.remove();
      if (verdict.level !== 'safe') {
        const b = document.createElement('div');
        b.id = 'ped-banner';
        b.textContent = `⚠ ${verdict.level === 'likely-phishing' ? 'Likely phishing' : 'Suspicious email'}: ${verdict.reasons[0] ?? ''}`;
        b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:8px;background:#b00020;color:#fff;font:14px sans-serif;text-align:center';
        document.body.appendChild(b);
      }
    };

    // Debounced: bursts of DOM changes (webmail is chatty) collapse into one scan, run when idle.
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ('requestIdleCallback' in window ? requestIdleCallback(scan) : scan()), DEBOUNCE_MS);
    };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  },
});
