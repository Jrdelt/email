import { cleanAttachmentName } from '../attachments';
import { textOf } from '../dom';
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


function findBodies(doc: Document): BodyHit[] {
  // The first source with content wins, keeping its empty bodies (attachment-only messages in a conversation).
  return chooseBodies(pickBodies(doc, BODY_SELECTORS, isEditable), pickFrameBodies(doc, BODY_IFRAMES, isEditable));
}

function findMessageScope(doc: Document, hostEl: HTMLElement): HTMLElement | null {
  return (
    hostEl.closest<HTMLElement>('[aria-label="Email message"], [role="listitem"]') ??
    hostEl.closest<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.querySelector<HTMLElement>('[data-app-section="ConversationContainer"], [aria-label*="Reading Pane" i], [role="main"]') ??
    doc.body
  );
}

// Attachment wells and cards (also what extractOutlookAttachments locks): their labels and text carry attacker-chosen
// file names ("Boss <boss@corp.example>.pdf"), never the sender.
const ATTACHMENT_WELL_SEL = [
  '[role="region"][aria-label*="attachment" i]',
  '[role="group"][aria-label*="attachment" i]',
  '[data-testid*="attachment" i]:not([data-testid*="attachment-card" i]):not([data-testid*="file-attachment" i])',
  '[class*="attachmentWell" i]',
  '[class*="AttachmentWell" i]',
].join(', ');
const ATTACHMENT_CARD_SEL = [
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
// Regions that never hold the sender: attachments and the (attacker-chosen) subject heading.
const SENDER_EXCLUDE_SEL = `${ATTACHMENT_WELL_SEL}, ${ATTACHMENT_CARD_SEL}, [role="heading"], h1, h2`;

type SenderHit = { senderName: string; senderAddress: string };

/**
 * The sender of the message around `hostEl`. `uncertain` marks an address found only by the scope-wide passes (2-3):
 * without an explicit From node it may come from anywhere in the message chrome, so it is never allowlist-trusted.
 */
function findSender(doc: Document, container: HTMLElement, hostEl: HTMLElement): SenderHit & { uncertain?: true } {
  const scope = findMessageScope(doc, hostEl);
  if (!scope) return { senderName: '', senderAddress: '' };

  const skip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    container === el ||
    container.contains(el) ||
    el.closest('[role="banner"], nav, [aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i], [data-testid*="recipient" i]') !== null ||
    /^(to|cc|bcc)\b/i.test(el.getAttribute('aria-label') ?? '');
  const skipLoose = (el: Element): boolean => skip(el) || inExcludedRegion(el, scope, hostEl, SENDER_EXCLUDE_SEL);

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
    if (skipLoose(el)) continue;
    const hit = extractSenderFromElement(el);
    if (hit) return { ...hit, uncertain: true };
  }

  // Pass 3: plain-text Name<addr@domain> or addr@domain inside header span/button in scope. The first address in DOM
  // order wins. A first hit that wraps the address in a child (`<span>Name<span>&lt;addr&gt;</span></span>`) is
  // narrowed to its first leaf, keeping the wrapper's display name for the same address; nothing after the wrapper
  // (an attachment name, a later "Name <addr>" line) can replace it.
  let outer: { el: Element; hit: SenderHit } | null = null;
  for (const el of scope.querySelectorAll('span, button')) {
    if (skipLoose(el)) continue;
    if (outer && !outer.el.contains(el)) break;
    const text = (el.textContent ?? '').trim();
    if (!text.includes('@') || text.length > 200) continue;
    const hit = extractSenderFromElement(el);
    if (!hit) continue;
    if ([...el.children].some((c) => textOf(c).includes('@'))) {
      outer ??= { el, hit };
      continue;
    }
    if (!hit.senderName && outer && outer.hit.senderAddress === hit.senderAddress) return { ...outer.hit, uncertain: true };
    return { ...hit, uncertain: true };
  }
  return outer ? { ...outer.hit, uncertain: true } : { senderName: '', senderAddress: '' };
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

  // Native wells and cards are OWA chrome beside the body, never inside it: in the email HTML, a "Download on the
  // App Store" badge or a data-testid="attachment-..." element is not an attachment (inline downloads come from
  // inlineAttachmentsIn). Node.contains is inclusive, so this also skips the body itself.
  const shouldSkip = (el: Element): boolean => {
    if (isUnsafeNode(el) || container.contains(el) || el.contains(container)) return true;
    if (el instanceof HTMLElement && isHidden(el)) return true;
    if (el.closest('[role="banner"], nav, [contenteditable="true"], [aria-label*="Compose" i]') !== null) return true;
    const lbl = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
    return /^(?:attach|insert)\b/i.test(lbl);
  };

  for (const well of scope.querySelectorAll<HTMLElement>(ATTACHMENT_WELL_SEL)) {
    if (shouldSkip(well) || wells.some((prev) => prev.contains(well))) continue;
    wells.push(well);
    attachmentContainers.push(well);
  }

  const addCard = (el: HTMLElement) => {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) return;
    if (shouldSkip(el) || isOutlookBulkLabel(el)) return;
    if (attachments.some((prev) => prev.element === el || prev.element.contains(el))) return;
    attachments.push({ name: outlookItemName(el), element: el });
  };

  for (const card of scope.querySelectorAll<HTMLElement>(ATTACHMENT_CARD_SEL)) addCard(card);
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
      const { senderName, senderAddress, uncertain } = findSender(doc, container, hostEl);
      const subject = findSubject(doc, container);
      const body = withSubject(subject, bodyText(container));
      const linkInfo = linkFields(container); // unwraps Safe Links and other redirect wrappers
      const { attachments, attachmentContainers } = extractOutlookAttachments(doc, container, hostEl);
      return {
        senderName,
        senderAddress,
        ...(uncertain ? { pairingUncertain: true } : {}),
        body,
        ...linkInfo,
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
