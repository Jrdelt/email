// DOM-clobbering-safe attribute helpers and cross-SVG/HTML link resolution.
// Untrusted HTML emails containing <form><input name="getAttribute"><input name="hasAttribute"></form>
// shadow methods on HTMLFormElement instances, so always invoke Element.prototype methods directly.

export const XLINK_NS = 'http://www.w3.org/1999/xlink';
export const SVG_NS = 'http://www.w3.org/2000/svg';

const hasElement = typeof Element !== 'undefined';
const protoGetAttr = hasElement ? Element.prototype.getAttribute : undefined;
const protoSetAttr = hasElement ? Element.prototype.setAttribute : undefined;
const protoRmAttr = hasElement ? Element.prototype.removeAttribute : undefined;
const protoHasAttr = hasElement ? Element.prototype.hasAttribute : undefined;
const protoGetAttrNS = hasElement ? Element.prototype.getAttributeNS : undefined;
const protoSetAttrNS = hasElement ? Element.prototype.setAttributeNS : undefined;
const protoRmAttrNS = hasElement ? Element.prototype.removeAttributeNS : undefined;

export const getAttr = (el: Element, name: string): string | null =>
  (protoGetAttr ?? Element.prototype.getAttribute).call(el, name);
export const setAttr = (el: Element, name: string, value: string): void =>
  (protoSetAttr ?? Element.prototype.setAttribute).call(el, name, value);
export const rmAttr = (el: Element, name: string): void =>
  (protoRmAttr ?? Element.prototype.removeAttribute).call(el, name);
export const hasAttr = (el: Element, name: string): boolean =>
  (protoHasAttr ?? Element.prototype.hasAttribute).call(el, name);
export const getAttrNS = (el: Element, ns: string, local: string): string | null =>
  (protoGetAttrNS ?? Element.prototype.getAttributeNS).call(el, ns, local);
export const setAttrNS = (el: Element, ns: string, qn: string, value: string): void =>
  (protoSetAttrNS ?? Element.prototype.setAttributeNS).call(el, ns, qn, value);
export const rmAttrNS = (el: Element, ns: string, local: string): void =>
  (protoRmAttrNS ?? Element.prototype.removeAttributeNS).call(el, ns, local);

/** Resolve event.target to an Element even when dispatched on a Text node. */
export function eventElement(e: Event): Element | null {
  const node = e.target as Node | null;
  return node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
}

export function resolveAgainstBase(raw: string, base: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed, base).href;
  } catch {
    return trimmed;
  }
}

/** Resolve href or SVG xlink:href (plus optional stashed attributes) on an <a> or <area> element. */
export function resolveAnchorHref(el: Element, includeStashed = false): string {
  const base = el.ownerDocument.baseURI || 'https://invalid.local';
  if (hasAttr(el, 'href')) {
    const prop = (el as HTMLAnchorElement).href;
    if (typeof prop === 'string' && prop) return prop;
    return resolveAgainstBase(getAttr(el, 'href') ?? '', base);
  }
  const xhref = getAttrNS(el, XLINK_NS, 'href') ?? getAttr(el, 'xlink:href');
  if (xhref !== null) return resolveAgainstBase(xhref, base);
  if (includeStashed) {
    const stashed =
      getAttr(el, 'data-ped-href') ?? getAttr(el, 'data-ped-att-href') ?? getAttr(el, 'data-ped-xlink-href');
    if (stashed !== null) return resolveAgainstBase(stashed, base);
  }
  return '';
}
