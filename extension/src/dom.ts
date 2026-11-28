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
const protoQsa = hasElement ? Element.prototype.querySelectorAll : undefined;

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

/** querySelectorAll that a `<form>`'s named controls cannot shadow. */
export const queryAll = (el: Element, selector: string): Element[] => [
  ...(protoQsa ?? Element.prototype.querySelectorAll).call(el, selector),
];

/** The current SMIL-animated href of an SVG element (`<set>/<animate attributeName="href">`), or ''. */
function animatedHref(el: Element): string {
  if (el.namespaceURI !== SVG_NS) return '';
  const anim = (el as unknown as { href?: { animVal?: unknown } }).href?.animVal;
  return typeof anim === 'string' ? anim.trim() : '';
}

/**
 * The unresolved target an <a>/<area> navigates to right now: an SVG link's animated value first (SMIL can
 * retarget `<a href="#">` anywhere), then href, then xlink:href. '' when there is none.
 */
export function rawLinkTarget(el: Element): string {
  return (animatedHref(el) || getAttr(el, 'href') || getAttrNS(el, XLINK_NS, 'href') || getAttr(el, 'xlink:href') || '').trim();
}

const MAX_USE_DEPTH = 4;
const MAX_USE_LINKS = 20;

/**
 * Links an SVG `<use>` renders. A click on its (closed) shadow instance is retargeted to the `<use>` element, so
 * `closest('a')` finds nothing, yet an instanced `<a>` still navigates. Follows same-document `#id` references,
 * including `<use>` chains, and returns the referenced `<a>` (or the one containing it) or the links in it.
 *
 * The walk is bounded (nesting depth, links, `<use>` elements visited) but the browser renders everything: when a
 * bound is reached while links (or further `<use>`) remain, `truncated` is true and callers must fail closed,
 * because the clicked link may be one that was never looked at. A cycle is not truncation: browsers render nothing
 * for a `<use>` that references itself.
 */
export function useLinks(use: Element): { links: Element[]; truncated: boolean } {
  const out = new Set<Element>();
  const seen = new Set<Element>();
  let truncated = false;
  const add = (link: Element): void => {
    if (out.has(link)) return;
    if (out.size >= MAX_USE_LINKS) truncated = true;
    else out.add(link);
  };
  const visit = (u: Element, depth: number): void => {
    if (truncated || seen.has(u)) return;
    const ref = useReference(u);
    if (!ref) return;
    // The instance clones the referenced element and its descendants only, never an <a> around it.
    const tag = tagOf(ref);
    const isLink = tag === 'a' || tag === 'area';
    if (depth >= MAX_USE_DEPTH || seen.size >= MAX_USE_LINKS) {
      // Link-free icon sprites nest freely; only a reference that can still render a link is unknowable.
      if (isLink || queryAll(ref, 'a, area, use').length > 0) truncated = true;
      return;
    }
    seen.add(u);
    if (isLink) {
      add(ref);
      return;
    }
    for (const el of queryAll(ref, 'a, area, use')) {
      if (truncated) return;
      if (tagOf(el) === 'use') visit(el, depth + 1);
      else add(el);
    }
  };
  visit(use, 0);
  return { links: [...out], truncated };
}

/** The same-document element a `<use>` points at (`href`, SMIL-animated href, or xlink:href), if any. */
function useReference(use: Element): Element | null {
  return sameDocumentTarget(use, animatedHref(use) || getAttr(use, 'href') || getAttrNS(use, XLINK_NS, 'href') || getAttr(use, 'xlink:href') || '');
}

/**
 * The element a SMIL `<set>`/`<animate>` changes: the one its own href/xlink:href points at in this document
 * (`aimed`, also when a lock has stashed that href), otherwise its parent element.
 */
export function animationTarget(anim: Element): { target: Element | null; aimed: boolean } {
  const ref =
    getAttr(anim, 'href') ??
    getAttrNS(anim, XLINK_NS, 'href') ??
    getAttr(anim, 'xlink:href') ??
    getAttr(anim, 'data-ped-att-href') ??
    getAttr(anim, 'data-ped-att-xlink-href');
  if (ref === null) return { target: parentElementOf(anim), aimed: false };
  return { target: sameDocumentTarget(anim, ref), aimed: true };
}

/** Resolve a `#id` (or same-document `page#id`) reference made from `from` to an element of its document. */
function sameDocumentTarget(from: Element, raw: string): Element | null {
  const doc = ownerDocOf(from);
  const hash = raw.indexOf('#');
  if (hash < 0) return null;
  const before = raw.slice(0, hash).trim();
  if (before) {
    // Only same-document references can carry the email's own links.
    const resolved = resolveAgainstBase(before, doc.baseURI || 'https://invalid.local');
    if (resolved !== doc.URL.split('#')[0] && resolved !== (doc.baseURI || '').split('#')[0]) return null;
  }
  let id = raw.slice(hash + 1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep the raw id */
  }
  return id ? Document.prototype.getElementById.call(doc, id) : null;
}

/**
 * Resolve the navigation target of an <a> or <area>: href, SVG xlink:href, the SMIL-animated value of an SVG
 * <a> (<set>/<animate attributeName="href"> can retarget it, even with no href attribute), and optionally the
 * attributes stashed by the link/attachment locks.
 */
export function resolveAnchorHref(el: Element, includeStashed = false): string {
  const base = ownerDocOf(el).baseURI || 'https://invalid.local';
  const anim = animatedHref(el);
  if (anim) return resolveAgainstBase(anim, base);
  if (hasAttr(el, 'href')) {
    const prop = (el as HTMLAnchorElement).href;
    if (typeof prop === 'string' && prop) return prop;
    return resolveAgainstBase(getAttr(el, 'href') ?? '', base);
  }
  const xhref = getAttrNS(el, XLINK_NS, 'href') ?? getAttr(el, 'xlink:href');
  if (xhref !== null) return resolveAgainstBase(xhref, base);
  if (includeStashed) {
    const stashed =
      getAttr(el, 'data-ped-href') ??
      getAttr(el, 'data-ped-att-href') ??
      getAttr(el, 'data-ped-xlink-href') ??
      getAttr(el, 'data-ped-att-xlink-href');
    if (stashed !== null) return resolveAgainstBase(stashed, base);
  }
  return '';
}
