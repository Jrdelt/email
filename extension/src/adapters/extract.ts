import { cleanAttachmentName } from '../attachments';
import { getAttr, hasAttr, resolveAgainstBase, resolveAnchorHref } from '../dom';
import { safePercentDecode, type Link } from '../features';
import type { AttachmentRef } from './types';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;
export const MAX_ATTACHMENTS = 50;

export const isHidden = (el: HTMLElement): boolean =>
  el.hidden || getAttr(el, 'aria-hidden') === 'true' || el.closest('[hidden], [aria-hidden="true"]') !== null;

export const bodyText = (el: HTMLElement) => (el.textContent ?? '').slice(0, MAX_BODY_CHARS);

/** Parse a header string like `PayPal <a@b.com>`, `PayPal (a@b.com)`, or bare `a@b.com`. */
export function parseSenderHeader(
  raw: string,
  fallbackName = '',
): { senderName: string; senderAddress: string } | null {
  const cleaned = raw
    .trim()
    .replace(/^(?:from|sender)\s*:\s*/i, '')
    .replace(/^opens card for\s+/i, '')
    .trim();
  if (!cleaned) return null;
  const fb = fallbackName.trim();
  const fallback = fb && !fb.includes('@') ? fb : '';

  const angle = cleaned.match(/^(.*?)<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (angle) {
    return { senderName: angle[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: angle[2].trim() };
  }
  const paren = cleaned.match(/^(.*?)\(([^()@\s]+@[^()@\s]+)\)\s*$/);
  if (paren) {
    return { senderName: paren[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: paren[2].trim() };
  }
  const bare = cleaned.match(/([^\s<>"'(),;]+@[^\s<>"'(),;]+\.[^\s<>"'(),;]+)/);
  if (bare && bare.index !== undefined) {
    const before = cleaned.slice(0, bare.index).replace(/^[\s,:;\-"']+|[\s,:;\-"'<]+$/g, '').trim();
    return { senderName: before || fallback, senderAddress: bare[1].trim() };
  }
  return null;
}

/** Extract sender name and email address from a webmail header DOM node (`mailto:`, `data-email`, `aria-label`, `title`, or text). */
export function extractSenderFromElement(
  el: Element,
  fallbackName = '',
): { senderName: string; senderAddress: string } | null {
  const text = (el.textContent ?? '').trim();
  const fb = (text.length <= 120 && !text.includes('@') ? text : '') || fallbackName;
  if (el.tagName.toLowerCase() === 'a') {
    const href = getAttr(el, 'href') ?? '';
    if (href.toLowerCase().startsWith('mailto:')) {
      const addr = href.slice(7).split('?')[0].trim();
      if (addr) return { senderName: fb, senderAddress: addr };
    }
  }
  const dataEmail = (getAttr(el, 'data-email') ?? '').trim();
  if (dataEmail) {
    const parsed = parseSenderHeader(dataEmail, fb);
    if (parsed) return parsed;
  }
  return (
    parseSenderHeader(getAttr(el, 'aria-label') ?? '', fb) ??
    parseSenderHeader(getAttr(el, 'title') ?? '', fb) ??
    parseSenderHeader(text, fb)
  );
}

export const linksIn = (el: HTMLElement): Link[] => {
  const base = el.ownerDocument.baseURI || 'https://invalid.local';
  const out: Link[] = [];
  for (const node of el.querySelectorAll('a, area, form, [formaction], [data-ped-formaction], [data-ped-att-formaction]')) {
    if (out.length >= MAX_LINKS) break;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' || tag === 'area') {
      const href = resolveAnchorHref(node, true);
      if (href) out.push({ text: node.textContent ?? '', href });
    } else if (tag === 'form') {
      const raw = getAttr(node, 'action') ?? getAttr(node, 'data-ped-action') ?? '';
      const href = resolveAgainstBase(raw, base);
      if (href) out.push({ text: '', href });
    } else if (hasAttr(node, 'formaction') || hasAttr(node, 'data-ped-formaction') || hasAttr(node, 'data-ped-att-formaction')) {
      const raw =
        getAttr(node, 'formaction') ??
        getAttr(node, 'data-ped-formaction') ??
        getAttr(node, 'data-ped-att-formaction') ??
        '';
      const href = resolveAgainstBase(raw, base);
      if (href) out.push({ text: (node.textContent || getAttr(node, 'value') || '').trim(), href });
    }
  }
  return out;
};

function filenameFromHref(rawHref: string, base: string): string {
  const lower = rawHref.trim().toLowerCase();
  if (!lower || lower.startsWith('data:') || lower.startsWith('blob:')) return '';
  try {
    const seg = new URL(rawHref, base).pathname.split('/').pop() ?? '';
    return seg ? safePercentDecode(seg) : '';
  } catch {
    return '';
  }
}

/** Extract inline download/data/blob anchor attachments inside an email body container. */
export function inlineAttachmentsIn(container: HTMLElement): AttachmentRef[] {
  const base = container.ownerDocument.baseURI || 'https://invalid.local';
  const out: AttachmentRef[] = [];
  const seen = new Set<HTMLElement>();
  const sel =
    'a[download], a[data-ped-att-download], a[href^="data:" i], a[data-ped-href^="data:" i], a[data-ped-att-href^="data:" i], a[href^="blob:" i], a[data-ped-href^="blob:" i], a[data-ped-att-href^="blob:" i]';

  for (const el of container.querySelectorAll<HTMLElement>(sel)) {
    if (out.length >= MAX_ATTACHMENTS) break;
    if (seen.has(el)) continue;
    seen.add(el);
    const dlAttr = getAttr(el, 'download') ?? getAttr(el, 'data-ped-att-download') ?? '';
    const href = getAttr(el, 'href') ?? getAttr(el, 'data-ped-href') ?? getAttr(el, 'data-ped-att-href') ?? '';
    const name = cleanAttachmentName(
      dlAttr ||
        filenameFromHref(href, base) ||
        getAttr(el, 'aria-label') ||
        getAttr(el, 'title') ||
        el.textContent ||
        '',
    );
    out.push({ name, element: el });
  }
  return out;
}
