import { bodyText, linksIn } from './extract';
import type { ExtractedEmail, WebmailAdapter } from './types';

const isHidden = (el: HTMLElement): boolean =>
  el.hidden || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

// Best-effort Gmail selectors (T7: verify against saved fixtures and live Gmail).
// div.a3s = message body; span.gD[email] = sender chip with name and address attributes.
export const gmail: WebmailAdapter = {
  name: 'gmail',
  matches: (url) => url.hostname === 'mail.google.com',
  extractAll(doc): ExtractedEmail[] {
    const containers = [...doc.querySelectorAll<HTMLElement>('div.a3s')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('div.a3s') === null,
    );
    return containers.map((container) => {
      const msg = container.closest<HTMLElement>('.adn, [role="listitem"]');
      const chip =
        msg?.querySelector<HTMLElement>('span.gD[email]') ??
        (containers.length === 1 ? [...doc.querySelectorAll<HTMLElement>('span.gD[email]')].pop() : undefined);
      return {
        senderName: chip?.getAttribute('name') ?? chip?.textContent ?? '',
        senderAddress: chip?.getAttribute('email') ?? '',
        body: bodyText(container),
        links: linksIn(container),
        container,
      };
    });
  },
  extract(doc) {
    const all = gmail.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
