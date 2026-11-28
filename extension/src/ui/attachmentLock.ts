import {
  SVG_NS,
  XLINK_NS,
  closestEl,
  eventElement,
  getAttr,
  getAttrNS,
  hasAttr,
  ownerDocOf,
  parentElementOf,
  rmAttr,
  rmAttrNS,
  setAttr,
  setAttrNS,
} from '../dom';
import { holdDisabled, releaseDisabled } from './ariaDisabled';
import { removePausedLinkToast, showPausedAttachmentToast } from './linkToast';

const ATT_LOCK_ATTR = 'data-ped-att-locked';
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

const styles = new WeakMap<Document, HTMLStyleElement>();
const watchers = new WeakMap<HTMLElement, MutationObserver>();
const blockedHandlers = new WeakMap<Document, () => void>();
// The file name each attachment was locked with, kept in the isolated world. The toast never reads a name from the
// page: email HTML can put an attribute of its own on any element inside an attachment ("invoice.pdf" on a span in
// a link that downloads invoice.zip).
const lockedNames = new WeakMap<Element, string>();

/** The name the closest locked attachment at or around `el` was locked with, or null when it has none. */
export function lockedAttachmentName(el: Element): string | null {
  for (let n: Element | null = el; n; n = parentElementOf(n)) {
    const name = lockedNames.get(n);
    if (name !== undefined) return name;
  }
  return null;
}

/** Register a per-document callback fired when a user clicks a locked attachment. */
export function setAttachmentBlockedHandler(doc: Document, handler: (() => void) | null): void {
  if (handler) blockedHandlers.set(doc, handler);
  else blockedHandlers.delete(doc);
}

function blockAttachmentEvent(e: Event): void {
  const el = eventElement(e);
  const lockedRoot = el ? closestEl(el, `[${ATT_LOCK_ATTR}]`) : null;
  if (!el || !lockedRoot) return;

  if (e.type === 'keydown' || e.type === 'keyup') {
    const key = (e as KeyboardEvent).key;
    if (key !== 'Enter' && key !== ' ') return;
  }

  e.preventDefault();
  e.stopImmediatePropagation();

  const shouldToast =
    e.type === 'click' ||
    e.type === 'dblclick' ||
    e.type === 'contextmenu' ||
    (e.type === 'keydown' && !(e as KeyboardEvent).repeat) ||
    (e.type === 'auxclick' && (e as MouseEvent).button === 1);
  if (shouldToast) {
    const name = lockedAttachmentName(el) ?? '';
    const doc = ownerDocOf(lockedRoot);
    showPausedAttachmentToast(doc, name, el instanceof HTMLElement ? el : null);
    blockedHandlers.get(doc)?.();
  }
}

/** Touch: keep the page's handlers away from a locked attachment, but do not cancel (scrolls may start on it). */
function keepTouchAway(e: Event): void {
  const el = eventElement(e);
  if (el && closestEl(el, `[${ATT_LOCK_ATTR}]`)) e.stopImmediatePropagation();
}

// The webmail's own controls decide which event opens a file (a role=button card may act on keyup or pointerup, a
// custom right-click menu drawn outside the card offers "Download"), so every activation path is refused, as the
// Gmail inbox-list guard in content.ts does. The tap that follows a touch is a click, refused with the notice.
const BLOCKED_EVENTS = [
  'click', 'auxclick', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
  'dragstart', 'submit', 'keydown', 'keyup',
];

/** Idempotent, like the link lock's: document.open() erases listeners but keeps the Document object. */
function install(doc: Document): void {
  for (const type of BLOCKED_EVENTS) doc.addEventListener(type, blockAttachmentEvent, true);
  for (const type of ['touchstart', 'touchend']) {
    doc.addEventListener(type, keepTouchAway, { capture: true, passive: true });
  }
  if (styles.get(doc)?.isConnected) return;
  const parent = doc.head ?? doc.documentElement;
  if (!parent) return;
  const style = doc.createElement('style');
  style.id = ATT_STYLE_ID;
  style.textContent = [
    `[${ATT_LOCK_ATTR}]{cursor:not-allowed!important;opacity:.55!important;outline:2px dashed #b91c1c!important;outline-offset:-2px!important;border-radius:8px!important}`,
    `[${ATT_LOCK_ATTR}] :is(a,area,button,[role="button"]){cursor:not-allowed!important}`,
  ].join('');
  parent.appendChild(style);
  styles.set(doc, style);
}

// What this lock removed, recorded in the isolated world (see linkLock.ts): email HTML cannot pre-seed
// data-ped-att-* attributes to keep a live href/download, nor change what is restored on unlock.
const stashes = new WeakMap<Element, Map<string, string>>();
const stashedIn = new WeakMap<HTMLElement, Set<Element>>(); // locked root -> elements it stashed
const ARIA_HOLDER = 'attachments';
const XLINK_STASH_ATTR = 'data-ped-att-xlink-href';
// SVG SMIL can point a download link back at a data: URL with no href attribute (see linkLock.ts).
const ANIM_STASH_ATTR = 'data-ped-att-anim-attr';
const ANIMATED_LINK_ATTRS = new Set(['href', 'xlink:href']);
// Local names, matched in the callback: attributeFilter never reports namespaced attributes such as xlink:href.
const WATCHED_ATTRS = new Set(['href', 'xlink:href', 'download', 'download_url', 'formaction', 'attributename']);
const MIN_PRUNE = 256;
const pruneAt = new WeakMap<HTMLElement, number>();

function pruneDetached(root: HTMLElement, set: Set<Element>): void {
  if (set.size < (pruneAt.get(root) ?? MIN_PRUNE)) return;
  for (const el of set) if (el !== root && !root.contains(el)) set.delete(el);
  pruneAt.set(root, Math.max(MIN_PRUNE, set.size * 2));
}

function stashTarget(root: HTMLElement): void {
  const targets = [
    root,
    ...root.querySelectorAll<Element>(
      `a, area, button, [href], [download], [download_url], [formaction], [${ATT_HREF_ATTR}], [${ATT_DL_ATTR}], [${ATT_DLURL_ATTR}], [${ATT_FA_ATTR}], [${XLINK_STASH_ATTR}]`,
    ),
  ];
  let set = stashedIn.get(root);
  if (!set) stashedIn.set(root, (set = new Set()));
  pruneDetached(root, set);
  for (const anim of root.querySelectorAll<Element>('set, animate')) {
    const target = getAttr(anim, 'attributeName');
    if (target === null || !ANIMATED_LINK_ATTRS.has(target.trim().toLowerCase())) {
      if (stashes.has(anim)) set.add(anim);
      continue;
    }
    let st = stashes.get(anim);
    if (!st) stashes.set(anim, (st = new Map()));
    st.set('attributeName', target);
    setAttr(anim, ANIM_STASH_ATTR, target);
    rmAttr(anim, 'attributeName');
    set.add(anim);
  }
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
    if (name) lockedNames.set(el, name);
    else lockedNames.delete(el);
    stashTarget(el);
    if (!watchers.has(el) && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver((records) => {
        if (!hasAttr(el, ATT_LOCK_ATTR)) return;
        if (records.some((r) => r.type === 'childList' || WATCHED_ATTRS.has((r.attributeName ?? '').toLowerCase()))) {
          stashTarget(el);
        }
      });
      obs.observe(el, { childList: true, subtree: true, attributes: true });
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
    lockedNames.delete(root);
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
      rmAttr(el, ANIM_STASH_ATTR);
      releaseDisabled(el, ARIA_HOLDER);
    }
    stashedIn.delete(root);
    docs.add(ownerDocOf(root));
  }
  for (const doc of docs) removePausedLinkToast(doc);
}

export const isAttachmentLocked = (el: HTMLElement): boolean => hasAttr(el, ATT_LOCK_ATTR);
