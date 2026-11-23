// Disables links inside a flagged email until the user unlocks it.
// One capturing listener on the document (installed once) — no per-link listeners, no per-link DOM edits.
// Limitation: cannot block the browser's own right-click "Open link in new tab"; documented in the threat model.
const ATTR = 'data-ped-locked';
const STYLE_ID = 'ped-lock-style';
const installed = new WeakSet<Document>();

function block(e: Event) {
  const t = e.target as Element | null;
  const a = t?.closest?.('a[href]');
  if (a && a.closest(`[${ATTR}]`)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

function install(doc: Document) {
  if (installed.has(doc)) return;
  installed.add(doc);
  for (const type of ['click', 'auxclick', 'dragstart']) doc.addEventListener(type, block, true);
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `[${ATTR}] a[href]{cursor:not-allowed!important;text-decoration:line-through!important;opacity:.6!important}`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function lockLinks(container: HTMLElement): void {
  install(container.ownerDocument);
  container.setAttribute(ATTR, '');
}

export function unlockLinks(container: HTMLElement): void {
  container.removeAttribute(ATTR);
}

export const isLocked = (container: HTMLElement) => container.hasAttribute(ATTR);
