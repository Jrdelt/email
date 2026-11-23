import { scoreEmail } from '../src/features';

export default defineContentScript({
  matches: ['https://mail.google.com/*', 'https://outlook.live.com/*', 'https://outlook.office.com/*'],
  main() {
    // Selectors are best-effort and will need maintenance per webmail provider.
    const SELECTORS = ['div.a3s', '[aria-label="Message body"]', '[role="document"]'];
    let last = '';
    const scan = () => {
      const el = SELECTORS.map((s) => document.querySelector<HTMLElement>(s)).find(Boolean);
      if (!el) return;
      const body = el.innerText ?? '';
      if (body === last) return;
      last = body;
      const links = [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].map((a) => ({ text: a.innerText, href: a.href }));
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
    new MutationObserver(() => scan()).observe(document.body, { childList: true, subtree: true });
    scan();
  },
});
