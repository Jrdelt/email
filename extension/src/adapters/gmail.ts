import { bodyText, linksIn } from './extract';
import type { WebmailAdapter } from './types';

// Best-effort Gmail selectors (T7: verify against saved fixtures and live Gmail).
// div.a3s = message body; span.gD[email] = sender chip with name and address attributes.
export const gmail: WebmailAdapter = {
  name: 'gmail',
  matches: (url) => url.hostname === 'mail.google.com',
  extract(doc) {
    const bodies = doc.querySelectorAll<HTMLElement>('div.a3s');
    const container = bodies[bodies.length - 1];
    if (!container) return null;
    const msg = container.closest<HTMLElement>('.adn, [role="listitem"]') ?? doc;
    const chip = msg.querySelector<HTMLElement>('span.gD[email]') ?? [...doc.querySelectorAll<HTMLElement>('span.gD[email]')].pop();
    return {
      senderName: chip?.getAttribute('name') ?? chip?.textContent ?? '',
      senderAddress: chip?.getAttribute('email') ?? '',
      body: bodyText(container),
      links: linksIn(container),
      container,
    };
  },
};
