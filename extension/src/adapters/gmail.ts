import { isValidDomain } from '../domain';
import { MAX_BODY_CHARS, bodyText, linksIn } from './extract';
import type { ExtractedEmail, WebmailAdapter } from './types';

const isHidden = (el: HTMLElement): boolean =>
  el.hidden || el.getAttribute('aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

const extractEmailText = (raw: string): string =>
  raw.match(/([^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+)/)?.[1]?.trim() ?? '';

const cleanHost = (raw: string): string =>
  raw.trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase();

function extractViaDomain(scope: Document | HTMLElement, container: HTMLElement): string | undefined {
  for (const anchor of scope.querySelectorAll<HTMLElement>('a.acP, a[href*="support.google.com/mail/answer/1311182"]')) {
    if (container.contains(anchor)) continue;
    const sib = cleanHost(anchor.parentElement?.nextElementSibling?.textContent ?? '');
    if (sib && isValidDomain(sib)) return sib;
    const afterVia = (anchor.parentElement?.textContent ?? '').match(/\bvia\s+([^\s,;()]+)/i)?.[1] ?? '';
    const candidate = cleanHost(afterVia);
    if (candidate && isValidDomain(candidate)) return candidate;
  }
  for (const el of scope.querySelectorAll<HTMLElement>('span.go, h3.iw')) {
    if (container.contains(el)) continue;
    const m = (el.textContent ?? '').match(
      /\bvia\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/i,
    );
    const candidate = cleanHost(m?.[1] ?? '');
    if (candidate && isValidDomain(candidate)) return candidate;
  }
  return undefined;
}

function isUnauthenticated(scope: Document | HTMLElement, container: HTMLElement): boolean {
  const unauthRe = /couldn['’]t verify|could not verify/i;
  for (const el of scope.querySelectorAll<HTMLElement>('[aria-label], [data-tooltip], [title], img[alt]')) {
    if (container.contains(el)) continue;
    const text = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`;
    if (unauthRe.test(text)) return true;
  }
  for (const el of scope.querySelectorAll<HTMLElement>('.gE')) {
    if (!container.contains(el) && /gmail couldn['’]t verify/i.test(el.textContent ?? '')) return true;
  }
  return false;
}

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

      const viaDomain = scope ? extractViaDomain(scope, container) : undefined;
      const unauthenticated = scope ? isUnauthenticated(scope, container) : false;
      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      return {
        senderName,
        senderAddress,
        ...(viaDomain ? { viaDomain } : {}),
        ...(unauthenticated ? { unauthenticated: true } : {}),
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
