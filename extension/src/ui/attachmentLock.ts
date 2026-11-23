import { eventElement, getAttr, hasAttr, rmAttr, setAttr } from '../dom';
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
  const lockedRoot = el?.closest?.(`[${ATT_LOCK_ATTR}]`);
  if (!lockedRoot) return;

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
    const namedEl = el?.closest?.(`[${ATT_NAME_ATTR}]`);
    const name = (namedEl ? getAttr(namedEl, ATT_NAME_ATTR) : null) ?? getAttr(lockedRoot, ATT_NAME_ATTR) ?? '';
    showPausedAttachmentToast(lockedRoot.ownerDocument, name, el instanceof HTMLElement ? el : null);
    blockedHandlers.get(lockedRoot.ownerDocument)?.();
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

function stashTarget(root: HTMLElement): void {
  const targets = [
    root,
    ...root.querySelectorAll<Element>('a, area, button, [href], [download], [download_url], [formaction]'),
  ];
  for (const el of targets) {
    for (const [attr, stashAttr] of STASHED_PAIRS) {
      if (hasAttr(el, attr) && !hasAttr(el, stashAttr)) {
        setAttr(el, stashAttr, getAttr(el, attr)!);
        rmAttr(el, attr);
      }
    }
    setAttr(el, 'aria-disabled', 'true');
  }
}

/** Lock attachment cards/shelves/links so untrusted email attachments cannot be opened or downloaded. */
export function lockAttachments(elements: readonly HTMLElement[], names?: ReadonlyMap<HTMLElement, string>): void {
  for (const el of elements) {
    install(el.ownerDocument);
    setAttr(el, ATT_LOCK_ATTR, '');
    const name = names?.get(el);
    if (name) setAttr(el, ATT_NAME_ATTR, name);
    stashTarget(el);
    if (!watchers.has(el) && typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver((muts) => {
        if (!hasAttr(el, ATT_LOCK_ATTR)) return;
        if (muts.some((m) => m.addedNodes.length > 0)) stashTarget(el);
      });
      obs.observe(el, { childList: true, subtree: true });
      watchers.set(el, obs);
    }
  }
}

/** Restore stashed attributes and re-enable attachment elements once the email/sender is trusted. */
export function unlockAttachments(elements: readonly HTMLElement[]): void {
  const docs = new Set<Document>();
  for (const el of elements) {
    watchers.get(el)?.disconnect();
    watchers.delete(el);
    rmAttr(el, ATT_LOCK_ATTR);
    rmAttr(el, ATT_NAME_ATTR);
    rmAttr(el, 'aria-disabled');

    const targets = [
      el,
      ...el.querySelectorAll<Element>(
        `[${ATT_HREF_ATTR}], [${ATT_DL_ATTR}], [${ATT_DLURL_ATTR}], [${ATT_FA_ATTR}], [aria-disabled="true"]`,
      ),
    ];
    for (const node of targets) {
      for (const [attr, stashAttr] of STASHED_PAIRS) {
        if (hasAttr(node, stashAttr)) {
          setAttr(node, attr, getAttr(node, stashAttr)!);
          rmAttr(node, stashAttr);
        }
      }
      if (
        getAttr(node, 'aria-disabled') === 'true' &&
        !hasAttr(node, 'data-ped-href') &&
        !hasAttr(node, 'data-ped-xlink-href') &&
        !hasAttr(node, 'data-ped-formaction')
      ) {
        rmAttr(node, 'aria-disabled');
      }
    }
    docs.add(el.ownerDocument);
  }
  for (const doc of docs) removePausedLinkToast(doc);
}

export const isAttachmentLocked = (el: HTMLElement): boolean => hasAttr(el, ATT_LOCK_ATTR);
