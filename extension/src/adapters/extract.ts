import type { Link } from '../features';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;

export const bodyText = (el: HTMLElement) => (el.textContent ?? '').slice(0, MAX_BODY_CHARS);
export const linksIn = (el: HTMLElement): Link[] =>
  [...el.querySelectorAll<HTMLAnchorElement>('a[href]')].slice(0, MAX_LINKS).map((a) => ({ text: a.textContent ?? '', href: a.href }));
