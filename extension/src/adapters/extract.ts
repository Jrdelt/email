import { cleanAttachmentName } from '../attachments';
import {
  animationTarget,
  closestEl,
  getAttr,
  hasAttr,
  isFormEl,
  nodeTypeOf,
  ownerDocOf,
  parentElementOf,
  rawLinkTarget,
  resolveAgainstBase,
  resolveAnchorHref,
  tagOf,
  textOf,
} from '../dom';
import { hostOf, registrableDomain } from '../domain';
import { EXPLICIT_URL, INVISIBLE_RE, safePercentDecode, shownHost, type Link } from '../features';
import { unwrapRedirectUrl } from '../linkGuard';
import type { AttachmentRef } from './types';

export const MAX_BODY_CHARS = 20_000; // cap work per email
// Distinct links scored per email (scoring 1,000 links takes ~4 ms); past this the email fails closed as unchecked.
export const MAX_LINKS = 1000;
export const MAX_LINK_TEXT_CHARS = 2048; // link text only needs to show a URL or domain
const MAX_LINK_SCAN = 2000; // bound on link nodes examined before de-duplication and sampling
/**
 * Safety bound on attachment elements collected per source (inline anchors, or one adapter's chips).
 * This bounds DOM work only: names analysed for the banner are capped separately (attachments.ts), and
 * when inline downloads exceed it the whole body is locked as an attachment instead of leaving extras live.
 */
export const MAX_ATTACHMENTS = 500;

/** True when the element or an ancestor is `[hidden]` or `[aria-hidden="true"]`. */
export const isHidden = (el: Element): boolean => closestEl(el, '[hidden], [aria-hidden="true"]') !== null;

/**
 * True for elements adapters must not use as a message, header or attachment node. `<form>` elements in
 * email HTML can override built-in properties (`<input name="contains">`), which would otherwise throw
 * mid-scan and leave the email unscanned and unlocked.
 */
export const isUnsafeNode = (el: Element): boolean => isFormEl(el);

/**
 * True when `el` sits inside another element matching any of `selectors`. Adapters use it so that an element
 * in the email HTML carrying a body marker (aria-label="Message body", data-testid=...) cannot replace the real
 * body as the scanned and locked container: only the outermost body candidate counts.
 */
export function isNestedIn(el: Element, selectors: readonly string[]): boolean {
  const parent = el.parentElement;
  return parent !== null && closestEl(parent, selectors.join(', ')) !== null;
}

/**
 * True when `el` sits in a region matching `sel` (attachment chips, the subject heading) strictly inside `scope`
 * that does not also hold `hostEl` (the body, or the iframe hosting it): a wrapper around the whole message is not
 * such a region. Sender lookups skip these, since their labels and text (file names, subject) are attacker-chosen,
 * never the sender.
 */
export function inExcludedRegion(el: Element, scope: Element, hostEl: Element, sel: string): boolean {
  for (let cur = closestEl(el, sel); cur && cur !== scope && scope.contains(cur); ) {
    if (!cur.contains(hostEl)) return true;
    const up = cur.parentElement;
    cur = up ? closestEl(up, sel) : null;
  }
  return false;
}

// Sender candidates examined per conversation-level scope; past it the pairing counts as uncertain (fail closed).
const MAX_SENDER_CANDIDATES = 200;

/**
 * For a sender lookup that fell back to a conversation-level scope (no per-message wrapper around the body): true
 * when that scope cannot pair a sender with `hostEl` for certain, because it also holds another message body, or
 * its sender candidates (elements matching `candidates`, minus `skip`) show more than one distinct address (an
 * expanded body next to another sender's collapsed header). Adapters mark such a sender pairingUncertain, so it is
 * never allowlist-trusted; a fallback scope with one message and one sender stays certain.
 */
export function conversationPairingUncertain(
  scope: Element,
  hostEl: Element,
  bodies: readonly BodyHit[],
  candidates: string,
  skip: (el: Element) => boolean,
): boolean {
  if (bodies.some((b) => b.hostEl !== hostEl && scope.contains(b.hostEl))) return true;
  const seen = new Set<string>();
  let examined = 0;
  for (const el of scope.querySelectorAll(candidates)) {
    if (skip(el)) continue;
    if (++examined > MAX_SENDER_CANDIDATES) return true;
    const hit = extractSenderFromElement(el);
    if (hit) seen.add(hit.senderAddress.toLowerCase());
    if (seen.size > 1) return true;
  }
  return false;
}

/**
 * Longest header/label text parsed for an address. Real headers are far shorter; the cap plus excluding '@'
 * from the repeated classes keeps address matching linear on attacker text (e.g. a display name of 2,000 '@').
 */
export const MAX_HEADER_CHARS = 1000;
export const ADDRESS_TOKEN_RE = /[^\s<>"'(),;@]+@[^\s<>"'(),;@]+\.[^\s<>"'(),;@]+/;

/**
 * True when a body element holds anything worth scanning: text, any kind of link (HTML/SVG/image map), a form,
 * media, or an inline/stashed download. Image-only, SVG-only and form-only phishing bodies count.
 */
export function hasMessageContent(el: Element): boolean {
  if (textOf(el).trim().length > 0) return true;
  return (
    el.querySelector(
      'a, area, form, input, button, img, svg, picture, video, object, embed, [formaction], [data-ped-href], [data-ped-xlink-href], [data-ped-att-href], [data-ped-formaction]',
    ) !== null
  );
}

export type BodyHit = { container: HTMLElement; hostEl: HTMLElement };

export type BodyPick = { bodies: BodyHit[]; hasContent: boolean };

/**
 * Message bodies for adapters: the first selector (in priority order) whose visible, non-excluded, outermost matches
 * include one with content, returning ALL of that selector's matches, empty ones too: in a conversation, a message
 * whose body is empty but which carries an attachment must still be scanned and attachment-locked. When no match
 * has content, the first selector with any match is used (`hasContent` false).
 */
export function pickBodies(doc: Document, selectors: readonly string[], excluded: (el: HTMLElement) => boolean): BodyPick {
  let fallback: BodyHit[] = [];
  for (const sel of selectors) {
    const valid: HTMLElement[] = [];
    let hasContent = false;
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      if (excluded(el) || isHidden(el)) continue;
      if (isNestedIn(el, selectors)) continue;
      if (valid.some((prev) => prev.contains(el))) continue;
      valid.push(el);
      hasContent ||= hasMessageContent(el);
    }
    const bodies = valid.map((el) => ({ container: el, hostEl: el }));
    if (hasContent) return { bodies, hasContent };
    if (fallback.length === 0) fallback = bodies;
  }
  return { bodies: fallback, hasContent: false };
}

/** Bodies of same-origin message iframes (cross-origin ones are skipped), empty ones included. */
export function pickFrameBodies(doc: Document, selector: string, excluded: (el: HTMLElement) => boolean): BodyPick {
  const bodies: BodyHit[] = [];
  let hasContent = false;
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(selector)) {
    if (isHidden(iframe) || excluded(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !excluded(body)) {
        bodies.push({ container: body, hostEl: iframe });
        hasContent ||= hasMessageContent(body);
      }
    } catch {
      /* cross-origin iframe */
    }
  }
  return { bodies, hasContent };
}

/**
 * Choose between an adapter's direct and iframe bodies: the first source with content wins (with its empty
 * siblings); otherwise the first source with any body, so attachment-only emails are still found.
 */
export function chooseBodies(...picks: BodyPick[]): BodyHit[] {
  return (picks.find((p) => p.hasContent) ?? picks.find((p) => p.bodies.length > 0))?.bodies ?? [];
}

/** Same-origin documents of the iframes matching `selector` (cross-origin ones are skipped). */
export function sameOriginFrameDocs(doc: Document, selector: string): Document[] {
  const out: Document[] = [];
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(selector)) {
    try {
      const d = iframe.contentDocument;
      if (d) out.push(d);
    } catch {
      /* cross-origin iframe */
    }
  }
  return out;
}


/** Keep the start and the end of an over-long list or text, so padding at the top cannot hide what follows. */
function headAndTail<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : [...items.slice(0, Math.ceil(max / 2)), ...items.slice(items.length - Math.floor(max / 2))];
}

/** Drop characters that render as nothing and collapse whitespace runs, the way a reader sees the text. */
const visibleText = (text: string): string => text.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ');

/**
 * Bound attacker-controlled text (header labels, link text) without letting filler hide what matters: over `max`,
 * drop what renders as nothing, then keep the first and last halves (exactly `max` characters).
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const visible = visibleText(text);
  if (visible.length <= max) return visible;
  const half = Math.floor(max / 2);
  return `${visible.slice(0, half)} ${visible.slice(visible.length - (max - half - 1))}`;
}

/**
 * Link text bounded to MAX_LINK_TEXT_CHARS that still shows the URL the reader sees: filler on both sides of the
 * displayed URL must not push it out, so past the cap the window starts at the first explicit URL (NFKC, as
 * shownHost reads it). Text before that URL cannot contain an earlier URL, so shownHost finds the same one.
 */
export function capLinkText(text: string): string {
  const max = MAX_LINK_TEXT_CHARS;
  if (text.length <= max) return text;
  const visible = visibleText(text.normalize('NFKC'));
  if (visible.length <= max) return visible;
  const at = EXPLICIT_URL.exec(visible)?.index ?? -1;
  if (at < max / 2) return capText(visible, max);
  const head = Math.floor(max / 4);
  return `${visible.slice(0, head)} ${visible.slice(at, at + (max - head - 1))}`;
}

const SHOW_ALL = 0xffffffff;
const isTextNode = (n: Node): boolean => n.nodeType === 3 /* TEXT */ || n.nodeType === 4 /* CDATA_SECTION */;

/**
 * At most `max` characters of `el`'s text: the first half from its start and the rest from its end (joined by a
 * space when they do not meet), visiting at most `steps` nodes in each direction. Bounded however large or deeply
 * nested the subtree is; equals textContent when that is short and shallow.
 */
function textEnds(el: Element, max: number, steps: number): string {
  const doc = ownerDocOf(el);
  const headMax = Math.ceil(max / 2);
  const fw = doc.createTreeWalker(el, SHOW_ALL);
  let head = '';
  let last: Node | null = null; // last text node read forwards, and how many of its characters were taken
  let used = 0;
  let n = fw.nextNode();
  for (let i = 0; n && i < steps && head.length < headMax; n = fw.nextNode(), i++) {
    if (!isTextNode(n)) continue;
    const t = n.nodeValue ?? '';
    const take = t.slice(0, headMax - head.length);
    head += take;
    last = n;
    used = take.length;
  }
  if (!n && (!last || used === (last.nodeValue ?? '').length)) return head;
  // Backwards from the deepest last node until the tail is full or the head is reached.
  const tailMax = max - head.length - 1;
  const bw = doc.createTreeWalker(el, SHOW_ALL);
  let i = 0;
  while (i < steps && bw.lastChild()) i++;
  const tail: string[] = [];
  let tailLen = 0;
  let met = false;
  for (let m: Node | null = bw.currentNode; m && m !== el && i < steps && tailLen < tailMax; m = bw.previousNode(), i++) {
    if (!isTextNode(m)) continue;
    const t = m.nodeValue ?? '';
    const from = m === last ? used : 0;
    const start = Math.max(from, t.length - (tailMax - tailLen));
    tail.push(t.slice(start));
    tailLen += t.length - start;
    if (m === last) {
      met = start === from;
      break;
    }
  }
  const end = tail.reverse().join('');
  return met || !head || !end ? head + end : `${head} ${end}`;
}

// Work bound on link text per scan, in raw characters plus nodes visited (~10 ms). Real emails stay far below it.
// Past it, every further link's text is sampled from both ends only and the scan reports truncation (fail closed),
// so link elements sharing one large subtree (SVG <a> or formaction elements nested hundreds deep, thousands of
// SMIL <set> in one <a>) cannot multiply the work.
const LINK_TEXT_BUDGET = 25 * MAX_BODY_CHARS;
const LINK_TEXT_STEPS = 256; // nodes visited per direction for a sampled link text
// Computed styles read per scan to work out rendered link text (~10 ms in Chromium at worst); past it the scan
// reports truncation (fail closed), so padding links full of styled markup cannot hide a later one's hidden splitter.
const LINK_STYLE_CHECKS = 2000;

/**
 * A link's text as read for scoring: `text` from the DOM as before, and `rendered`, the text the reader sees, when
 * that differs (CSS-hidden parts dropped, RTL bidi overrides reversed). Both capped like link text.
 */
type LinkText = { text: string; rendered?: string };

// Link text that can show a host or URL needs a dot or a colon, or a non-ASCII stand-in (look-alike dots, full-width
// colons, bidi controls). Without any of them it shows no host however it is rendered, so it is read as before.
const HOSTISH_RE = /[.:]|[^\x00-\x7f]/;
const RLO_RE = /\u202e/;
const RLO_RUN_RE = /\u202e([^\u202c]*)(?:\u202c|$)/g; // right-to-left override up to its pop (or the end)
const OVERRIDE_RE = /(?:bidi|isolate)-override/i;
const NOT_RENDERED_TAGS = new Set(['style', 'script', 'noscript', 'template']);

const reverseText = (t: string): string => [...t].reverse().join('');

/** The element that sets the bidi override for text in `el` (`el` or its nearest such ancestor up to `root`). */
type BidiOverride = { owner: Element; rtl: boolean } | null;

/**
 * True when a style sheet that can apply to `root` mentions `re`: the `<style>` elements inside it, or in its whole
 * document when `root` is a frame's body (an email rendered in its own document). Read through the prototypes, as
 * email HTML can clobber a frame document's properties.
 */
function cssMentions(root: Element, re: RegExp): boolean {
  const doc = ownerDocOf(root);
  const sheets =
    tagOf(root) === 'body'
      ? Document.prototype.querySelectorAll.call(doc, 'style')
      : Element.prototype.querySelectorAll.call(root, 'style');
  for (const s of sheets) if (re.test(textOf(s))) return true;
  return false;
}

/**
 * Nearest bidi override at or above an element, up to and including `root`: `<bdo>`, or `unicode-bidi:
 * bidi-override | isolate-override` from the computed style (`style`), or from the inline style when `style` is null.
 * Memoised per element.
 */
function bidiOverrides(root: Element, style: StyleOf | null): (el: Element) => BidiOverride {
  const memo = new Map<Element, BidiOverride>();
  const own = (el: Element): BidiOverride => {
    const dir = (getAttr(el, 'dir') ?? '').trim().toLowerCase();
    const cs = style?.(el) ?? null;
    const inline = cs ? '' : (getAttr(el, 'style') ?? '');
    const rtl = (): boolean => dir === 'rtl' || cs?.direction === 'rtl' || /direction\s*:\s*rtl/i.test(inline);
    if (tagOf(el) === 'bdo') return { owner: el, rtl: dir === 'rtl' || (dir !== 'ltr' && rtl()) };
    const bidi = cs ? cs.unicodeBidi || cs.getPropertyValue('unicode-bidi') : inline;
    return OVERRIDE_RE.test(bidi) ? { owner: el, rtl: rtl() } : null;
  };
  return (start) => {
    const chain: Element[] = [];
    let found: BidiOverride = null;
    for (let a: Element | null = start; a; a = a === root ? null : parentElementOf(a)) {
      const known = memo.get(a);
      if (known !== undefined) {
        found = known;
        break;
      }
      chain.push(a);
      found = own(a);
      if (found) break;
    }
    for (const a of chain) memo.set(a, found);
    return found;
  };
}

/**
 * Per-scan link text reader for the links inside `root`: each element's text is read once, in full while the budget
 * lasts. For link text that could show a host, the rendered text is worked out too when the link holds markup or
 * sits in a bidi override: text that CSS hides from the reader (computed style, as bodyText reads it) is dropped and
 * runs under a right-to-left override are reversed, so "https://<span hidden>x </span>www.paypal.com" or a reversed
 * "moc.lapyap.www" in <bdo dir=rtl> shows www.paypal.com as the reader sees it. It shares the work budget.
 */
function linkTextReader(root: Element): { read(el: Element): LinkText; exceeded(): boolean } {
  const memo = new Map<Element, LinkText>();
  let left = LINK_TEXT_BUDGET;
  let over = false;
  const full = (el: Element): string | null => {
    const w = ownerDocOf(el).createTreeWalker(el, SHOW_ALL);
    const parts: string[] = [];
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      left -= 1;
      if (isTextNode(n)) {
        const t = n.nodeValue ?? '';
        parts.push(t);
        left -= t.length;
      }
      if (left < 0) return null;
    }
    return parts.join('');
  };
  // Created on first use: most links never need them. Every link's ancestors are checked for a bidi override only
  // when the body can have one (a <bdo>, an inline unicode-bidi, or CSS that mentions an override), and from the
  // computed style only in that last case.
  let styles: { style: StyleOf | null; bidi: (el: Element) => BidiOverride } | null = null;
  const styling = () => {
    if (!styles) {
      const style = styleReader(ownerDocOf(root), LINK_STYLE_CHECKS, () => {
        over = true;
      });
      const css = cssMentions(root, OVERRIDE_RE);
      const markup = css || Element.prototype.querySelector.call(root, 'bdo, [style*="bidi" i]') !== null;
      styles = { style, bidi: markup ? bidiOverrides(root, css ? style : null) : () => null };
    }
    return styles;
  };
  const rendered = (el: Element): string | null => {
    const { style, bidi } = styling();
    // Only what hides part of the link counts (elements inside it): a link hidden as a whole is not read at all.
    const hidden = cssHiddenText(el, style);
    const w = ownerDocOf(el).createTreeWalker(el, 0x4 /* SHOW_TEXT */);
    let out = '';
    let run = '';
    let runOwner: BidiOverride = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      left -= 1;
      if (left < 0) return null;
      const parent = n.parentNode;
      const pe = parent !== null && nodeTypeOf(parent) === 1 ? (parent as Element) : null;
      if (!pe || NOT_RENDERED_TAGS.has(tagOf(pe)) || hidden?.(pe)) continue;
      const t = n.nodeValue ?? '';
      left -= t.length;
      if (left < 0) return null;
      const ov = bidi(pe);
      if ((ov?.owner ?? null) !== (runOwner?.owner ?? null)) {
        out += runOwner?.rtl ? reverseText(run) : run;
        run = '';
        runOwner = ov;
      }
      run += t;
    }
    out += runOwner?.rtl ? reverseText(run) : run;
    return out.replace(RLO_RUN_RE, (_, inner: string) => reverseText(inner));
  };
  const needsRendered = (el: Element, raw: string): boolean =>
    HOSTISH_RE.test(raw) &&
    (RLO_RE.test(raw) || Element.prototype.querySelector.call(el, '*') !== null || styling().bidi(el) !== null);
  return {
    read(el) {
      let v = memo.get(el);
      if (v !== undefined) return v;
      let raw = left >= 0 ? full(el) : null;
      if (raw === null) {
        over = true;
        raw = textEnds(el, MAX_LINK_TEXT_CHARS, LINK_TEXT_STEPS);
      }
      v = { text: capLinkText(raw) };
      if (!over && needsRendered(el, raw)) {
        const shown = rendered(el);
        if (shown === null) over = true;
        else if (shown !== raw) v.rendered = capLinkText(shown);
      }
      memo.set(el, v);
      return v;
    },
    exceeded: () => over,
  };
}

/** True when `text` shows a host whose registrable domain is not the destination's (scoreEmail's mismatch rule). */
function showsOtherHost(text: string, href: string): boolean {
  const shown = shownHost(text);
  const h = hostOf(href);
  return Boolean(shown && h && registrableDomain(shown) !== registrableDomain(h));
}

/**
 * The text scored for a link to `href`: the rendered text when it shows another host than the destination, else the
 * DOM text. Either reading counts (fail closed), so hiding a URL in the markup cannot clear a mismatch the reader
 * sees, and a misjudged style cannot clear one the DOM text shows.
 */
const scoredText = (t: LinkText, href: string): string =>
  t.rendered !== undefined && showsOtherHost(t.rendered, href) ? t.rendered : t.text;

/** Prepend the subject (bounded) without cutting the end of the already-sampled body. */
export const withSubject = (subject: string, body: string): string =>
  subject ? (body ? `${subject.slice(0, 300)}\n${body}` : subject.slice(0, 300)) : body;

const NON_TEXT_SEL = 'style, script, noscript, template';
const TEXT_CHUNK = 4096; // raw characters normalised at a time (per-node regexes are slow on many tiny nodes)
const RAW_SCAN_LIMIT = 50 * MAX_BODY_CHARS; // safety bound on raw characters read in each direction
// Elements whose computed style is read per body (~15 ms in Chromium at worst); past it, text counts as shown.
const STYLE_CHECKS = MAX_BODY_CHARS;
// How much a text node skipped by a filter counts toward RAW_SCAN_LIMIT: skipping costs per node, not per character,
// so one huge hidden node is cheap to pass, while very many tiny ones still end the read.
const SKIPPED_NODE_COST = 16;

/** Which text a sample keeps, by its parent element: true keeps it, false skips it (a skip still counts as read). */
type TextFilter = (parent: Element) => boolean;

/**
 * The streaming head+tail sample behind bodyText: skips CSS/script text and, with `keep`, text whose parent it
 * rejects. `cut` is set when text was left out (the middle was not read, or the sample was trimmed to `max`);
 * `skipped` when `keep` rejected any text that was read.
 */
function sampleText(el: HTMLElement, max: number, keep: TextFilter | null): { text: string; cut: boolean; skipped: boolean } {
  const doc = ownerDocOf(el);
  const half = Math.floor(max / 2);
  // Text inside style/script/noscript/template is not message text (checked per parent, only if there are any).
  const hasNonText = Element.prototype.querySelector.call(el, NON_TEXT_SEL) !== null;
  let lastParent: Node | null = null;
  let lastSkip = false;
  let lastReject = false;
  let skipped = false;
  // The text to sample, or null for text `keep` rejects (not sampled; counts SKIPPED_NODE_COST toward RAW_SCAN_LIMIT).
  const raw = (n: Node): string | null => {
    if (hasNonText || keep) {
      const parent = n.parentNode;
      if (parent !== lastParent) {
        lastParent = parent;
        const pe = parent !== null && nodeTypeOf(parent) === 1 ? (parent as Element) : null;
        lastSkip = hasNonText && pe !== null && closestEl(pe, NON_TEXT_SEL) !== null;
        lastReject = !lastSkip && keep !== null && pe !== null && !keep(pe);
      }
      if (lastSkip) return '';
      if (lastReject) {
        skipped = true;
        return null;
      }
    }
    return n.nodeValue ?? '';
  };

  // Forwards from the start until `max` visible characters are collected. Long text nodes are read in
  // TEXT_CHUNK slices, so one huge filler node costs a few slices, not a pass over all of it.
  const head: string[] = [];
  let headLen = 0;
  let headRaw = 0;
  let chunk: string[] = [];
  let chunkLen = 0;
  const flushHead = () => {
    const v = visibleText(chunk.join(''));
    head.push(v);
    headLen += v.length;
    chunk = [];
    chunkLen = 0;
  };
  const forward = doc.createTreeWalker(el, 0x4 /* SHOW_TEXT */);
  let lastHead: Node | null = null;
  let lastHeadUsed = 0; // raw characters of lastHead already read
  let stopped = false;
  read: for (let n = forward.nextNode(); n; n = forward.nextNode()) {
    const t = raw(n);
    lastHead = n;
    lastHeadUsed = 0;
    if (t === null) {
      headRaw += SKIPPED_NODE_COST;
      if (headRaw >= RAW_SCAN_LIMIT) {
        stopped = true;
        break;
      }
      continue;
    }
    for (let i = 0; i < t.length; i += TEXT_CHUNK) {
      const part = t.slice(i, i + TEXT_CHUNK);
      chunk.push(part);
      chunkLen += part.length;
      headRaw += part.length;
      lastHeadUsed = i + part.length;
      if (chunkLen >= TEXT_CHUNK) {
        flushHead();
        if (headLen >= max || headRaw >= RAW_SCAN_LIMIT) {
          stopped = true;
          break read;
        }
      }
    }
  }
  flushHead();
  let text = head.join('');
  let cut = false;

  if (stopped && lastHead) {
    // More text may follow: read the end backwards until half a body is collected or the head is reached.
    const tail: string[] = [];
    let tailLen = 0;
    let tailRaw = 0;
    let joined = false;
    let back: string[] = [];
    let backLen = 0;
    const flushTail = () => {
      const v = visibleText(back.reverse().join(''));
      tail.push(v);
      tailLen += v.length;
      back = [];
      backLen = 0;
    };
    const backward = doc.createTreeWalker(el, 0x4);
    tailRead: for (let m = backward.lastChild(); m; m = backward.previousNode()) {
      const t = raw(m);
      if (t === null) {
        tailRaw += SKIPPED_NODE_COST;
      } else {
        const stopAt = m === lastHead ? lastHeadUsed : 0;
        for (let end = t.length; end > stopAt; end -= TEXT_CHUNK) {
          const part = t.slice(Math.max(stopAt, end - TEXT_CHUNK), end);
          back.push(part);
          backLen += part.length;
          tailRaw += part.length;
          if (backLen >= TEXT_CHUNK) {
            flushTail();
            if (tailLen >= half || tailRaw >= RAW_SCAN_LIMIT) break tailRead;
          }
        }
      }
      if (m === lastHead) {
        joined = true;
        break;
      }
      if (t === null && tailRaw >= RAW_SCAN_LIMIT) break;
    }
    flushTail();
    text = `${text}${joined ? '' : '\n'}${tail.reverse().join('')}`;
    cut = !joined;
  }
  text = text.replace(/ {2,}/g, ' ');
  if (text.length <= max) return { text, cut, skipped };
  return { text: `${text.slice(0, half)}\n${text.slice(text.length - half)}`, cut: true, skipped };
}

const isZero = (v: string): boolean => parseFloat(v) === 0;

/** An element's computed style, or null (past the budget, or not an element of the document's window). */
type StyleOf = (el: Element) => CSSStyleDeclaration | null;

/**
 * Computed styles for one document, each element's read once and at most `budget` of them (past it, null, and
 * `refused` is called); null when the document has no window to compute styles with.
 */
function styleReader(doc: Document, budget = STYLE_CHECKS, refused?: () => void): StyleOf | null {
  const win = doc.defaultView;
  if (!win || typeof win.getComputedStyle !== 'function') return null;
  let checks = budget;
  const styles = new Map<Element, CSSStyleDeclaration | null>();
  return (el) => {
    let cs = styles.get(el);
    if (cs !== undefined) return cs;
    cs = null;
    if (checks > 0) {
      checks--;
      try {
        cs = win.getComputedStyle(el);
      } catch {
        /* not an element of this window */
      }
    } else {
      refused?.();
    }
    styles.set(el, cs);
    return cs;
  };
}

/**
 * The element's own box keeps its content from being seen: not rendered (also the `hidden` attribute, whose UA
 * display:none a stylesheet may lack), transparent, or clipped to nothing.
 */
function hidesBox(el: Element, cs: CSSStyleDeclaration): boolean {
  if (cs.display === 'none' || cs.getPropertyValue('content-visibility') === 'hidden' || isZero(cs.opacity)) return true;
  if (hasAttr(el, 'hidden')) return true;
  const overflow = `${cs.getPropertyValue('overflow')} ${cs.overflowX} ${cs.overflowY}`;
  return (
    /hidden|clip/.test(overflow) && (isZero(cs.height) || isZero(cs.maxHeight) || isZero(cs.width) || isZero(cs.maxWidth))
  );
}

/**
 * Text CSS keeps from the reader, by its parent (computed style, so stylesheets count): the parent's inherited
 * visibility is hidden/collapse or its font size is under 1px, or the parent or an ancestor below `root` is not
 * rendered (display:none, content-visibility:hidden), has opacity 0, or clips its content to nothing (zero
 * height/width with hidden overflow). Each element's style is read once, for at most STYLE_CHECKS elements; past
 * that, text counts as shown. Null when the body's document has no window to compute styles with.
 */
function cssHiddenText(root: Element, style: StyleOf | null = styleReader(ownerDocOf(root))): TextFilter | null {
  if (!style) return null;
  const boxes = new Map<Element, boolean>(); // the element or an ancestor below root hides its box
  const boxHidden = (el: Element): boolean => {
    const chain: Element[] = [];
    let hidden = false;
    for (let a: Element | null = el; a && a !== root; a = parentElementOf(a)) {
      const known = boxes.get(a);
      if (known !== undefined) {
        hidden = known;
        break;
      }
      chain.push(a);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      if (!hidden) {
        const cs = style(chain[i]);
        hidden = cs !== null && hidesBox(chain[i], cs);
      }
      boxes.set(chain[i], hidden);
    }
    return hidden;
  };
  const texts = new Map<Element, boolean>();
  return (parent) => {
    let hidden = texts.get(parent);
    if (hidden !== undefined) return hidden;
    hidden = boxHidden(parent);
    if (!hidden) {
      const cs = style(parent);
      hidden = cs !== null && (cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.fontSize) < 1);
    }
    texts.set(parent, hidden);
    return hidden;
  };
}

/**
 * Message text for scoring, as a reader sees it: skips CSS/script text, drops characters that render as nothing
 * and collapses whitespace runs (so invisible or blank filler does not use up the sample), and when longer than
 * MAX_BODY_CHARS keeps the first and last halves. Work stays bounded however long the body is: the start is read
 * forwards and the end backwards, and the middle is never visited.
 * When the text does not fit, text that CSS hides from the reader (display:none, font-size:0, zero-height
 * clipping...) is sampled only after the shown text and only into the room it leaves, so hidden filler on both
 * sides cannot push the shown message out of the sample. A body that fits is returned whole, as before.
 */
export function bodyText(el: HTMLElement): string {
  const all = sampleText(el, MAX_BODY_CHARS, null);
  if (!all.cut) return all.text;
  const hidden = cssHiddenText(el);
  if (!hidden) return all.text;
  const shown = sampleText(el, MAX_BODY_CHARS, (p) => !hidden(p));
  if (!shown.skipped) return all.text;
  const room = MAX_BODY_CHARS - shown.text.length - 1;
  const rest = room > 1 ? sampleText(el, room, hidden).text : '';
  return shown.text && rest ? `${shown.text}\n${rest}` : shown.text || rest;
}

/** Parse a header string like `PayPal <a@b.com>`, `PayPal (a@b.com)`, or bare `a@b.com`. */
export function parseSenderHeader(
  raw: string,
  fallbackName = '',
): { senderName: string; senderAddress: string } | null {
  // The address comes last ("Name <addr>"): a long display name must not push it past the cap.
  const cleaned = capText(raw, MAX_HEADER_CHARS)
    .trim()
    .replace(/^(?:from|sender)\s*:\s*/i, '')
    .replace(/^opens card for\s+/i, '')
    .trim();
  if (!cleaned) return null;
  const fb = fallbackName.trim();
  const fallback = fb && !fb.includes('@') ? fb : '';

  const angle = cleaned.match(/^(.*?)<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (angle) {
    return { senderName: angle[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: angle[2].trim() };
  }
  const paren = cleaned.match(/^(.*?)\(([^()@\s]+@[^()@\s]+)\)\s*$/);
  if (paren) {
    return { senderName: paren[1].trim().replace(/^["']|["']$/g, '') || fallback, senderAddress: paren[2].trim() };
  }
  // Bare "Name addr" text: the attacker-controlled display name comes first, so use the LAST address token.
  const tokens = [...cleaned.matchAll(new RegExp(ADDRESS_TOKEN_RE.source, 'g'))];
  const bare = tokens[tokens.length - 1];
  if (bare && bare.index !== undefined) {
    const before = cleaned.slice(0, bare.index).replace(/^[\s,:;\-"']+|[\s,:;\-"'<]+$/g, '').trim();
    return { senderName: before || fallback, senderAddress: bare[0].trim() };
  }
  return null;
}

/**
 * Extract sender name and email address from a webmail header DOM node (`mailto:`, `data-email`, `aria-label`,
 * `title`, or text). Pass `{ text: false }` for nodes whose text is only the sender's display name: the sender
 * controls that text, so an address written there must not be taken as the real address.
 */
export function extractSenderFromElement(
  el: Element,
  fallbackName = '',
  opts: { text?: boolean } = {},
): { senderName: string; senderAddress: string } | null {
  if (isUnsafeNode(el)) return null;
  const text = textOf(el).trim();
  const fb = (text.length <= 120 && !text.includes('@') ? text : '') || fallbackName;
  if (tagOf(el) === 'a') {
    const href = getAttr(el, 'href') ?? '';
    if (href.toLowerCase().startsWith('mailto:')) {
      const addr = href.slice(7).split('?')[0].trim();
      if (addr) return { senderName: fb, senderAddress: addr };
    }
  }
  const dataEmail = (getAttr(el, 'data-email') ?? '').trim();
  if (dataEmail) {
    const parsed = parseSenderHeader(dataEmail, fb);
    if (parsed) return parsed;
  }
  return (
    parseSenderHeader(getAttr(el, 'aria-label') ?? '', fb) ??
    parseSenderHeader(getAttr(el, 'title') ?? '', fb) ??
    (opts.text === false ? null : parseSenderHeader(text, fb))
  );
}

const ANIMATED_HREF = new Set(['href', 'xlink:href']);

/** True for a SMIL <set>/<animate> that retargets a link, including one whose attributeName a lock stashed. */
function animatesHref(anim: Element): boolean {
  const target =
    getAttr(anim, 'attributeName') ?? getAttr(anim, 'data-ped-anim-attr') ?? getAttr(anim, 'data-ped-att-anim-attr') ?? '';
  return ANIMATED_HREF.has(target.trim().toLowerCase());
}

/** Every value a SMIL animation can set (de-duplicated): to, from (held while an event-started animation waits), by, values. */
const animValues = (anim: Element): Set<string> =>
  new Set([
    getAttr(anim, 'to') ?? '',
    getAttr(anim, 'from') ?? '',
    getAttr(anim, 'by') ?? '',
    ...(getAttr(anim, 'values') ?? '').split(';'),
  ]);

/**
 * Links, form actions and SMIL link targets inside `el` (de-duplicated). `truncated` is set when there are more
 * distinct links than MAX_LINKS: the extras cannot be checked, so callers treat the email as suspicious (fail closed)
 * instead of letting padding links hide the real one.
 */
export function scanLinks(el: HTMLElement): { links: Link[]; truncated: boolean } {
  const base = ownerDocOf(el).baseURI || 'https://invalid.local';
  const out: Link[] = [];
  // Newsletters repeat the same href many times; unwrapping parses a URL, so do it once per distinct href.
  const unwrapped = new Map<string, string>();
  const unwrapCached = (href: string): string => {
    let v = unwrapped.get(href);
    if (v === undefined) unwrapped.set(href, (v = unwrapRedirectUrl(href)));
    return v;
  };
  const sel = 'a, area, form, [formaction], [data-ped-formaction], [data-ped-att-formaction], set, animate';
  const nodes = [...el.querySelectorAll(sel)];
  const linkText = linkTextReader(el);
  // Past the examination bound, look at the first and last nodes and report truncation (fail closed): thousands
  // of identical filler links must not keep the real one from being examined.
  let truncated = nodes.length > MAX_LINK_SCAN;
  for (const node of headAndTail(nodes, MAX_LINK_SCAN)) {
    if (out.length >= MAX_LINK_SCAN) {
      truncated = true;
      break;
    }
    const tag = tagOf(node);
    if (tag === 'set' || tag === 'animate') {
      // SVG SMIL retargeting an <a>: score every distinct value it can navigate to.
      if (!animatesHref(node)) continue;
      // The animated link: the element the animation aims at with its own href, or the <a> around it.
      const { target } = animationTarget(node);
      const anchor = target ? closestEl(target, 'a') : null;
      const text: LinkText = anchor ? linkText.read(anchor) : { text: '' };
      for (const raw of animValues(node)) {
        const href = resolveAgainstBase(raw, base);
        if (!href) continue;
        if (out.length >= MAX_LINK_SCAN) {
          truncated = true;
          break;
        }
        out.push({ text: scoredText(text, href), href });
      }
    } else if (tag === 'a' || tag === 'area') {
      const href = resolveAnchorHref(node, true);
      // Score the real destination behind redirect/link-rewriting wrappers (Safe Links, Proofpoint, google.com/url…).
      if (href) {
        const dest = unwrapCached(href);
        out.push({ text: scoredText(linkText.read(node), dest), href: dest });
      }
    } else if (tag === 'form') {
      const raw = getAttr(node, 'action') ?? getAttr(node, 'data-ped-action') ?? getAttr(node, 'data-ped-att-action') ?? '';
      const href = resolveAgainstBase(raw, base);
      if (href) out.push({ text: '', href });
    } else if (hasAttr(node, 'formaction') || hasAttr(node, 'data-ped-formaction') || hasAttr(node, 'data-ped-att-formaction')) {
      const raw =
        getAttr(node, 'formaction') ??
        getAttr(node, 'data-ped-formaction') ??
        getAttr(node, 'data-ped-att-formaction') ??
        '';
      const href = resolveAgainstBase(raw, base);
      if (href) {
        const text = (scoredText(linkText.read(node), href) || capLinkText(getAttr(node, 'value') || '')).trim();
        out.push({ text, href });
      }
    }
  }
  // Identical links add nothing; past the cap keep the first and last ones for scoring and report the truncation.
  const seen = new Set<string>();
  const unique = out.filter((l) => {
    const key = `${l.href}\t${l.text.trim().replace(/\s+/g, ' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { links: sampleLinks(unique), truncated: truncated || linkText.exceeded() || unique.length > MAX_LINKS };
}

// Cheap string checks (no URL parsing) for links that could carry a finding: shown text with a host or URL in it
// (a mismatch candidate), or a numeric, bracketed, IDN, user-info or percent-encoded host.
const NOTABLE_TEXT_RE = /:\/\/|\.[a-z]|[^\x00-\x7f]/i;
const NOTABLE_HOST_RE = /xn--|[^\x00-\x7f]|^\[|@|%|^[\d.]+(?::\d+)?$|^0x/i;
const HREF_HOST_RE = /^[a-z][a-z0-9+.-]*:\/*([^/?#\\]*)/i;
const isNotableLink = (l: Link): boolean =>
  NOTABLE_TEXT_RE.test(l.text) || NOTABLE_HOST_RE.test(HREF_HOST_RE.exec(l.href)?.[1] ?? '');

/**
 * The links that get scored when there are more than MAX_LINKS: risk-first, so that hundreds of plain filler
 * links cannot push the one real finding out of the sample (and turn an alert into a neutral 'not fully checked').
 */
function sampleLinks(unique: Link[]): Link[] {
  if (unique.length <= MAX_LINKS) return unique;
  const notable = unique.filter(isNotableLink);
  if (notable.length >= MAX_LINKS) return headAndTail(notable, MAX_LINKS);
  const plain = unique.filter((l) => !isNotableLink(l));
  return [...notable, ...headAndTail(plain, MAX_LINKS - notable.length)];
}

export const linksIn = (el: HTMLElement): Link[] => scanLinks(el).links;

/** `links` plus `linksTruncated` for ExtractedEmail objects. */
export function linkFields(el: HTMLElement): { links: Link[]; linksTruncated?: true } {
  const { links, truncated } = scanLinks(el);
  return truncated ? { links, linksTruncated: true } : { links };
}

function filenameFromHref(rawHref: string, base: string): string {
  const lower = rawHref.trim().toLowerCase();
  if (!lower || lower.startsWith('data:') || lower.startsWith('blob:')) return '';
  try {
    const seg = new URL(rawHref, base).pathname.split('/').pop() ?? '';
    return seg ? safePercentDecode(seg) : '';
  } catch {
    return '';
  }
}

// A URL whose scheme parses as data: or blob:. The URL parser strips leading C0 controls and spaces and removes
// tabs/newlines anywhere, so ' da\nta:' is data: too. Anchored and linear: it stops at the first other character.
const DOWNLOAD_SCHEME_RE =
  /^[\x00-\x20]*(?:d[\t\n\r]*a[\t\n\r]*t[\t\n\r]*a|b[\t\n\r]*l[\t\n\r]*o[\t\n\r]*b)[\t\n\r]*:/i;

/**
 * Cheap pre-check: could this link's navigation target be a data:/blob: URL? Mirrors resolveAnchorHref's order
 * (animated value, href, xlink:href, then the lock stashes when nothing live remains) and may over-match, never miss.
 */
function mayBeDownloadScheme(el: Element): boolean {
  const live = rawLinkTarget(el);
  if (live) return DOWNLOAD_SCHEME_RE.test(live);
  for (const attr of ['data-ped-href', 'data-ped-att-href', 'data-ped-xlink-href', 'data-ped-att-xlink-href']) {
    const v = getAttr(el, attr);
    if (v !== null && DOWNLOAD_SCHEME_RE.test(v)) return true;
  }
  return false;
}

// Form submissions: a <form>'s action, or a submit control's formaction, live or stashed by a lock.
const FORM_TARGET_SEL =
  'form, [formaction], [data-ped-action], [data-ped-att-action], [data-ped-formaction], [data-ped-att-formaction]';
const FORM_TARGET_ATTRS = ['action', 'data-ped-action', 'data-ped-att-action'] as const;
const CONTROL_TARGET_ATTRS = ['formaction', 'data-ped-formaction', 'data-ped-att-formaction'] as const;

// Characters (and nodes) read from each end of an inline download's text for its name: nested SVG <a> downloads
// around one large text must not each read all of it. The end is kept, so the extension the danger check reads survives.
const ATTACHMENT_NAME_TEXT = 512;

/**
 * Extract inline download/data:/blob: links inside an email body container: `<a>` and `<area>`, SVG `<a>`
 * with `xlink:href`, forms and submit controls that submit to such a URL (a data: response the browser cannot
 * render is saved as a file), and stashed (locked) attributes. The scheme is read from the parsed URL, so case,
 * leading spaces and embedded tabs/newlines (` data:`, `da&#10;ta:`) are normalised the way the browser does.
 * If there are more than MAX_ATTACHMENTS, the container itself is returned as the last entry so the whole
 * body is attachment-locked rather than leaving the extra downloads live.
 */
export function inlineAttachmentsIn(container: HTMLElement): AttachmentRef[] {
  const base = ownerDocOf(container).baseURI || 'https://invalid.local';
  const out: AttachmentRef[] = [];
  const seen = new Set<Element>();
  const isDownloadUrl = (u: string) => u.startsWith('data:') || u.startsWith('blob:');
  const add = (el: HTMLElement, name: string): boolean => {
    if (seen.has(el)) return true;
    if (out.length >= MAX_ATTACHMENTS) {
      out.push({ name: '', element: container });
      return false;
    }
    seen.add(el);
    out.push({ name, element: el });
    return true;
  };

  for (const el of container.querySelectorAll<HTMLElement>('a, area')) {
    const dl = getAttr(el, 'download') ?? getAttr(el, 'data-ped-att-download');
    // Resolving every href parses a URL; only data:/blob: schemes (in any spelling the URL parser accepts) matter.
    if (dl === null && !mayBeDownloadScheme(el)) continue;
    const href = resolveAnchorHref(el, true);
    if (dl === null && !isDownloadUrl(href)) continue;
    const dlAttr = dl ?? '';
    const name = cleanAttachmentName(
      dlAttr ||
        filenameFromHref(href, base) ||
        getAttr(el, 'aria-label') ||
        getAttr(el, 'title') ||
        textEnds(el, 2 * ATTACHMENT_NAME_TEXT, ATTACHMENT_NAME_TEXT) ||
        '',
    );
    if (!add(el, name)) return out;
  }
  // A form (its action) or a submit control (its formaction) aimed at a data:/blob: URL downloads on submit, with
  // any method. Any live or stashed value counts (over-matching only locks more). The name comes from labels only:
  // the browser picks the saved file's name, and the control's text is not one.
  for (const el of container.querySelectorAll<HTMLElement>(FORM_TARGET_SEL)) {
    const attrs = tagOf(el) === 'form' ? FORM_TARGET_ATTRS : CONTROL_TARGET_ATTRS;
    const isDownload = attrs.some((attr) => {
      const v = getAttr(el, attr);
      return v !== null && DOWNLOAD_SCHEME_RE.test(v) && isDownloadUrl(resolveAgainstBase(v, base));
    });
    if (!isDownload) continue;
    const name = cleanAttachmentName(getAttr(el, 'aria-label') || getAttr(el, 'title') || '');
    if (!add(el, name)) return out;
  }
  // SVG SMIL can point a link at a data:/blob: download with no such href in the markup (and keeps doing so after
  // a lock stashes the animation). An animation aimed elsewhere by its own href locks the whole body instead.
  for (const anim of container.querySelectorAll<Element>('set, animate')) {
    if (!animatesHref(anim)) continue;
    if (![...animValues(anim)].some((v) => isDownloadUrl(resolveAgainstBase(v, base)))) continue;
    // Aimed at another element (also once a lock has stashed that href, so the lock does not switch itself off):
    // only locking the whole body stops the animation itself.
    const { target, aimed } = animationTarget(anim);
    const el = aimed ? container : target && tagOf(target) === 'a' ? (target as HTMLElement) : null;
    if (el && !add(el, cleanAttachmentName(getAttr(el, 'download') ?? getAttr(el, 'data-ped-att-download') ?? ''))) return out;
  }
  return out;
}
