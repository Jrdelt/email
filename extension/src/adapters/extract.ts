import type { Link } from '../features';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;

const XLINK_NS = 'http://www.w3.org/1999/xlink';

function resolveUrl(raw: string, base: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

export const bodyText = (el: HTMLElement) => (el.textContent ?? '').slice(0, MAX_BODY_CHARS);

export const linksIn = (el: HTMLElement): Link[] => {
  const base = el.ownerDocument.baseURI || 'https://invalid.local';
  const out: Link[] = [];
  for (const node of el.querySelectorAll('a, area, form, [formaction], [data-ped-formaction]')) {
    if (out.length >= MAX_LINKS) break;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      let href = '';
      if (node.hasAttribute('href')) {
        const prop = (node as HTMLAnchorElement).href;
        href = typeof prop === 'string' ? prop : resolveUrl(node.getAttribute('href') ?? '', base);
      } else if (node.hasAttribute('data-ped-href')) {
        href = resolveUrl(node.getAttribute('data-ped-href') ?? '', base);
      } else {
        const xhref =
          node.getAttributeNS(XLINK_NS, 'href') ??
          node.getAttribute('xlink:href') ??
          node.getAttribute('data-ped-xlink-href');
        if (xhref !== null) href = resolveUrl(xhref, base);
      }
      if (href) out.push({ text: node.textContent ?? '', href });
    } else if (tag === 'form') {
      const raw = node.getAttribute('action') ?? node.getAttribute('data-ped-action') ?? '';
      const href = resolveUrl(raw, base);
      if (href) out.push({ text: '', href });
    } else {
      const raw = node.getAttribute('formaction') ?? node.getAttribute('data-ped-formaction') ?? '';
      const href = resolveUrl(raw, base);
      if (href) out.push({ text: (node.textContent || node.getAttribute('value') || '').trim(), href });
    }
  }
  return out;
};
