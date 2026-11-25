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
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

const CONTENT_IFRAMES = 'iframe[data-testid="content-iframe"], iframe[title*="Email content" i]';

// Proton Mail decrypts messages locally in the browser and renders HTML inside a same-origin/srcdoc
// content iframe ([data-testid="content-iframe"]) or body container ([data-testid="message-content:body"]).
// This adapter reads only the locally decrypted visible DOM and never touches Proton APIs or compose editors.
const DIRECT_BODY_SELECTORS = [
  '[data-testid="message-content:body"]',
  '[data-testid="message-view:body"]',
  '.message-content',
];

const isCompose = (el: HTMLElement): boolean =>
  isUnsafeNode(el) ||
  el.isContentEditable ||
  el.getAttribute('contenteditable') === 'true' ||
  el.closest('[contenteditable="true"], [data-testid^="composer"], .composer') !== null;

function findBodies(doc: Document): BodyHit[] {
  // A direct body that merely wraps the content iframe is not itself the message.
  const excludedDirect = (el: HTMLElement) => isCompose(el) || el.querySelector('iframe[data-testid="content-iframe"]') !== null;
  // The first source with content wins, keeping its empty bodies (attachment-only messages in a conversation).
  return chooseBodies(
    pickFrameBodies(doc, CONTENT_IFRAMES, isCompose),
    pickBodies(doc, DIRECT_BODY_SELECTORS, excludedDirect),
  );
}

/** The message view around the body (never the body itself: message-view:body also matches ^="message-view"). */
function findScope(doc: Document, hostEl: HTMLElement): HTMLElement {
  const start = hostEl.parentElement ?? hostEl;
  return (
    start.closest<HTMLElement>('[data-testid^="message-view"]:not([data-testid="message-view:body"]), article, [role="listitem"]') ??
    start.closest<HTMLElement>('[data-testid="conversation-view"], main, [role="main"]') ??
    doc.body
  );
}

const FROM_BLOCK_SELECTORS = [
  '[data-testid="message-header:from"]',
  '[data-testid="message-header-expanded"]',
  '[data-testid="message-header"]',
];

function findSender(doc: Document, container: HTMLElement, hostEl: HTMLElement): { senderName: string; senderAddress: string } {
  const scope = findScope(doc, hostEl);
  const skip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    el === container ||
    container.contains(el) ||
    el.closest('[data-testid*="recipients:to"], [data-testid*="recipients:cc"], [data-testid*="recipients:bcc"]') !== null;

  // Most specific first: the outer header also contains the display name and the recipients.
  const fromBlock =
    FROM_BLOCK_SELECTORS.map((sel) => scope.querySelector<HTMLElement>(sel)).find((el) => el && !skip(el)) ?? null;
  const searchRoot = fromBlock ?? scope;
  const fallbackName =
    (searchRoot.querySelector<HTMLElement>('[data-testid="recipient-name"], [data-testid="message-header:from-name"]')?.textContent ?? '')
      .trim();

  if (fromBlock) {
    const direct = extractSenderFromElement(fromBlock, fallbackName);
    if (direct) return direct;
  }

  for (const el of searchRoot.querySelectorAll(
    '[data-testid="recipient-address"], [data-testid="message-header:from"], [title*="@"], [aria-label*="@"], a[href^="mailto:"]',
  )) {
    if (skip(el)) continue;
    const hit = extractSenderFromElement(el, fallbackName);
    if (hit) return hit;
  }
  return { senderName: fallbackName, senderAddress: '' };
}

function findSubject(doc: Document, container: HTMLElement): string {
  for (const el of doc.querySelectorAll<HTMLElement>(
    '[data-testid="conversation-header:subject"], [data-testid="message-column:subject"], h1[title]',
  )) {
    if (isUnsafeNode(el) || container.contains(el) || isHidden(el)) continue;
    const t = (el.textContent ?? '').trim();
    if (t && t.length <= 300) return t;
  }
  return '';
}

function protonItemName(el: HTMLElement): string {
  const dl = cleanAttachmentName(el.getAttribute('download') ?? el.getAttribute('data-ped-att-download') ?? '');
  if (dl) return dl;
  const nameEl = el.querySelector<HTMLElement>('[data-testid="attachment-item:name"], [data-testid="file-name"]');
  const fromName = cleanAttachmentName(nameEl?.textContent ?? '');
  if (fromName) return fromName;
  for (const attr of ['title', 'aria-label'] as const) {
    const c = cleanAttachmentName(el.getAttribute(attr) ?? '');
    if (c) return c;
  }
  const text = (el.textContent ?? '').trim();
  return text.length <= 180 ? cleanAttachmentName(text) : '';
}

function extractProtonAttachments(
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

  for (const list of scope.querySelectorAll<HTMLElement>('[data-testid="attachment-list"]')) {
    if (shouldSkip(list) || attachmentContainers.some((c) => c.contains(list))) continue;
    attachmentContainers.push(list);
  }

  for (const item of scope.querySelectorAll<HTMLElement>(
    '[data-testid^="attachment-item"]:not([data-testid="attachment-item:name"]), a[download], a[data-ped-att-download]',
  )) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (shouldSkip(item)) continue;
    if (attachments.some((p) => p.element === item || p.element.contains(item))) continue;
    attachments.push({ name: protonItemName(item), element: item });
  }

  for (const bulk of scope.querySelectorAll<HTMLElement>('[data-testid="attachment-list:download-all"]')) {
    if (shouldSkip(bulk) || attachmentContainers.some((c) => c === bulk || c.contains(bulk))) continue;
    attachmentContainers.push(bulk);
  }

  for (const list of attachmentContainers) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => list.contains(a.element) || a.element === list)) {
      attachments.push({ name: '', element: list });
    }
  }
  return { attachments, attachmentContainers };
}

export const proton: WebmailAdapter = {
  name: 'proton',
  matches: (url) => url.hostname.toLowerCase().replace(/\.$/, '') === 'mail.proton.me',
  extractAll(doc): ExtractedEmail[] {
    return findBodies(doc).map(({ container, hostEl }) => {
      const { senderName, senderAddress } = findSender(doc, container, hostEl);
      const subject = findSubject(doc, container);
      const body = withSubject(subject, bodyText(container));
      const { attachments, attachmentContainers } = extractProtonAttachments(doc, container, hostEl);
      return {
        senderName,
        senderAddress,
        body,
        ...linkFields(container),
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  frameDocs: (doc) => sameOriginFrameDocs(doc, CONTENT_IFRAMES),
  extract(doc) {
    const all = proton.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
