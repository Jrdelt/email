import { cleanAttachmentName } from '../attachments';
import { textOf } from '../dom';
import { unwrapRedirectUrl } from '../linkGuard';
import {
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  bodyText,
  extractSenderFromElement,
  inlineAttachmentsIn,
  isHidden,
  isNestedIn,
  sameOriginFrameDocs,
  isUnsafeNode,
  linksIn,
} from './extract';
import type { AttachmentRef, WebmailAdapter } from './types';

const BODY_IFRAMES = '[aria-label*="Reading Pane" i] iframe, iframe[title*="Message" i]';

const HOSTS = new Set(['outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'outlook.cloud.microsoft']);

const BODY_SELECTORS = [
  'div[aria-label="Message body"]',
  'div[id^="UniqueMessageBody"]',
  '[data-testid="message-body"]',
  '[data-app-section="ConversationContainer"] [role="document"]',
  '[aria-label*="Reading Pane" i] [role="document"]',
  '[aria-label="Email message"] [role="document"]',
];

const isEditable = (el: HTMLElement): boolean =>
  isUnsafeNode(el) ||
  el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.closest('[contenteditable="true"]') !== null;

const hasContent = (el: HTMLElement): boolean =>
  (el.textContent ?? '').trim().length > 0 ||
  el.querySelector('a[href], a[data-ped-href], area[href], area[data-ped-href]') !== null;

/** Unwrap Microsoft Defender Safe Links (and nested redirect wrappers) when pointing to http(s). */
export const unwrapSafeLink = unwrapRedirectUrl;

function findBodies(doc: Document): { container: HTMLElement; hostEl: HTMLElement }[] {
  for (const sel of BODY_SELECTORS) {
    const valid: HTMLElement[] = [];
    for (const el of doc.querySelectorAll<HTMLElement>(sel)) {
      if (isEditable(el) || isHidden(el) || !hasContent(el)) continue;
      if (isNestedIn(el, BODY_SELECTORS)) continue;
      if (valid.some((prev) => prev.contains(el))) continue;
      valid.push(el);
    }
    if (valid.length > 0) return valid.map((el) => ({ container: el, hostEl: el }));
  }
  const results: { container: HTMLElement; hostEl: HTMLElement }[] = [];
  for (const iframe of doc.querySelectorAll<HTMLIFrameElement>(BODY_IFRAMES)) {
    if (isHidden(iframe)) continue;
    try {
      const body = iframe.contentDocument?.body;
      if (body && !isEditable(body) && hasContent(body)) results.push({ container: body, hostEl: iframe });
    } catch { /* cross-origin iframe */ }
  }
  return results;
}

function findMessageScope(doc: Document, hostEl: HTMLElement): HTMLElement | null {
  return (
    hostEl.closest<HTMLElement>('[aria-label="Email message"], [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.querySelector<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.body
  );
}

function findSender(doc: Document, container: HTMLElement, hostEl: HTMLElement): { senderName: string; senderAddress: string } {
  const scope = findMessageScope(doc, hostEl);
  if (!scope) return { senderName: '', senderAddress: '' };

  const skip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    container === el ||
    container.contains(el) ||
    el.closest('[role="banner"], nav, [aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i], [data-testid*="recipient" i]') !== null ||
    /^(to|cc|bcc)\b/i.test(el.getAttribute('aria-label') ?? '');

  // Pass 1: explicit From / sender nodes inside scope
  for (const el of scope.querySelectorAll('[aria-label^="From" i], [data-testid*="sender" i], [data-testid*="from" i], span.OZZZK')) {
    if (skip(el)) continue;
    const direct = extractSenderFromElement(el);
    if (direct) return direct;
    for (const d of el.querySelectorAll('[title*="@"], [aria-label*="@"], a[href^="mailto:"]')) {
      if (skip(d)) continue;
      const hit = extractSenderFromElement(d);
      if (hit) return hit;
    }
  }

  // Pass 2: header attribute nodes in DOM order inside scope
  for (const el of scope.querySelectorAll('[title*="@"], [aria-label*="@"], a[href^="mailto:"]')) {
    if (skip(el)) continue;
    const hit = extractSenderFromElement(el);
    if (hit) return hit;
  }

  // Pass 3: plain-text Name<addr@domain> or addr@domain inside header span/button in scope
  let nonLeafHit: { senderName: string; senderAddress: string } | null = null;
  let bareLeafHit: { senderName: string; senderAddress: string } | null = null;
  for (const el of scope.querySelectorAll('span, button')) {
    if (skip(el)) continue;
    const text = (el.textContent ?? '').trim();
    if (!text.includes('@') || text.length > 200) continue;
    const hit = extractSenderFromElement(el);
    if (!hit) continue;
    const hasChildAt = [...el.children].some((c) => textOf(c).includes('@'));
    if (!hasChildAt) {
      if (hit.senderName) return hit;
      bareLeafHit ??= hit;
    } else {
      nonLeafHit ??= hit;
    }
  }
  return (nonLeafHit?.senderName ? nonLeafHit : bareLeafHit) ?? nonLeafHit ?? { senderName: '', senderAddress: '' };
}

function findSubject(doc: Document, container: HTMLElement): string {
  const pane = doc.querySelector<HTMLElement>(
    '[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i]',
  );
  if (!pane) return '';
  for (const h of pane.querySelectorAll<HTMLElement>('[role="heading"], h1, h2')) {
    if (isUnsafeNode(h) || container.contains(h) || isHidden(h)) continue;
    const text = (h.textContent ?? '').trim();
    if (text && text.length <= 300) return text;
  }
  return '';
}

function outlookItemName(el: HTMLElement): string {
  const dl = cleanAttachmentName(el.getAttribute('download') ?? el.getAttribute('data-ped-att-download') ?? '');
  if (dl) return dl;
  const fileEl = el.querySelector<HTMLElement>('[class*="fileName" i]');
  const fromFileEl = cleanAttachmentName(fileEl?.textContent ?? '');
  if (fromFileEl) return fromFileEl;
  for (const attr of ['aria-label', 'title'] as const) {
    const candidate = cleanAttachmentName(el.getAttribute(attr) ?? '');
    if (candidate) return candidate;
  }
  const text = (el.textContent ?? '').trim();
  return text.length <= 180 ? cleanAttachmentName(text) : '';
}

function isOutlookBulkLabel(el: Element): boolean {
  const txt = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.textContent ?? ''}`;
  return /\b(?:download\s+all|save\s+all\s+to\s+onedrive)\b/i.test(txt);
}

function extractOutlookAttachments(
  doc: Document,
  container: HTMLElement,
  hostEl: HTMLElement,
): { attachments: AttachmentRef[]; attachmentContainers: HTMLElement[] } {
  const attachments: AttachmentRef[] = [...inlineAttachmentsIn(container)];
  const inlineCount = attachments.length; // the chip cap below counts this adapter's own chips only
  const wells: HTMLElement[] = [];
  const attachmentContainers: HTMLElement[] = [];

  const scope =
    hostEl.closest<HTMLElement>('[aria-label="Email message"], [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.querySelector<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]');
  if (!scope) return { attachments, attachmentContainers };

  const shouldSkip = (el: Element): boolean => {
    if (isUnsafeNode(el) || el === container || el.contains(container)) return true;
    if (el instanceof HTMLElement && isHidden(el)) return true;
    if (el.closest('[role="banner"], nav, [contenteditable="true"], [aria-label*="Compose" i]') !== null) return true;
    const lbl = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
    return /^(?:attach|insert)\b/i.test(lbl);
  };

  const wellSel = [
    '[role="region"][aria-label*="attachment" i]',
    '[role="group"][aria-label*="attachment" i]',
    '[data-testid*="attachment" i]:not([data-testid*="attachment-card" i]):not([data-testid*="file-attachment" i])',
    '[class*="attachmentWell" i]',
    '[class*="AttachmentWell" i]',
  ].join(', ');
  for (const well of scope.querySelectorAll<HTMLElement>(wellSel)) {
    if (shouldSkip(well) || wells.some((prev) => prev.contains(well))) continue;
    wells.push(well);
    attachmentContainers.push(well);
  }

  const cardSel = [
    '[aria-label*="Attached file" i]',
    '[role="listitem"][aria-label*="attachment" i]',
    '[role="option"][aria-label*="attachment" i]',
    '[data-testid*="attachment-card" i]',
    '[data-testid*="file-attachment" i]',
    'a[download]',
    'a[data-ped-att-download]',
    'button[aria-label*="Download" i]',
    'a[aria-label*="Download" i]',
  ].join(', ');

  const addCard = (el: HTMLElement) => {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) return;
    if (shouldSkip(el) || isOutlookBulkLabel(el)) return;
    if (attachments.some((prev) => prev.element === el || prev.element.contains(el))) return;
    attachments.push({ name: outlookItemName(el), element: el });
  };

  for (const card of scope.querySelectorAll<HTMLElement>(cardSel)) addCard(card);
  for (const well of wells) {
    for (const card of well.querySelectorAll<HTMLElement>('[role="button"], button, a')) addCard(card);
  }

  for (const btn of scope.querySelectorAll<HTMLElement>('[aria-label*="Download all" i], [aria-label*="Save all to OneDrive" i]')) {
    if (shouldSkip(btn) || attachmentContainers.some((c) => c === btn || c.contains(btn))) continue;
    attachmentContainers.push(btn);
  }

  for (const well of wells) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => well.contains(a.element) || a.element === well)) {
      attachments.push({ name: '', element: well });
    }
  }

  return { attachments, attachmentContainers };
}

export const outlook: WebmailAdapter = {
  name: 'outlook',
  matches: (url) => HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, '')),
  extractAll(doc) {
    return findBodies(doc).map(({ container, hostEl }) => {
      const { senderName, senderAddress } = findSender(doc, container, hostEl);
      const subject = findSubject(doc, container);
      const body = [subject, bodyText(container)].filter(Boolean).join('\n').slice(0, MAX_BODY_CHARS);
      const links = linksIn(container).map((l) => ({ text: l.text, href: unwrapSafeLink(l.href) }));
      const { attachments, attachmentContainers } = extractOutlookAttachments(doc, container, hostEl);
      return {
        senderName,
        senderAddress,
        body,
        links,
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  frameDocs: (doc) => sameOriginFrameDocs(doc, BODY_IFRAMES),
  extract(doc) {
    const all = outlook.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
