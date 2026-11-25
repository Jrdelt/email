import { cleanAttachmentName } from '../attachments';
import { closestEl, getAttr, hasAttr, isFormEl, ownerDocOf, resolveAgainstBase, resolveAnchorHref, tagOf, textOf } from '../dom';
import { safePercentDecode, type Link } from '../features';
import type { AttachmentRef } from './types';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;
/**
 * Safety bound on attachment elements collected per source (inline anchors, or one adapter's chips).
 * This bounds DOM work only: names analysed for the banner are capped separately (attachments.ts), and
 * when inline downloads exceed it the whole body is locked as an attachment instead of leaving extras live.
 */
export const MAX_ATTACHMENTS = 500;

/** True when the element or an ancestor is `[hidden]` or `[aria-hidden="true"]`. */
export const isHidden = (el: Element): boolean => closestEl(el, '[hidden], [aria-hidden="true"]') !== null;

/**
 * True for elements adapters must not use as a message, header or attachment node. `<form>` elements in
 * email HTML can override built-in properties (`<input name="contains">`), which would otherwise throw
 * mid-scan and leave the email unscanned and unlocked.
 */
export const isUnsafeNode = (el: Element): boolean => isFormEl(el);

/**
 * True when `el` sits inside another element matching any of `selectors`. Adapters use it so that an element
 * in the email HTML carrying a body marker (aria-label="Message body", data-testid=...) cannot replace the real
 * body as the scanned and locked container: only the outermost body candidate counts.
 */
export function isNestedIn(el: Element, selectors: readonly string[]): boolean {
  const parent = el.parentElement;
  return parent !== null && closestEl(parent, selectors.join(', ')) !== null;
}

export const bodyText = (el: HTMLElement) => textOf(el).slice(0, MAX_BODY_CHARS);

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
  if (isUnsafeNode(el)) return null;
  const text = textOf(el).trim();
  const fb = (text.length <= 120 && !text.includes('@') ? text : '') || fallbackName;
  if (tagOf(el) === 'a') {
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
  const base = ownerDocOf(el).baseURI || 'https://invalid.local';
  const out: Link[] = [];
  for (const node of el.querySelectorAll('a, area, form, [formaction], [data-ped-formaction], [data-ped-att-formaction]')) {
    if (out.length >= MAX_LINKS) break;
    const tag = tagOf(node);
    if (tag === 'a' || tag === 'area') {
      const href = resolveAnchorHref(node, true);
      if (href) out.push({ text: textOf(node), href });
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
      if (href) out.push({ text: (textOf(node) || getAttr(node, 'value') || '').trim(), href });
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

/**
 * Extract inline download/data:/blob: links inside an email body container: `<a>` and `<area>`, SVG `<a>`
 * with `xlink:href`, and stashed (locked) attributes. The scheme is read from the parsed URL, so case,
 * leading spaces and embedded tabs/newlines (` data:`, `da&#10;ta:`) are normalised the way the browser does.
 * If there are more than MAX_ATTACHMENTS, the container itself is returned as the last entry so the whole
 * body is attachment-locked rather than leaving the extra downloads live.
 */
export function inlineAttachmentsIn(container: HTMLElement): AttachmentRef[] {
  const base = ownerDocOf(container).baseURI || 'https://invalid.local';
  const out: AttachmentRef[] = [];

  for (const el of container.querySelectorAll<HTMLElement>('a, area')) {
    const dl = getAttr(el, 'download') ?? getAttr(el, 'data-ped-att-download');
    const href = resolveAnchorHref(el, true);
    if (dl === null && !href.startsWith('data:') && !href.startsWith('blob:')) continue;
    if (out.length >= MAX_ATTACHMENTS) {
      out.push({ name: '', element: container });
      break;
    }
    const dlAttr = dl ?? '';
    const name = cleanAttachmentName(
      dlAttr ||
        filenameFromHref(href, base) ||
        getAttr(el, 'aria-label') ||
        getAttr(el, 'title') ||
        textOf(el) ||
        '',
    );
    out.push({ name, element: el });
  }
  return out;
}
