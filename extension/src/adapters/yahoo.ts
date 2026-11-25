import { cleanAttachmentName } from '../attachments';
import {
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  bodyText,
  extractSenderFromElement,
  inlineAttachmentsIn,
  isHidden,
  isUnsafeNode,
  linksIn,
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

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

const hasContent = (el: HTMLElement): boolean =>
  (el.textContent ?? '').trim().length > 0 ||
  el.querySelector('a[href], a[data-ped-href], area[href], area[data-ped-href]') !== null;

function findBodies(doc: Document): { container: HTMLElement; hostEl: HTMLElement }[] {
  for (const sel of BODY_SELECTORS) {
    const valid: HTMLElement[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      if (isCompose(el) || isHidden(el) || !hasContent(el)) continue;
      if (valid.some((prev) => prev.contains(el))) continue;
      valid.push(el);
    }
    if (valid.length > 0) return valid.map((el) => ({ container: el, hostEl: el }));
  }
  const results: { container: HTMLElement; hostEl: HTMLElement }[] = [];
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(
    '[data-test-id="message-view-body"] iframe, iframe[title*="message" i]',
  )) {
    if (isHidden(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !isCompose(body) && hasContent(body)) results.push({ container: body, hostEl: iframe });
    } catch {
      /* cross-origin iframe */
    }
  }
  return results;
}

function findScope(doc: Document, hostEl: HTMLElement): HTMLElement {
  return (
    hostEl.closest<HTMLElement>('[data-test-id="message-view-body"], [data-test-id="message-card"], [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-test-id="message-group-view"], [role="main"]') ??
    doc.body
  );
}

function findSender(doc: Document, container: HTMLElement, hostEl: HTMLElement): { senderName: string; senderAddress: string } {
  const scope = findScope(doc, hostEl);
  const skip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    el === container ||
    container.contains(el) ||
    el.closest('[data-test-id="recipient-list"], [aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i]') !== null;

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
    if (hit) return hit;
  }
  return { senderName: '', senderAddress: '' };
}

function findSubject(doc: Document, container: HTMLElement): string {
  for (const el of doc.querySelectorAll<HTMLElement>(
    '[data-test-id="message-group-subject-text"], [data-test-id="message-subject"], main h1, [role="main"] h1',
  )) {
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

  const listSel = '[data-test-id="attachment-list"], [aria-label*="attachment" i][role="list"]';
  for (const list of scope.querySelectorAll<HTMLElement>(listSel)) {
    if (shouldSkip(list) || attachmentContainers.some((c) => c.contains(list))) continue;
    attachmentContainers.push(list);
  }

  const tileSel =
    '[data-test-id="attachment-tile"], [data-test-id="attachment-download-btn"], a[download], a[data-ped-att-download]';
  for (const tile of scope.querySelectorAll<HTMLElement>(tileSel)) {
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
      const { senderName, senderAddress } = findSender(doc, container, hostEl);
      const subject = findSubject(doc, container);
      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      const { attachments, attachmentContainers } = extractYahooAttachments(doc, container, hostEl);
      return {
        senderName,
        senderAddress,
        body,
        links: linksIn(container),
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  extract(doc) {
    const all = yahoo.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
