import { cleanAttachmentName } from '../attachments';
import {
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  bodyText,
  extractSenderFromElement,
  inlineAttachmentsIn,
  isHidden,
  isNestedIn,
  isUnsafeNode,
  linksIn,
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

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

const hasContent = (el: HTMLElement): boolean =>
  (el.textContent ?? '').trim().length > 0 ||
  el.querySelector('a[href], a[data-ped-href], area[href], area[data-ped-href]') !== null;

function findBodies(doc: Document): { container: HTMLElement; hostEl: HTMLElement }[] {
  const iframeHits: { container: HTMLElement; hostEl: HTMLElement }[] = [];
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(
    'iframe[data-testid="content-iframe"], iframe[title*="Email content" i]',
  )) {
    if (isHidden(iframe) || isCompose(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !isCompose(body) && hasContent(body)) iframeHits.push({ container: body, hostEl: iframe });
    } catch {
      /* cross-origin iframe */
    }
  }
  if (iframeHits.length > 0) return iframeHits;

  for (const sel of DIRECT_BODY_SELECTORS) {
    const valid: HTMLElement[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      if (isCompose(el) || isHidden(el) || !hasContent(el)) continue;
      if (isNestedIn(el, DIRECT_BODY_SELECTORS)) continue;
      if (el.querySelector('iframe[data-testid="content-iframe"]')) continue;
      if (valid.some((prev) => prev.contains(el))) continue;
      valid.push(el);
    }
    if (valid.length > 0) return valid.map((el) => ({ container: el, hostEl: el }));
  }
  return [];
}

function findScope(doc: Document, hostEl: HTMLElement): HTMLElement {
  return (
    hostEl.closest<HTMLElement>('[data-testid^="message-view"], article, [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-testid="conversation-view"], main, [role="main"]') ??
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
      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      const { attachments, attachmentContainers } = extractProtonAttachments(doc, container, hostEl);
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
    const all = proton.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
