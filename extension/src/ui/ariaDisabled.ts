import { getAttr, rmAttr, setAttr } from '../dom';

// Both the link lock and the attachment lock mark controls aria-disabled="true". Each lock "holds" the flag,
// and the page's own previous value is kept in this isolated-world map (email HTML cannot see or edit it), so
// releasing the last hold restores exactly what the webmail had instead of stripping its own aria-disabled.
const holds = new WeakMap<Element, { prev: string | null; holders: Set<string> }>();

export function holdDisabled(el: Element, holder: string): void {
  let h = holds.get(el);
  if (!h) {
    h = { prev: getAttr(el, 'aria-disabled'), holders: new Set() };
    holds.set(el, h);
  }
  h.holders.add(holder);
  setAttr(el, 'aria-disabled', 'true');
}

export function releaseDisabled(el: Element, holder: string): void {
  const h = holds.get(el);
  if (!h || !h.holders.delete(holder) || h.holders.size > 0) return;
  holds.delete(el);
  if (h.prev === null) rmAttr(el, 'aria-disabled');
  else setAttr(el, 'aria-disabled', h.prev);
}
