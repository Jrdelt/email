import { MAX_BODY_CHARS, bodyText, linksIn } from './extract';
import type { ExtractedEmail, WebmailAdapter } from './types';

const isHidden = (el: HTMLElement): boolean =>
  el.hidden || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

const extractEmailText = (raw: string): string =>
  raw.match(/([^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+)/)?.[1]?.trim() ?? '';

// Best-effort Gmail selectors (T7: verify against saved fixtures and live Gmail).
// div.a3s = message body; span.gD[email] = standard sender chip; span.go.gD = Spam/via bare address; h2.hP = subject.
export const gmail: WebmailAdapter = {
  name: 'gmail',
  matches: (url) => url.hostname === 'mail.google.com',
  extractAll(doc): ExtractedEmail[] {
    const containers = [...doc.querySelectorAll<HTMLElement>('div.a3s')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('div.a3s') === null,
    );
    const subject = (doc.querySelector<HTMLElement>('h2.hP')?.textContent ?? '').trim();
    return containers.map((container) => {
      const msg = container.closest<HTMLElement>('.adn, [role="listitem"]');
      const scope = msg ?? (containers.length === 1 ? doc : null);
      const emailChip =
        msg?.querySelector<HTMLElement>('span.gD[email]') ??
        (containers.length === 1 ? [...doc.querySelectorAll<HTMLElement>('span.gD[email]')].pop() : undefined);

      let senderAddress = emailChip?.getAttribute('email')?.trim() ?? '';
      if (!senderAddress && scope) {
        for (const el of scope.querySelectorAll<HTMLElement>('span.go.gD, span.go, span.gD, h3.iw')) {
          if (container.contains(el)) continue;
          const found = extractEmailText(el.textContent ?? '');
          if (found) {
            senderAddress = found;
            break;
          }
        }
      }

      let senderName = emailChip?.getAttribute('name')?.trim() ?? '';
      if (!senderName && emailChip) {
        const t = (emailChip.textContent ?? '').trim();
        if (t && !t.includes('@')) senderName = t;
      }
      if (!senderName && scope) {
        for (const el of scope.querySelectorAll<HTMLElement>('span.gD')) {
          if (container.contains(el)) continue;
          const t = (el.textContent ?? '').trim();
          if (t && !t.includes('@')) {
            senderName = t;
            break;
          }
        }
      }

      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      return {
        senderName,
        senderAddress,
        body,
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
