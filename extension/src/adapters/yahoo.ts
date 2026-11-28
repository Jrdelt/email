import { cleanAttachmentName } from '../attachments';
import {
  MAX_ATTACHMENTS,
  bodyText,
  withSubject,
  extractSenderFromElement,
  inlineAttachmentsIn,
  type BodyHit,
  isHidden,
  chooseBodies,
  pickBodies,
  pickFrameBodies,
  sameOriginFrameDocs,
  isUnsafeNode,
  linkFields,
  inExcludedRegion,
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

const BODY_IFRAMES = '[data-test-id="message-view-body"] iframe, iframe[title*="message" i]';

const BODY_SELECTORS = [
  '[data-test-id="message-view-body-content"]',
  '.msg-body',
  '[data-test-id="message-body"]',
];

const isCompose = (el: HTMLElement): boolean =>
  isUnsafeNode(el) ||
  el.isContentEditable ||
  el.getAttribute('contenteditable') === 'true' ||
  el.closest('[contenteditable="true"], [data-test-id="compose-editor"], [data-test-id="rte"]') !== null;

function findBodies(doc: Document): BodyHit[] {
  // The first source with content wins, keeping its empty bodies (attachment-only messages in a conversation).
  return chooseBodies(pickBodies(doc, BODY_SELECTORS, isCompose), pickFrameBodies(doc, BODY_IFRAMES, isCompose));
}

/** The message card around the body (never the body or its own wrapper, which hold no header or attachments). */
function findScope(doc: Document, hostEl: HTMLElement): HTMLElement {
  const start = hostEl.parentElement ?? hostEl;
  return (
    start.closest<HTMLElement>('[data-test-id="message-card"], [role="listitem"]') ??
    start.closest<HTMLElement>('[data-test-id="message-group-view"], [role="main"]') ??
    doc.body
  );
}

const SUBJECT_SEL = '[data-test-id="message-group-subject-text"], [data-test-id="message-subject"], main h1, [role="main"] h1';
const ATTACHMENT_LIST_SEL = '[data-test-id="attachment-list"], [aria-label*="attachment" i][role="list"]';
const ATTACHMENT_TILE_SEL =
  '[data-test-id="attachment-tile"], [data-test-id="attachment-download-btn"], a[download], a[data-ped-att-download]';
// Regions that never hold the sender: attachment lists/tiles (attacker-chosen file names) and the subject.
const SENDER_EXCLUDE_SEL = `${ATTACHMENT_LIST_SEL}, ${ATTACHMENT_TILE_SEL}, [data-test-id="attachment-filename"], ${SUBJECT_SEL}`;

/**
 * The sender of the message card around `hostEl`. `uncertain` marks an address found only by the card-wide pass:
 * without the header's own sender node it may come from anywhere in the card, so it is never allowlist-trusted.
 */
function findSender(
  doc: Document,
  container: HTMLElement,
  hostEl: HTMLElement,
): { senderName: string; senderAddress: string; uncertain?: true } {
  const scope = findScope(doc, hostEl);
  const skip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    el === container ||
    container.contains(el) ||
    el.closest('[data-test-id="recipient-list"], [aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i]') !== null ||
    inExcludedRegion(el, scope, hostEl, SENDER_EXCLUDE_SEL);

  for (const el of scope.querySelectorAll(
    '[data-test-id="message-from"], [data-test-id="sender-name"], [data-test-id="message-header"] [title*="@"], [data-test-id="message-header"] [aria-label*="@"]',
  )) {
    if (skip(el)) continue;
    const hit = extractSenderFromElement(el);
    if (hit) return hit;
  }
  for (const el of scope.querySelectorAll('[title*="@"], [aria-label*="@"], a[href^="mailto:"]')) {
    if (skip(el)) continue;
    const hit = extractSenderFromElement(el);
    if (hit) return { ...hit, uncertain: true };
  }
  return { senderName: '', senderAddress: '' };
}

function findSubject(doc: Document, container: HTMLElement): string {
  for (const el of doc.querySelectorAll<HTMLElement>(SUBJECT_SEL)) {
    if (isUnsafeNode(el) || container.contains(el) || isHidden(el)) continue;
    const t = (el.textContent ?? '').trim();
    if (t && t.length <= 300) return t;
  }
  return '';
}

function yahooItemName(el: HTMLElement): string {
  const dl = cleanAttachmentName(el.getAttribute('download') ?? el.getAttribute('data-ped-att-download') ?? '');
  if (dl) return dl;
  const titleEl = el.querySelector<HTMLElement>('[data-test-id="attachment-filename"], [class*="filename" i]');
  const fromTitle = cleanAttachmentName(titleEl?.textContent ?? '');
  if (fromTitle) return fromTitle;
  for (const attr of ['aria-label', 'title'] as const) {
    const c = cleanAttachmentName(el.getAttribute(attr) ?? '');
    if (c) return c;
  }
  const text = (el.textContent ?? '').trim();
  return text.length <= 180 ? cleanAttachmentName(text) : '';
}

function extractYahooAttachments(
  doc: Document,
  container: HTMLElement,
  hostEl: HTMLElement,
): { attachments: AttachmentRef[]; attachmentContainers: HTMLElement[] } {
  const attachments: AttachmentRef[] = [...inlineAttachmentsIn(container)];
  const inlineCount = attachments.length; // the chip cap below counts this adapter's own chips only
  const attachmentContainers: HTMLElement[] = [];
  const scope = findScope(doc, hostEl);

  const shouldSkip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    el === container ||
    el.contains(container) ||
    (el instanceof HTMLElement && (isHidden(el) || isCompose(el)));

  for (const list of scope.querySelectorAll<HTMLElement>(ATTACHMENT_LIST_SEL)) {
    if (shouldSkip(list) || attachmentContainers.some((c) => c.contains(list))) continue;
    attachmentContainers.push(list);
  }

  for (const tile of scope.querySelectorAll<HTMLElement>(ATTACHMENT_TILE_SEL)) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (shouldSkip(tile)) continue;
    if (attachments.some((p) => p.element === tile || p.element.contains(tile))) continue;
    attachments.push({ name: yahooItemName(tile), element: tile });
  }

  for (const list of attachmentContainers) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => list.contains(a.element) || a.element === list)) {
      attachments.push({ name: '', element: list });
    }
  }
  return { attachments, attachmentContainers };
}

export const yahoo: WebmailAdapter = {
  name: 'yahoo',
  matches: (url) => url.hostname.toLowerCase().replace(/\.$/, '') === 'mail.yahoo.com',
  extractAll(doc): ExtractedEmail[] {
    return findBodies(doc).map(({ container, hostEl }) => {
      const { senderName, senderAddress, uncertain } = findSender(doc, container, hostEl);
      const subject = findSubject(doc, container);
      const body = withSubject(subject, bodyText(container));
      const { attachments, attachmentContainers } = extractYahooAttachments(doc, container, hostEl);
      return {
        senderName,
        senderAddress,
        ...(uncertain ? { pairingUncertain: true } : {}),
        body,
        ...linkFields(container),
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  frameDocs: (doc) => sameOriginFrameDocs(doc, BODY_IFRAMES),
  extract(doc) {
    const all = yahoo.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
