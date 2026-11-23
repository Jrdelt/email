import type { Link } from '../features';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;

export const bodyText = (el: HTMLElement) => (el.textContent ?? '').slice(0, MAX_BODY_CHARS);

export const linksIn = (el: HTMLElement): Link[] => {
  const base = el.ownerDocument.baseURI || 'https://invalid.local';
  return [
    ...el.querySelectorAll<HTMLAnchorElement | HTMLAreaElement>(
      'a[href], a[data-ped-href], area[href], area[data-ped-href]',
    ),
  ]
    .slice(0, MAX_LINKS)
    .map((a) => {
      let href = a.hasAttribute('href') ? a.href : '';
      if (!href) {
        const stashed = a.getAttribute('data-ped-href') ?? '';
        try {
          href = stashed ? new URL(stashed, base).href : '';
        } catch {
          href = stashed;
        }
      }
      return { text: a.textContent ?? '', href };
    });
};
