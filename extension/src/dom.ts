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

/**
 * Read a built-in DOM property from the object's prototype chain. `<form>` elements expose their named
 * controls as properties that override built-ins (`<input name="closest">` makes `form.closest` an
 * <input>), so `form.tagName`, `form.closest(...)`, `form.textContent` etc. cannot be trusted.
 * Reading through the prototype skips those named-property shadows.
 */
function builtin<T>(obj: object, prop: string): T {
  const v = Reflect.get(Object.getPrototypeOf(obj) as object, prop, obj) as T | undefined;
  return v === undefined ? (Reflect.get(obj, prop) as T) : v;
}

/** Lowercase local tag name ('a', 'form', ...) that email-controlled `<form>` named controls cannot clobber. */
export const tagOf = (el: Element): string => String(builtin<string>(el, 'localName') ?? '').toLowerCase();
/** True for `<form>` elements: the only elements whose built-in properties email HTML can clobber. */
export const isFormEl = (el: Element): boolean => tagOf(el) === 'form';
export const closestEl = (el: Element, selector: string): Element | null =>
  builtin<Element['closest']>(el, 'closest').call(el, selector);
export const containsNode = (parent: Node, child: Node | null): boolean =>
  builtin<Node['contains']>(parent, 'contains').call(parent, child);
export const textOf = (node: Node): string => builtin<string | null>(node, 'textContent') ?? '';
export const ownerDocOf = (node: Node): Document => builtin<Document>(node, 'ownerDocument');
const parentElementOf = (node: Node): Element | null => builtin<Element | null>(node, 'parentElement') ?? null;

/** Resolve event.target to an Element even when dispatched on a Text node (clobbering-safe). */
export function eventElement(e: Event): Element | null {
  const node = e.target as Node | null;
  if (!node || typeof node !== 'object') return null;
  return builtin<number>(node, 'nodeType') === 1 ? (node as Element) : parentElementOf(node);
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
  const base = ownerDocOf(el).baseURI || 'https://invalid.local';
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
