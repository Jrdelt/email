import {
  SVG_NS,
  XLINK_NS,
  closestEl,
  eventElement,
  getAttr,
  getAttrNS,
  hasAttr,
  ownerDocOf,
  queryAll,
  resolveAgainstBase,
  rmAttr,
  rmAttrNS,
  setAttr,
  setAttrNS,
  tagOf,
  useLinks,
} from '../dom';
import { hostOf } from '../domain';
import { holdDisabled, releaseDisabled } from './ariaDisabled';
import { removePausedLinkToast, showPausedLinkToast } from './linkToast';

// Disables links (including SVG href/xlink:href, ping beacons, and keyboard activation),
// embedded image links, image maps, forms, and [formaction] overrides inside a flagged email
// until unlocked, automatically re-locking dynamically added nodes inside the container.
const LOCK_ATTR = 'data-ped-locked';
const HREF_ATTR = 'data-ped-href';
const XLINK_ATTR = 'data-ped-xlink-href';
const PING_ATTR = 'data-ped-ping';
const ACTION_ATTR = 'data-ped-action';
const FORMACTION_ATTR = 'data-ped-formaction';
const STYLE_ID = 'ped-lock-style';

const styles = new WeakMap<Document, HTMLStyleElement>();
const watchers = new WeakMap<HTMLElement, MutationObserver>();
const blockedHandlers = new WeakMap<Document, () => void>();

export function setLinkBlockedHandler(doc: Document, handler: (() => void) | null): void {
  if (handler) blockedHandlers.set(doc, handler);
  else blockedHandlers.delete(doc);
}

function matchesLockedTarget(el: Element): boolean {
  if (
    closestEl(
      el,
      `a[href], a[${HREF_ATTR}], a[${XLINK_ATTR}], area[href], area[${HREF_ATTR}], [formaction], [${FORMACTION_ATTR}], form button:not([type="button"]), form input[type="submit"], form input[type="image"]`,
    )
  ) {
    return true;
  }
  // Any SVG <a> is a navigation target, even without href: SMIL <set>/<animate> can supply one.
  const a = closestEl(el, 'a');
  if (a && (a.namespaceURI === SVG_NS || getAttrNS(a, XLINK_NS, 'href') !== null || hasAttr(a, 'xlink:href'))) return true;
  // A click on an SVG <use> instance of a link reaches us retargeted to the <use> element. One whose links could not
  // all be followed may render a link too (fail closed).
  const use = closestEl(el, 'use');
  if (!use) return false;
  const rendered = useLinks(use);
  return rendered.links.length > 0 || rendered.truncated;
}

/**
 * The unresolved target of one locked control as the lock recorded it in the isolated world, or its live attribute
 * (one the lock has not stashed yet). Only the attribute that element type navigates with counts: a form posts to
 * its action, a button or input to its formaction, a link to its href. Never the page-visible data-ped-* copies:
 * the email can write those itself, and the toast would then name a host the action does not go to.
 */
function recordedTarget(node: Element): string | null {
  const st = stashes.get(node);
  const tag = tagOf(node);
  if (tag === 'form') return st?.get('action') ?? getAttr(node, 'action');
  if (tag === 'button' || tag === 'input') return st?.get('formaction') ?? getAttr(node, 'formaction');
  return (
    st?.get('href') ??
    getAttr(node, 'href') ??
    st?.get('xlink:href') ??
    getAttrNS(node, XLINK_NS, 'href') ??
    getAttr(node, 'xlink:href')
  );
}

/** Where a blocked action goes, for the toast; '' (a generic message) when that cannot be told for sure. */
function targetHostOf(el: Element): string {
  const use = closestEl(el, 'use');
  const node = closestEl(el, 'a, area, button, input, form') ?? (use ? (useLinks(use).links[0] ?? null) : null);
  if (!node) return '';
  // SMIL can retarget an SVG link to somewhere its href does not say (the lock pauses the animation, so its value
  // is not live now): name no host rather than one the link may not go to once unlocked.
  if (node.namespaceURI === SVG_NS && queryAll(ownerDocOf(node).documentElement, 'set, animate').length > 0) return '';
  let raw = recordedTarget(node);
  // A submit button without its own formaction posts to its form's action.
  if (raw === null && tagOf(node) !== 'form' && tagOf(node) !== 'a' && tagOf(node) !== 'area') {
    const form = closestEl(node, 'form');
    raw = form ? recordedTarget(form) : null;
  }
  raw = (raw ?? '').trim();
  if (!raw) return '';
  return hostOf(resolveAgainstBase(raw, ownerDocOf(el).baseURI || 'https://invalid.local'));
}

function notifyBlocked(el: Element) {
  const doc = ownerDocOf(el);
  showPausedLinkToast(doc, targetHostOf(el), el instanceof HTMLElement ? el : null);
  blockedHandlers.get(doc)?.();
}

function block(e: Event) {
  const el = eventElement(e);
  if (!el || !closestEl(el, `[${LOCK_ATTR}]`)) return;
  if (e.type === 'submit') {
    if (closestEl(el, 'form')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      notifyBlocked(el);
    }
    return;
  }
  if (e.type === 'keydown') {
    const key = (e as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
  }
  if (matchesLockedTarget(el)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    const shouldToast =
      e.type === 'click' ||
      e.type === 'keydown' ||
      (e.type === 'auxclick' && (e as MouseEvent).button === 1);
    if (shouldToast) notifyBlocked(el);
  }
}

/**
 * Idempotent on purpose: document.open() (used to write some message iframes) erases a document's listeners and
 * content but keeps the same Document object, so re-adding (a no-op when present) is what keeps the lock armed.
 */
function install(doc: Document) {
  for (const type of ['click', 'auxclick', 'dragstart', 'submit', 'keydown']) {
    doc.addEventListener(type, block, true);
  }
  if (styles.get(doc)?.isConnected) return;
  const parent = doc.head ?? doc.documentElement;
  if (!parent) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href], a[${XLINK_ATTR}], area[${HREF_ATTR}], area[href]){cursor:not-allowed!important;text-decoration:line-through!important;opacity:.6!important}`,
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href], a[${XLINK_ATTR}]) img{cursor:not-allowed!important;opacity:.65!important;outline:2px dashed #b91c1c!important;outline-offset:-2px!important}`,
    `[${LOCK_ATTR}] :is([formaction], [${FORMACTION_ATTR}], form :is(button:not([type="button"]), input[type="submit"], input[type="image"])){cursor:not-allowed!important;opacity:.6!important}`,
  ].join('');
  parent.appendChild(style);
  styles.set(doc, style);
}

// What this lock removed, recorded in the isolated world: email HTML can pre-seed or edit the page-visible
// data-ped-* copies, but cannot change what gets restored or stop a live attribute from being stashed.
type Stash = Map<string, string>; // attribute key -> original value
const stashes = new WeakMap<Element, Stash>();
const stashedIn = new WeakMap<HTMLElement, Set<Element>>(); // container -> elements it stashed
const ARIA_HOLDER = 'links';
// SVG SMIL can retarget an <a> without any href attribute: <set|animate attributeName="href" to=...>.
const ANIM_ATTR = 'data-ped-anim-attr';
const ANIMATED_LINK_ATTRS = new Set(['href', 'xlink:href']);
// Local names: a namespaced xlink:href change is reported as 'href' (attributeFilter would miss it entirely).
const WATCHED_ATTRS = new Set(['href', 'xlink:href', 'ping', 'action', 'formaction', 'attributename']);
const MIN_PRUNE = 256;
const pruneAt = new WeakMap<HTMLElement, number>();

function trackedIn(container: HTMLElement): Set<Element> {
  let set = stashedIn.get(container);
  if (!set) stashedIn.set(container, (set = new Set()));
  return set;
}

function record(container: HTMLElement, el: Element, key: string, value: string): void {
  let st = stashes.get(el);
  if (!st) stashes.set(el, (st = new Map()));
  st.set(key, value);
  trackedIn(container).add(el);
}

/** True when a mutation batch may have added a live link target the lock must stash. */
export function touchesLinkTargets(records: readonly MutationRecord[]): boolean {
  return records.some(
    (r) => r.type === 'childList' || WATCHED_ATTRS.has((r.attributeName ?? '').toLowerCase()),
  );
}

/**
 * Forget stashed elements the webmail has since removed, so a container that stays locked while its content is
 * re-rendered does not keep old DOM alive. Records stay in the WeakMap: re-inserted elements are tracked again.
 */
function pruneDetached(container: HTMLElement): void {
  const set = stashedIn.get(container);
  if (!set || set.size < (pruneAt.get(container) ?? MIN_PRUNE)) return;
  for (const el of set) if (!container.contains(el)) set.delete(el);
  pruneAt.set(container, Math.max(MIN_PRUNE, set.size * 2));
}

function stashInside(container: HTMLElement): void {
  pruneDetached(container);
  const tracked = trackedIn(container);
  // Re-track elements stashed earlier (found by their page-visible markers too, as their live attribute is gone);
  // restoring still uses only the isolated-world records.
  for (const el of container.querySelectorAll<Element>(
    `a, area, form, set, animate, [formaction], [${FORMACTION_ATTR}], [${ACTION_ATTR}], [${ANIM_ATTR}]`,
  )) {
    if (stashes.has(el)) tracked.add(el);
  }
  for (const el of container.querySelectorAll<Element>('a, area')) {
    const href = getAttr(el, 'href');
    if (href !== null) {
      record(container, el, 'href', href);
      setAttr(el, HREF_ATTR, href);
      rmAttr(el, 'href');
      holdDisabled(el, ARIA_HOLDER);
    }
    const xhref = getAttrNS(el, XLINK_NS, 'href') ?? getAttr(el, 'xlink:href');
    if (xhref !== null) {
      record(container, el, 'xlink:href', xhref);
      setAttr(el, XLINK_ATTR, xhref);
      rmAttrNS(el, XLINK_NS, 'href');
      rmAttr(el, 'xlink:href');
      holdDisabled(el, ARIA_HOLDER);
    }
    const ping = getAttr(el, 'ping');
    if (ping !== null) {
      record(container, el, 'ping', ping);
      setAttr(el, PING_ATTR, ping);
      rmAttr(el, 'ping');
    }
  }
  for (const form of container.querySelectorAll<HTMLFormElement>('form')) {
    const action = getAttr(form, 'action');
    if (action !== null) {
      record(container, form, 'action', action);
      setAttr(form, ACTION_ATTR, action);
      rmAttr(form, 'action');
    }
  }
  for (const el of container.querySelectorAll<Element>('[formaction]')) {
    const fa = getAttr(el, 'formaction')!;
    record(container, el, 'formaction', fa);
    setAttr(el, FORMACTION_ATTR, fa);
    rmAttr(el, 'formaction');
    holdDisabled(el, ARIA_HOLDER);
  }
  for (const anim of container.querySelectorAll<Element>('set, animate')) {
    const target = getAttr(anim, 'attributeName');
    if (target !== null && ANIMATED_LINK_ATTRS.has(target.trim().toLowerCase())) {
      record(container, anim, 'attributeName', target);
      setAttr(anim, ANIM_ATTR, target);
      rmAttr(anim, 'attributeName');
    }
  }
}

function restore(el: Element, st: Stash): void {
  for (const [key, value] of st) {
    if (key === 'xlink:href') {
      if (el.namespaceURI === SVG_NS) setAttrNS(el, XLINK_NS, 'xlink:href', value);
      else setAttr(el, 'xlink:href', value);
    } else {
      setAttr(el, key, value);
    }
  }
  for (const attr of [HREF_ATTR, XLINK_ATTR, PING_ATTR, ACTION_ATTR, FORMACTION_ATTR, ANIM_ATTR]) rmAttr(el, attr);
  releaseDisabled(el, ARIA_HOLDER);
}

export function lockLinks(container: HTMLElement): void {
  install(ownerDocOf(container));
  setAttr(container, LOCK_ATTR, '');
  stashInside(container);
  if (!watchers.has(container) && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver((records) => {
      if (hasAttr(container, LOCK_ATTR) && touchesLinkTargets(records)) stashInside(container);
    });
    // Also watch link attributes: the webmail (or a lock being lifted elsewhere) may set href after we locked.
    obs.observe(container, { childList: true, subtree: true, attributes: true });
    watchers.set(container, obs);
  }
}

export function unlockLinks(container: HTMLElement): void {
  watchers.get(container)?.disconnect();
  watchers.delete(container);
  rmAttr(container, LOCK_ATTR);
  removePausedLinkToast(ownerDocOf(container));
  for (const el of stashedIn.get(container) ?? []) {
    const st = stashes.get(el);
    stashes.delete(el);
    if (st) restore(el, st);
  }
  stashedIn.delete(container);
}

export const isLocked = (container: HTMLElement) => hasAttr(container, LOCK_ATTR);
