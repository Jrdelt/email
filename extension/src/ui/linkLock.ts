import {
  SVG_NS,
  XLINK_NS,
  closestEl,
  eventElement,
  getAttr,
  getAttrNS,
  hasAttr,
  ownerDocOf,
  resolveAgainstBase,
  rmAttr,
  rmAttrNS,
  setAttr,
  setAttrNS,
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

const installed = new WeakSet<Document>();
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
  return Boolean(a && (a.namespaceURI === SVG_NS || getAttrNS(a, XLINK_NS, 'href') !== null || hasAttr(a, 'xlink:href')));
}

function targetHostOf(el: Element): string {
  const node = closestEl(el, `a, area, [formaction], [${FORMACTION_ATTR}], form`);
  if (!node) return '';
  const raw =
    getAttr(node, HREF_ATTR) ??
    getAttr(node, 'href') ??
    getAttr(node, XLINK_ATTR) ??
    getAttrNS(node, XLINK_NS, 'href') ??
    getAttr(node, 'xlink:href') ??
    getAttr(node, FORMACTION_ATTR) ??
    getAttr(node, 'formaction') ??
    getAttr(node, ACTION_ATTR) ??
    getAttr(node, 'action') ??
    '';
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

function install(doc: Document) {
  if (installed.has(doc)) return;
  installed.add(doc);
  for (const type of ['click', 'auxclick', 'dragstart', 'submit', 'keydown']) {
    doc.addEventListener(type, block, true);
  }
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href], a[${XLINK_ATTR}], area[${HREF_ATTR}], area[href]){cursor:not-allowed!important;text-decoration:line-through!important;opacity:.6!important}`,
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href], a[${XLINK_ATTR}]) img{cursor:not-allowed!important;opacity:.65!important;outline:2px dashed #b91c1c!important;outline-offset:-2px!important}`,
    `[${LOCK_ATTR}] :is([formaction], [${FORMACTION_ATTR}], form :is(button:not([type="button"]), input[type="submit"], input[type="image"])){cursor:not-allowed!important;opacity:.6!important}`,
  ].join('');
  (doc.head ?? doc.documentElement).appendChild(style);
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
const WATCHED_ATTRS = ['href', 'xlink:href', 'ping', 'action', 'formaction', 'attributeName'];

function record(container: HTMLElement, el: Element, key: string, value: string): void {
  let st = stashes.get(el);
  if (!st) stashes.set(el, (st = new Map()));
  st.set(key, value);
  let set = stashedIn.get(container);
  if (!set) stashedIn.set(container, (set = new Set()));
  set.add(el);
}

function stashInside(container: HTMLElement): void {
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
    const obs = new MutationObserver(() => {
      if (hasAttr(container, LOCK_ATTR)) stashInside(container);
    });
    // Also watch link attributes: the webmail (or a lock being lifted elsewhere) may set href after we locked.
    obs.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRS });
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
