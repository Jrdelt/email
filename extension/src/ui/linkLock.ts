// Disables links (including SVG xlink:href, ping beacons, and keyboard activation),
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
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const SVG_NS = 'http://www.w3.org/2000/svg';
const installed = new WeakSet<Document>();
const watchers = new WeakMap<HTMLElement, MutationObserver>();

function matchesLockedTarget(el: Element): boolean {
  if (
    el.closest(
      `a[href], a[${HREF_ATTR}], a[${XLINK_ATTR}], area[href], area[${HREF_ATTR}], [formaction], [${FORMACTION_ATTR}], form button:not([type="button"]), form input[type="submit"], form input[type="image"]`,
    )
  ) {
    return true;
  }
  const a = el.closest('a');
  return Boolean(a && (a.getAttributeNS(XLINK_NS, 'href') !== null || a.hasAttribute('xlink:href')));
}

function block(e: Event) {
  const node = e.target as Node | null;
  const el = node && node.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  if (!el?.closest?.(`[${LOCK_ATTR}]`)) return;
  if (e.type === 'submit') {
    if (el.closest('form')) {
      e.preventDefault();
      e.stopImmediatePropagation();
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
    if (el.hasAttribute('href') && !el.hasAttribute(HREF_ATTR)) {
      el.setAttribute(HREF_ATTR, el.getAttribute('href')!);
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
    }
    const xhref = el.getAttributeNS(XLINK_NS, 'href') ?? el.getAttribute('xlink:href');
    if (xhref !== null && !el.hasAttribute(XLINK_ATTR)) {
      el.setAttribute(XLINK_ATTR, xhref);
      el.removeAttributeNS(XLINK_NS, 'href');
      el.removeAttribute('xlink:href');
      el.setAttribute('aria-disabled', 'true');
    }
    if (el.hasAttribute('ping') && !el.hasAttribute(PING_ATTR)) {
      el.setAttribute(PING_ATTR, el.getAttribute('ping')!);
      el.removeAttribute('ping');
    }
  }
  for (const form of container.querySelectorAll<HTMLFormElement>('form')) {
    if (form.hasAttribute('action') && !form.hasAttribute(ACTION_ATTR)) {
      form.setAttribute(ACTION_ATTR, form.getAttribute('action')!);
      form.removeAttribute('action');
    }
    if (!form.hasAttribute(FORM_ATTR)) form.setAttribute(FORM_ATTR, '');
  }
  for (const el of container.querySelectorAll<Element>('[formaction]')) {
    if (!el.hasAttribute(FORMACTION_ATTR)) {
      el.setAttribute(FORMACTION_ATTR, el.getAttribute('formaction')!);
      el.removeAttribute('formaction');
      el.setAttribute('aria-disabled', 'true');
    }
  }
}

export function lockLinks(container: HTMLElement): void {
  install(container.ownerDocument);
  container.setAttribute(LOCK_ATTR, '');
  stashInside(container);
  if (!watchers.has(container) && typeof MutationObserver !== 'undefined') {
    const obs = new MutationObserver((muts) => {
      if (!container.hasAttribute(LOCK_ATTR)) return;
      if (muts.some((m) => m.addedNodes.length > 0)) stashInside(container);
    });
    obs.observe(container, { childList: true, subtree: true });
    watchers.set(container, obs);
  }
}

export function unlockLinks(container: HTMLElement): void {
  watchers.get(container)?.disconnect();
  watchers.delete(container);
  container.removeAttribute(LOCK_ATTR);
  for (const el of container.querySelectorAll<Element>(`[${HREF_ATTR}]`)) {
    el.setAttribute('href', el.getAttribute(HREF_ATTR)!);
    el.removeAttribute(HREF_ATTR);
    el.removeAttribute('aria-disabled');
  }
  for (const el of container.querySelectorAll<Element>(`[${XLINK_ATTR}]`)) {
    const val = el.getAttribute(XLINK_ATTR)!;
    if (el.namespaceURI === SVG_NS) el.setAttributeNS(XLINK_NS, 'xlink:href', val);
    else el.setAttribute('xlink:href', val);
    el.removeAttribute(XLINK_ATTR);
    el.removeAttribute('aria-disabled');
  }
  for (const el of container.querySelectorAll<Element>(`[${PING_ATTR}]`)) {
    el.setAttribute('ping', el.getAttribute(PING_ATTR)!);
    el.removeAttribute(PING_ATTR);
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${ACTION_ATTR}]`)) {
    form.setAttribute('action', form.getAttribute(ACTION_ATTR)!);
    form.removeAttribute(ACTION_ATTR);
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${FORM_ATTR}]`)) {
    form.removeAttribute(FORM_ATTR);
  }
  for (const el of container.querySelectorAll<Element>(`[${FORMACTION_ATTR}]`)) {
    el.setAttribute('formaction', el.getAttribute(FORMACTION_ATTR)!);
    el.removeAttribute(FORMACTION_ATTR);
    el.removeAttribute('aria-disabled');
  }
}

export const isLocked = (container: HTMLElement) => container.hasAttribute(LOCK_ATTR);
