import {
  SVG_NS,
  XLINK_NS,
  closestEl,
  eventElement,
  getAttr,
  getAttrNS,
  hasAttr,
  ownerDocOf,
  rmAttr,
  rmAttrNS,
  setAttr,
  setAttrNS,
} from '../dom';
import { holdDisabled, releaseDisabled } from './ariaDisabled';
import { removePausedLinkToast, showPausedAttachmentToast } from './linkToast';

const ATT_LOCK_ATTR = 'data-ped-att-locked';
const ATT_NAME_ATTR = 'data-ped-att-name';
const ATT_HREF_ATTR = 'data-ped-att-href';
const ATT_DL_ATTR = 'data-ped-att-download';
const ATT_DLURL_ATTR = 'data-ped-att-download-url';
const ATT_FA_ATTR = 'data-ped-att-formaction';
const ATT_STYLE_ID = 'ped-att-lock-style';

const STASHED_PAIRS: readonly [attr: string, stashAttr: string][] = [
  ['href', ATT_HREF_ATTR],
  ['download', ATT_DL_ATTR],
  ['download_url', ATT_DLURL_ATTR],
  ['formaction', ATT_FA_ATTR],
];

const installed = new WeakSet<Document>();
const watchers = new WeakMap<HTMLElement, MutationObserver>();
const blockedHandlers = new WeakMap<Document, () => void>();

/** Register a per-document callback fired when a user clicks a locked attachment. */
export function setAttachmentBlockedHandler(doc: Document, handler: (() => void) | null): void {
  if (handler) blockedHandlers.set(doc, handler);
  else blockedHandlers.delete(doc);
}

function blockAttachmentEvent(e: Event): void {
  const el = eventElement(e);
  const lockedRoot = el ? closestEl(el, `[${ATT_LOCK_ATTR}]`) : null;
  if (!el || !lockedRoot) return;

  if (e.type === 'keydown') {
    const key = (e as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
  }

  e.preventDefault();
  e.stopImmediatePropagation();

  const shouldToast =
    e.type === 'click' ||
    e.type === 'dblclick' ||
    e.type === 'keydown' ||
    (e.type === 'auxclick' && (e as MouseEvent).button === 1);
  if (shouldToast) {
    const namedEl = closestEl(el, `[${ATT_NAME_ATTR}]`);
    const name = (namedEl ? getAttr(namedEl, ATT_NAME_ATTR) : null) ?? getAttr(lockedRoot, ATT_NAME_ATTR) ?? '';
    const doc = ownerDocOf(lockedRoot);
    showPausedAttachmentToast(doc, name, el instanceof HTMLElement ? el : null);
    blockedHandlers.get(doc)?.();
  }
}

function install(doc: Document): void {
  if (installed.has(doc)) return;
  installed.add(doc);
  for (const type of ['click', 'auxclick', 'dblclick', 'mousedown', 'pointerdown', 'dragstart', 'submit', 'keydown']) {
    doc.addEventListener(type, blockAttachmentEvent, true);
  }
  const style = doc.createElement('style');
  style.id = ATT_STYLE_ID;
  style.textContent = [
    `[${ATT_LOCK_ATTR}]{cursor:not-allowed!important;opacity:.55!important;outline:2px dashed #b91c1c!important;outline-offset:-2px!important;border-radius:8px!important}`,
    `[${ATT_LOCK_ATTR}] :is(a,area,button,[role="button"]){cursor:not-allowed!important}`,
  ].join('');
  (doc.head ?? doc.documentElement).appendChild(style);
}

// What this lock removed, recorded in the isolated world (see linkLock.ts): email HTML cannot pre-seed
// data-ped-att-* attributes to keep a live href/download, nor change what is restored on unlock.
const stashes = new WeakMap<Element, Map<string, string>>();
const stashedIn = new WeakMap<HTMLElement, Set<Element>>(); // locked root -> elements it stashed
const ARIA_HOLDER = 'attachments';
const XLINK_STASH_ATTR = 'data-ped-att-xlink-href';
const WATCHED_ATTRS = ['href', 'xlink:href', 'download', 'download_url', 'formaction'];

function stashTarget(root: HTMLElement): void {
  const targets = [
    root,
    ...root.querySelectorAll<Element>('a, area, button, [href], [download], [download_url], [formaction]'),
  ];
  let set = stashedIn.get(root);
  if (!set) stashedIn.set(root, (set = new Set()));
  for (const el of targets) {
    let st = stashes.get(el);
    for (const [attr, stashAttr] of STASHED_PAIRS) {
      const v = getAttr(el, attr);
      if (v === null) continue;
      if (!st) stashes.set(el, (st = new Map()));
      st.set(attr, v);
      setAttr(el, stashAttr, v);
      rmAttr(el, attr);
    }
    const xhref = getAttrNS(el, XLINK_NS, 'href') ?? getAttr(el, 'xlink:href');
    if (xhref !== null) {
      if (!st) stashes.set(el, (st = new Map()));
      st.set('xlink:href', xhref);
      setAttr(el, XLINK_STASH_ATTR, xhref);
      rmAttrNS(el, XLINK_NS, 'href');
      rmAttr(el, 'xlink:href');
    }
    holdDisabled(el, ARIA_HOLDER);
    set.add(el);
  }
}

/** Lock attachment cards/shelves/links so untrusted email attachments cannot be opened or downloaded. */
export function lockAttachments(elements: readonly HTMLElement[], names?: ReadonlyMap<HTMLElement, string>): void {
  for (const el of elements) {
    install(ownerDocOf(el));
    setAttr(el, ATT_LOCK_ATTR, '');
    const name = names?.get(el);
    if (name) setAttr(el, ATT_NAME_ATTR, name);
    stashTarget(el);
    if (!watchers.has(el) && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(() => {
        if (hasAttr(el, ATT_LOCK_ATTR)) stashTarget(el);
      });
      obs.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRS });
      watchers.set(el, obs);
    }
  }
}

/** Restore stashed attributes and re-enable attachment elements once the email/sender is trusted. */
export function unlockAttachments(elements: readonly HTMLElement[]): void {
  const docs = new Set<Document>();
  for (const root of elements) {
    watchers.get(root)?.disconnect();
    watchers.delete(root);
    rmAttr(root, ATT_LOCK_ATTR);
    rmAttr(root, ATT_NAME_ATTR);
    for (const el of stashedIn.get(root) ?? []) {
      // An element inside another still-locked attachment stays stashed and is handed to that root.
      const outer = closestEl(el, `[${ATT_LOCK_ATTR}]`) as HTMLElement | null;
      if (outer) {
        let set = stashedIn.get(outer);
        if (!set) stashedIn.set(outer, (set = new Set()));
        set.add(el);
        continue;
      }
      const st = stashes.get(el);
      stashes.delete(el);
      for (const [attr, v] of st ?? []) {
        if (attr === 'xlink:href') {
          if (el.namespaceURI === SVG_NS) setAttrNS(el, XLINK_NS, 'xlink:href', v);
          else setAttr(el, 'xlink:href', v);
        } else {
          setAttr(el, attr, v);
        }
      }
      for (const [, stashAttr] of STASHED_PAIRS) rmAttr(el, stashAttr);
      rmAttr(el, XLINK_STASH_ATTR);
      releaseDisabled(el, ARIA_HOLDER);
    }
    stashedIn.delete(root);
    docs.add(ownerDocOf(root));
  }
  for (const doc of docs) removePausedLinkToast(doc);
}

export const isAttachmentLocked = (el: HTMLElement): boolean => hasAttr(el, ATT_LOCK_ATTR);
