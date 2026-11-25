import { cleanAttachmentName } from '../attachments';
import { XLINK_NS, closestEl, getAttr, getAttrNS, hasAttr, isFormEl, rawLinkTarget, ownerDocOf, resolveAgainstBase, resolveAnchorHref, tagOf, textOf } from '../dom';
import { INVISIBLE_RE, safePercentDecode, type Link } from '../features';
import { unwrapRedirectUrl } from '../linkGuard';
import type { AttachmentRef } from './types';

export const MAX_BODY_CHARS = 20_000; // cap work per email
export const MAX_LINKS = 200;
export const MAX_LINK_TEXT_CHARS = 2048; // link text only needs to show a URL or domain
const MAX_LINK_SCAN = 10 * MAX_LINKS; // bound on links examined before de-duplication and sampling
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

/**
 * Message bodies for adapters: the first selector (in priority order) with visible, non-excluded matches, keeping
 * only the outermost candidates. With `requireContent`, empty candidates are skipped; adapters retry without it so
 * an email with only an attachment (empty body) is still found, scanned and attachment-locked.
 */
export function pickBodies(
  doc: Document,
  selectors: readonly string[],
  excluded: (el: HTMLElement) => boolean,
  requireContent: boolean,
): BodyHit[] {
  for (const sel of selectors) {
    const valid: HTMLElement[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      if (excluded(el) || isHidden(el) || (requireContent && !hasMessageContent(el))) continue;
      if (isNestedIn(el, selectors)) continue;
      if (valid.some((prev) => prev.contains(el))) continue;
      valid.push(el);
    }
    if (valid.length > 0) return valid.map((el) => ({ container: el, hostEl: el }));
  }
  return [];
}

/** Bodies of same-origin message iframes (cross-origin ones are skipped). */
export function pickFrameBodies(
  doc: Document,
  selector: string,
  excluded: (el: HTMLElement) => boolean,
  requireContent: boolean,
): BodyHit[] {
  const out: BodyHit[] = [];
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(selector)) {
    if (isHidden(iframe) || excluded(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !excluded(body) && (!requireContent || hasMessageContent(body))) out.push({ container: body, hostEl: iframe });
    } catch {
      /* cross-origin iframe */
    }
  }
  return out;
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

const NON_TEXT_TAGS = new Set(['style', 'script', 'noscript', 'template']);

/** Keep the start and the end of an over-long list or text, so padding at the top cannot hide what follows. */
function headAndTail<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : [...items.slice(0, Math.ceil(max / 2)), ...items.slice(items.length - Math.floor(max / 2))];
}

/**
 * Bound attacker-controlled text (link text, header labels) without letting filler hide what matters: over `max`,
 * drop characters that render as nothing, collapse whitespace runs, then keep the first and last halves.
 */
export function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const visible = text.replace(INVISIBLE_RE, '').replace(/\s+/g, ' ');
  if (visible.length <= max) return visible;
  const half = Math.floor(max / 2);
  return `${visible.slice(0, half)} ${visible.slice(visible.length - (max - half - 1))}`; // exactly max chars
}

/** Prepend the subject (bounded) without cutting the end of the already-sampled body. */
export const withSubject = (subject: string, body: string): string =>
  subject ? (body ? `${subject.slice(0, 300)}\n${body}` : subject.slice(0, 300)) : body;

const textFilter: NodeFilter = {
  acceptNode: (n) => (n.nodeType === 1 ? (NON_TEXT_TAGS.has(tagOf(n as Element)) ? 2 /* REJECT subtree */ : 3 /* SKIP */) : 1),
};

/**
 * Message text for scoring: skips CSS/script text and, when longer than MAX_BODY_CHARS, keeps the first and last
 * halves so filler at the top cannot push the real message out of reach. Work stays bounded however long the body
 * is: the start is read forwards and the end backwards, and the middle is never visited.
 */
export function bodyText(el: HTMLElement): string {
  const doc = ownerDocOf(el);
  const half = Math.floor(MAX_BODY_CHARS / 2);
  const head: string[] = [];
  const headNodes = new Set<Node>();
  let headLen = 0;
  const forward = doc.createTreeWalker(el, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */, textFilter);
  let n = forward.nextNode();
  for (; n && headLen < MAX_BODY_CHARS; n = forward.nextNode()) {
    const t = n.nodeValue ?? '';
    head.push(t);
    headNodes.add(n);
    headLen += t.length;
  }
  let text = head.join('');
  if (n) {
    // More text follows: read the end backwards until half a body is collected or the head is reached.
    const tail: string[] = [];
    let tailLen = 0;
    let joined = false;
    const backward = doc.createTreeWalker(el, 0x1 | 0x4, textFilter);
    for (let m = backward.lastChild(); m && tailLen < half; m = backward.previousNode()) {
      if (headNodes.has(m)) {
        joined = true;
        break;
      }
      const t = m.nodeValue ?? '';
      tail.push(t);
      tailLen += t.length;
    }
    text = `${text}${joined ? '' : '\n'}${tail.reverse().join('')}`;
  }
  if (text.length <= MAX_BODY_CHARS) return text;
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
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

/** Every value a SMIL animation can set (de-duplicated). */
const animValues = (anim: Element): Set<string> =>
  new Set([getAttr(anim, 'to') ?? '', ...(getAttr(anim, 'values') ?? '').split(';')]);

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
      const anchor = closestEl(node, 'a');
      const text = anchor ? capText(textOf(anchor), MAX_LINK_TEXT_CHARS) : '';
      for (const raw of animValues(node)) {
        const href = resolveAgainstBase(raw, base);
        if (!href) continue;
        if (out.length >= MAX_LINK_SCAN) {
          truncated = true;
          break;
        }
        out.push({ text, href });
      }
    } else if (tag === 'a' || tag === 'area') {
      const href = resolveAnchorHref(node, true);
      // Score the real destination behind redirect/link-rewriting wrappers (Safe Links, Proofpoint, google.com/url…).
      if (href) out.push({ text: capText(textOf(node), MAX_LINK_TEXT_CHARS), href: unwrapCached(href) });
    } else if (tag === 'form') {
      const raw = getAttr(node, 'action') ?? getAttr(node, 'data-ped-action') ?? '';
      const href = resolveAgainstBase(raw, base);
      if (href) out.push({ text: '', href });
    } else if (hasAttr(node, 'formaction') || hasAttr(node, 'data-ped-formaction') || hasAttr(node, 'data-ped-att-formaction')) {
      const raw =
        getAttr(node, 'formaction') ??
        getAttr(node, 'data-ped-formaction') ??
        getAttr(node, 'data-ped-att-formaction') ??
        '';
      const href = resolveAgainstBase(raw, base);
      const text = capText(textOf(node) || getAttr(node, 'value') || '', MAX_LINK_TEXT_CHARS).trim();
      if (href) out.push({ text, href });
    }
  }
  // Identical links add nothing; past the cap keep the first and last ones for scoring and report the truncation.
  const seen = new Set<string>();
  const unique = out.filter((l) => {
    const key = `${l.href}\t${l.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { links: headAndTail(unique, MAX_LINKS), truncated: truncated || unique.length > MAX_LINKS };
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

/**
 * Extract inline download/data:/blob: links inside an email body container: `<a>` and `<area>`, SVG `<a>`
 * with `xlink:href`, and stashed (locked) attributes. The scheme is read from the parsed URL, so case,
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
        textOf(el) ||
        '',
    );
    if (!add(el, name)) return out;
  }
  // SVG SMIL can point a link at a data:/blob: download with no such href in the markup (and keeps doing so after
  // a lock stashes the animation). An animation aimed elsewhere by its own href locks the whole body instead.
  for (const anim of container.querySelectorAll<Element>('set, animate')) {
    if (!animatesHref(anim)) continue;
    if (![...animValues(anim)].some((v) => isDownloadUrl(resolveAgainstBase(v, base)))) continue;
    const aimed = hasAttr(anim, 'href') || hasAttr(anim, 'xlink:href') || getAttrNS(anim, XLINK_NS, 'href') !== null;
    const parent = anim.parentElement;
    const el = aimed ? container : parent && tagOf(parent) === 'a' ? (parent as HTMLElement) : null;
    if (el && !add(el, cleanAttachmentName(getAttr(el, 'download') ?? getAttr(el, 'data-ped-att-download') ?? ''))) return out;
  }
  return out;
}
