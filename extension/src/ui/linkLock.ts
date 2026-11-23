import {
  SVG_NS,
  XLINK_NS,
  eventElement,
  getAttr,
  getAttrNS,
  hasAttr,
  resolveAgainstBase,
  rmAttr,
  rmAttrNS,
  setAttr,
  setAttrNS,
} from '../dom';
import { hostOf } from '../domain';
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
const FORM_ATTR = 'data-ped-form-locked';
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
    el.closest(
      `a[href], a[${HREF_ATTR}], a[${XLINK_ATTR}], area[href], area[${HREF_ATTR}], [formaction], [${FORMACTION_ATTR}], form button:not([type="button"]), form input[type="submit"], form input[type="image"]`,
    )
  ) {
    return true;
  }
  const a = el.closest('a');
  return Boolean(a && (getAttrNS(a, XLINK_NS, 'href') !== null || hasAttr(a, 'xlink:href')));
}

function targetHostOf(el: Element): string {
  const node = el.closest(`a, area, [formaction], [${FORMACTION_ATTR}], form`);
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
  return hostOf(resolveAgainstBase(raw, el.ownerDocument.baseURI || 'https://invalid.local'));
}

function block(e: Event) {
  const el = eventElement(e);
  if (!el?.closest?.(`[${LOCK_ATTR}]`)) return;
  if (e.type === 'submit') {
    if (el.closest('form')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      showPausedLinkToast(el.ownerDocument, targetHostOf(el), el instanceof HTMLElement ? el : null);
      blockedHandlers.get(el.ownerDocument)?.();
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
    if (shouldToast) {
      showPausedLinkToast(el.ownerDocument, targetHostOf(el), el instanceof HTMLElement ? el : null);
      blockedHandlers.get(el.ownerDocument)?.();
    }
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

function stashInside(container: HTMLElement): void {
  for (const el of container.querySelectorAll<Element>('a, area')) {
    if (hasAttr(el, 'href') && !hasAttr(el, HREF_ATTR)) {
      setAttr(el, HREF_ATTR, getAttr(el, 'href')!);
      rmAttr(el, 'href');
      setAttr(el, 'aria-disabled', 'true');
    }
    const xhref = getAttrNS(el, XLINK_NS, 'href') ?? getAttr(el, 'xlink:href');
    if (xhref !== null && !hasAttr(el, XLINK_ATTR)) {
      setAttr(el, XLINK_ATTR, xhref);
      rmAttrNS(el, XLINK_NS, 'href');
      rmAttr(el, 'xlink:href');
      setAttr(el, 'aria-disabled', 'true');
    }
    if (hasAttr(el, 'ping') && !hasAttr(el, PING_ATTR)) {
      setAttr(el, PING_ATTR, getAttr(el, 'ping')!);
      rmAttr(el, 'ping');
    }
  }
  for (const form of container.querySelectorAll<HTMLFormElement>('form')) {
    if (hasAttr(form, 'action') && !hasAttr(form, ACTION_ATTR)) {
      setAttr(form, ACTION_ATTR, getAttr(form, 'action')!);
      rmAttr(form, 'action');
    }
    if (!hasAttr(form, FORM_ATTR)) setAttr(form, FORM_ATTR, '');
  }
  for (const el of container.querySelectorAll<Element>('[formaction]')) {
    if (!hasAttr(el, FORMACTION_ATTR)) {
      setAttr(el, FORMACTION_ATTR, getAttr(el, 'formaction')!);
      rmAttr(el, 'formaction');
      setAttr(el, 'aria-disabled', 'true');
    }
  }
}

export function lockLinks(container: HTMLElement): void {
  install(container.ownerDocument);
  setAttr(container, LOCK_ATTR, '');
  stashInside(container);
  if (!watchers.has(container) && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver((muts) => {
      if (!hasAttr(container, LOCK_ATTR)) return;
      if (muts.some((m) => m.addedNodes.length > 0)) stashInside(container);
    });
    obs.observe(container, { childList: true, subtree: true });
    watchers.set(container, obs);
  }
}

export function unlockLinks(container: HTMLElement): void {
  watchers.get(container)?.disconnect();
  watchers.delete(container);
  rmAttr(container, LOCK_ATTR);
  removePausedLinkToast(container.ownerDocument);
  for (const el of container.querySelectorAll<Element>(`[${HREF_ATTR}]`)) {
    setAttr(el, 'href', getAttr(el, HREF_ATTR)!);
    rmAttr(el, HREF_ATTR);
    if (!hasAttr(el, 'data-ped-att-locked')) rmAttr(el, 'aria-disabled');
  }
  for (const el of container.querySelectorAll<Element>(`[${XLINK_ATTR}]`)) {
    const val = getAttr(el, XLINK_ATTR)!;
    if (el.namespaceURI === SVG_NS) setAttrNS(el, XLINK_NS, 'xlink:href', val);
    else setAttr(el, 'xlink:href', val);
    rmAttr(el, XLINK_ATTR);
    if (!hasAttr(el, 'data-ped-att-locked')) rmAttr(el, 'aria-disabled');
  }
  for (const el of container.querySelectorAll<Element>(`[${PING_ATTR}]`)) {
    setAttr(el, 'ping', getAttr(el, PING_ATTR)!);
    rmAttr(el, PING_ATTR);
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${ACTION_ATTR}]`)) {
    setAttr(form, 'action', getAttr(form, ACTION_ATTR)!);
    rmAttr(form, ACTION_ATTR);
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${FORM_ATTR}]`)) {
    rmAttr(form, FORM_ATTR);
  }
  for (const el of container.querySelectorAll<Element>(`[${FORMACTION_ATTR}]`)) {
    setAttr(el, 'formaction', getAttr(el, FORMACTION_ATTR)!);
    rmAttr(el, FORMACTION_ATTR);
    if (!hasAttr(el, 'data-ped-att-locked')) rmAttr(el, 'aria-disabled');
  }
}

export const isLocked = (container: HTMLElement) => hasAttr(container, LOCK_ATTR);
