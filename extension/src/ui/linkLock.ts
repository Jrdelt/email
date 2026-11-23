// Disables links, embedded image links, image maps, and forms inside a flagged email until unlocked.
// Stashes href/action attributes (neutralizing right-click "Open link in new tab" and form submits) and
// installs one capturing listener per document — no per-link listeners.
const LOCK_ATTR = 'data-ped-locked';
const HREF_ATTR = 'data-ped-href';
const ACTION_ATTR = 'data-ped-action';
const FORM_ATTR = 'data-ped-form-locked';
const STYLE_ID = 'ped-lock-style';
const installed = new WeakSet<Document>();

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
  if (
    el.closest(
      `a[href], a[${HREF_ATTR}], area[href], area[${HREF_ATTR}], form button:not([type="button"]), form input[type="submit"], form input[type="image"]`,
    )
  ) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

function install(doc: Document) {
  if (installed.has(doc)) return;
  installed.add(doc);
  for (const type of ['click', 'auxclick', 'dragstart', 'submit']) doc.addEventListener(type, block, true);
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = [
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href], area[${HREF_ATTR}], area[href]){cursor:not-allowed!important;text-decoration:line-through!important;opacity:.6!important}`,
    `[${LOCK_ATTR}] :is(a[${HREF_ATTR}], a[href]) img{cursor:not-allowed!important;opacity:.65!important;outline:2px dashed #b91c1c!important;outline-offset:-2px!important}`,
    `[${LOCK_ATTR}] form :is(button:not([type="button"]), input[type="submit"], input[type="image"]){cursor:not-allowed!important;opacity:.6!important}`,
  ].join('');
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function lockLinks(container: HTMLElement): void {
  install(container.ownerDocument);
  container.setAttribute(LOCK_ATTR, '');
  for (const el of container.querySelectorAll<HTMLElement>('a[href], area[href]')) {
    if (!el.hasAttribute(HREF_ATTR)) {
      el.setAttribute(HREF_ATTR, el.getAttribute('href')!);
      el.removeAttribute('href');
      el.setAttribute('aria-disabled', 'true');
    }
  }
  for (const form of container.querySelectorAll<HTMLFormElement>('form')) {
    if (form.hasAttribute('action') && !form.hasAttribute(ACTION_ATTR)) {
      form.setAttribute(ACTION_ATTR, form.getAttribute('action')!);
      form.removeAttribute('action');
    }
    form.setAttribute(FORM_ATTR, '');
  }
}

export function unlockLinks(container: HTMLElement): void {
  container.removeAttribute(LOCK_ATTR);
  for (const el of container.querySelectorAll<HTMLElement>(`[${HREF_ATTR}]`)) {
    el.setAttribute('href', el.getAttribute(HREF_ATTR)!);
    el.removeAttribute(HREF_ATTR);
    el.removeAttribute('aria-disabled');
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${ACTION_ATTR}]`)) {
    form.setAttribute('action', form.getAttribute(ACTION_ATTR)!);
    form.removeAttribute(ACTION_ATTR);
  }
  for (const form of container.querySelectorAll<HTMLFormElement>(`[${FORM_ATTR}]`)) {
    form.removeAttribute(FORM_ATTR);
  }
}

export const isLocked = (container: HTMLElement) => container.hasAttribute(LOCK_ATTR);
