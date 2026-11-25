import { cleanAttachmentName } from '../attachments';
import type { Link } from '../features';
import { type ICloudFrameRole, icloudFrameRole } from '../hosts';
import {
  MAX_ATTACHMENTS,
  bodyText,
  withSubject,
  extractSenderFromElement,
  inlineAttachmentsIn,
  isHidden,
  isUnsafeNode,
  linksIn,
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';


export interface ICloudHeader {
  id: string;
  senderName: string;
  senderAddress: string;
  subject: string;
  iframeCount: number;
  /** The card's message-body iframes, used to pair the card with its sandbox frame by frame id. */
  iframes?: HTMLIFrameElement[];
  attachments: AttachmentRef[];
  attachmentContainers: HTMLElement[];
  container: HTMLElement;
}

export interface ICloudSandboxPayload {
  body: string;
  links: Link[];
  attachmentNames?: string[];
}

export interface ICloudThreadMessage {
  senderName: string;
  senderAddress: string;
  body: string;
  links: Link[];
  attachments?: AttachmentRef[];
  attachmentContainers?: HTMLElement[];
  attachmentNames?: string[];
  frameId?: number;
}

function isRecipientNode(el: Element): boolean {
  if (el.closest('[aria-label^="To" i], [aria-label^="Cc" i], [aria-label^="Bcc" i], [data-testid*="recipient" i]')) {
    return true;
  }
  // A contact token's text is the sender's display name ("Cc: Bank Alerts"), so text that starts with the
  // token's own text is not a recipient label.
  const token = el.closest('span.contact-token');
  const tokenText = token ? (token.textContent ?? '').trim() : '';
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.matches('.conversation-list-item, .allow-select')) break;
    const label = cur.getAttribute('aria-label') ?? '';
    if (/^(to|cc|bcc|reply-to)\b/i.test(label)) return true;
    const text = (cur.textContent ?? '').trim();
    const fromToken = tokenText !== '' && text.startsWith(tokenText);
    if (!fromToken && /^(to|cc|bcc|reply-to)\s*:/i.test(text) && !/\bfrom\s*:/i.test(text)) return true;
  }
  return false;
}

function extractHeaderSender(card: HTMLElement): { senderName: string; senderAddress: string } {
  const skip = (el: Element): boolean => isUnsafeNode(el) || el.closest('iframe, h2') !== null || isRecipientNode(el);

  let fallbackName = '';

  // Pass 1: primary span.contact-token (always present in collapsed and expanded states)
  for (const token of card.querySelectorAll<HTMLElement>('span.contact-token')) {
    if (isHidden(token) || skip(token)) continue;
    const text = (token.textContent ?? '').trim();
    if (!fallbackName && text && !text.includes('@')) fallbackName = text;
    // The token's text is the display name: only its structured attributes may supply the address.
    const hit = extractSenderFromElement(token, fallbackName, { text: false });
    if (hit) return hit;
    if (!fallbackName && text && !text.includes('@')) fallbackName = text;
    break;
  }

  // Pass 2a: explicit From / sender nodes
  for (const el of card.querySelectorAll('[aria-label^="From" i], [data-testid*="sender" i], [data-testid*="from" i]')) {
    if (skip(el)) continue;
    const direct = extractSenderFromElement(el, fallbackName);
    if (direct) return { senderName: direct.senderName || fallbackName, senderAddress: direct.senderAddress };
    for (const d of el.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
      if (skip(d)) continue;
      const hit = extractSenderFromElement(d, fallbackName);
      if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
    }
  }

  // Pass 2b: expanded "Details" header (.allow-select rows)
  for (const box of card.querySelectorAll<HTMLElement>('.allow-select')) {
    if (isHidden(box)) continue;
    const rows = box.children.length > 0 ? [...box.children] : [box];
    let inRecipients = false;
    for (const row of rows) {
      const rowText = (row.textContent ?? '').trim();
      const rowAria = row.getAttribute('aria-label') ?? '';
      const isFromRow = /^(?:from|sender)\s*:/i.test(rowText) || /^(?:from|sender)\b/i.test(rowAria);
      const isRecipRow = /^(?:to|cc|bcc|reply-to)\s*:/i.test(rowText) || /^(?:to|cc|bcc|reply-to)\b/i.test(rowAria);
      if (isRecipRow) {
        inRecipients = true;
        continue;
      }
      if (inRecipients && !isFromRow) continue;
      for (const node of row.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
        if (skip(node)) continue;
        const hit = extractSenderFromElement(node, fallbackName);
        if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
      }
      const hit = extractSenderFromElement(row, fallbackName);
      if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
    }
  }

  // Pass 2c: fallback header links/attributes outside h2 and iframe
  for (const el of card.querySelectorAll('a[href^="mailto:"], [title*="@"], [aria-label*="@"]')) {
    if (skip(el)) continue;
    const hit = extractSenderFromElement(el, fallbackName);
    if (hit) return { senderName: hit.senderName || fallbackName, senderAddress: hit.senderAddress };
  }

  return { senderName: fallbackName, senderAddress: '' };
}

/** First candidate that still names a file after cleaning (a generic "Download" label falls through). */
const firstCleanName = (candidates: readonly (string | null | undefined)[]): string => {
  for (const c of candidates) {
    const name = cleanAttachmentName(c ?? '');
    if (name) return name;
  }
  return '';
};

function extractICloudCardAttachments(card: HTMLElement): {
  attachments: AttachmentRef[];
  attachmentContainers: HTMLElement[];
} {
  const attachments: AttachmentRef[] = [];
  const attachmentContainers: HTMLElement[] = [];
  const itemSel =
    '[class*="attachment" i], [aria-label*="attachment" i], [aria-label*="Download" i], [title*="Download" i], a[download], a[data-ped-att-download]';
  const childSel = '[aria-label*="Download" i], [title*="Download" i], a[download], a[data-ped-att-download], [role="button"], button, a';

  const skip = (el: HTMLElement): boolean => {
    if (isUnsafeNode(el) || isHidden(el)) return true;
    if (el.closest('iframe, h2, span.contact-token, .allow-select, [contenteditable="true"]') !== null) return true;
    if (el.querySelector('iframe, h2, .allow-select') !== null) return true;
    const lbl = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
    return /^(?:attach|insert)\b/i.test(lbl);
  };

  for (const el of card.querySelectorAll<HTMLElement>(itemSel)) {
    if (skip(el)) continue;
    const lbl = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''} ${el.textContent ?? ''}`;
    if (/\bdownload\s+all\b/i.test(lbl)) {
      if (!attachmentContainers.some((c) => c === el || c.contains(el))) attachmentContainers.push(el);
      continue;
    }
    const innerButtons = el.querySelectorAll<HTMLElement>(childSel);
    if (innerButtons.length > 0 && /attachment/i.test(el.className)) {
      if (!attachmentContainers.some((c) => c === el || c.contains(el))) attachmentContainers.push(el);
      for (const btn of innerButtons) {
        if (attachments.length >= MAX_ATTACHMENTS || skip(btn)) continue;
        if (attachments.some((prev) => prev.element === btn || prev.element.contains(btn))) continue;
        const name = firstCleanName([
          btn.getAttribute('download'),
          btn.getAttribute('data-ped-att-download'),
          btn.getAttribute('aria-label'),
          btn.getAttribute('title'),
          btn.textContent,
        ]);
        attachments.push({ name, element: btn });
      }
      continue;
    }
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (attachments.some((prev) => prev.element === el || prev.element.contains(el))) continue;
    const name = firstCleanName([
      el.getAttribute('download'),
      el.getAttribute('data-ped-att-download'),
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.textContent,
    ]);
    attachments.push({ name, element: el });
  }

  for (const box of attachmentContainers) {
    if (attachments.length >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => box.contains(a.element) || a.element === box)) {
      attachments.push({ name: '', element: box });
    }
  }

  return { attachments, attachmentContainers };
}

/** Extract header metadata for all visible message cards inside the iCloud mail2 frame. */
export function extractICloudHeaders(doc: Document): ICloudHeader[] {
  let wrappers = [...doc.querySelectorAll<HTMLElement>('div[id^="message-iframe-"]')].filter(
    (el) => !isHidden(el) && el.parentElement?.closest('div[id^="message-iframe-"]') === null,
  );
  if (wrappers.length === 0) {
    wrappers = [...doc.querySelectorAll<HTMLElement>('.pane.thread-detail-pane .conversation-list-item, .conversation-list .conversation-list-item')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('.conversation-list-item') === null,
    );
  }
  return wrappers.map((wrapper) => {
    const card = wrapper.matches('.conversation-list-item')
      ? wrapper
      : wrapper.querySelector<HTMLElement>('.conversation-list-item') ?? wrapper;
    const { senderName, senderAddress } = extractHeaderSender(card);
    const subject = (card.querySelector('h2')?.textContent ?? '').trim();
    const iframes = [...card.querySelectorAll<HTMLIFrameElement>('iframe')];
    const iframeCount = iframes.length;
    const { attachments, attachmentContainers } = extractICloudCardAttachments(card);
    return {
      id: wrapper.id || '',
      senderName,
      senderAddress,
      subject,
      iframeCount,
      iframes,
      attachments,
      attachmentContainers,
      container: card,
    };
  });
}

/** Extract body text, links, and inline attachments from an iCloud sandboxed message-body iframe document. */
export function extractICloudSandbox(
  doc: Document,
  viewport?: { width: number; height: number },
): { active: boolean; body: string; links: Link[]; attachments: AttachmentRef[]; container: HTMLElement | null } {
  const bodyEl = doc.body;
  if (!bodyEl) return { active: false, body: '', links: [], attachments: [], container: null };

  const vp = viewport ?? (doc.defaultView ? { width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight } : undefined);
  if (vp && (vp.width <= 0 || vp.height <= 0)) {
    return { active: false, body: '', links: [], attachments: [], container: null };
  }

  const body = bodyText(bodyEl);
  const links = linksIn(bodyEl);
  const attachments = inlineAttachmentsIn(bodyEl);
  const active = body.trim().length > 0 || links.length > 0 || attachments.length > 0 || bodyEl.querySelector('form') !== null;
  if (!active) return { active: false, body: '', links: [], attachments: [], container: null };
  return { active: true, body, links, attachments, container: bodyEl };
}

function threadMessage(h: ICloudHeader, frameId: number | undefined, payload: ICloudSandboxPayload | undefined): ICloudThreadMessage {
  const body = withSubject(h.subject, payload?.body ?? '');
  const attachmentNames = [...h.attachments.map((a) => a.name), ...(payload?.attachmentNames ?? [])];
  return {
    senderName: h.senderName,
    senderAddress: h.senderAddress,
    body,
    links: payload?.links ?? [],
    ...(h.attachments.length ? { attachments: h.attachments } : {}),
    ...(h.attachmentContainers.length ? { attachmentContainers: h.attachmentContainers } : {}),
    ...(attachmentNames.length ? { attachmentNames } : {}),
    frameId,
  };
}

/**
 * Pair header cards from mail2 with sandboxed body payloads. With `frameIdOf` (runtime.getFrameId on each card's
 * iframe) the pairing is exact: a body is only ever evaluated with its own card's sender, and a card whose frame
 * has not reported yet keeps that frame id so lock decisions still reach it. Without it, fall back to order.
 */
export function combineICloudThread(
  headers: ICloudHeader[],
  bodies: Map<number, ICloudSandboxPayload>,
  frameIdOf?: (iframe: HTMLIFrameElement) => number | undefined,
): ICloudThreadMessage[] {
  if (headers.length === 0) return [];
  if (frameIdOf) {
    const ids = headers.map((h) =>
      (h.iframes ?? []).map(frameIdOf).find((id): id is number => typeof id === 'number' && id >= 0),
    );
    if (ids.some((id) => id !== undefined)) {
      return headers.map((h, i) => threadMessage(h, ids[i], ids[i] === undefined ? undefined : bodies.get(ids[i]!)));
    }
  }
  const entries = [...bodies.entries()];
  const expandedIndices = headers
    .map((h, idx) => (h.iframeCount > 0 ? idx : -1))
    .filter((idx) => idx !== -1);

  // When a thread mixes collapsed cards (iframeCount === 0) with expanded cards (iframeCount > 0),
  // align sandbox iframe payloads strictly to the expanded cards rather than shifting onto collapsed headers.
  if (expandedIndices.length > 0 && expandedIndices.length === entries.length && expandedIndices.length < headers.length) {
    const entryByHeader = new Map<number, [number, ICloudSandboxPayload]>();
    expandedIndices.forEach((hIdx, i) => entryByHeader.set(hIdx, entries[i]));
    return headers.map((h, idx) => {
      const entry = entryByHeader.get(idx);
      return threadMessage(h, entry?.[0], entry?.[1]);
    });
  }

  const count = Math.max(headers.length, entries.length);
  const out: ICloudThreadMessage[] = [];
  for (let i = 0; i < count; i++) {
    const h = headers[Math.min(i, headers.length - 1)];
    const entry = entries[i];
    out.push(threadMessage(h, entry?.[0], entry?.[1]));
  }
  return out;
}

function sameOriginBody(card: HTMLElement): HTMLElement | null {
  const iframe = card.querySelector<HTMLIFrameElement>('iframe');
  if (iframe) {
    try {
      const b = iframe.contentDocument?.body;
      if (b) return b;
    } catch { /* cross-origin iframe */ }
  }
  return card.querySelector<HTMLElement>('[data-message-body]');
}

export const icloud: WebmailAdapter = {
  name: 'icloud',
  matches: (url) => icloudFrameRole(url) !== null,
  extractAll(doc): ExtractedEmail[] {
    // A sandbox document is email HTML: never read header cards (sender, subject) from it.
    let role: ICloudFrameRole = null;
    try {
      role = icloudFrameRole(new URL(doc.URL));
    } catch {
      role = null;
    }
    const headers = role === 'sandbox' ? [] : extractICloudHeaders(doc);
    if (headers.length > 0) {
      return headers.map((h) => {
        const bodyEl = sameOriginBody(h.container);
        const rawBody = bodyEl ? bodyText(bodyEl) : '';
        const body = withSubject(h.subject, rawBody);
        const links = bodyEl ? linksIn(bodyEl) : [];
        const inlineAtts = bodyEl ? inlineAttachmentsIn(bodyEl) : [];
        const attachments = [...h.attachments, ...inlineAtts];
        return {
          senderName: h.senderName,
          senderAddress: h.senderAddress,
          body,
          links,
          ...(attachments.length ? { attachments } : {}),
          ...(h.attachmentContainers.length ? { attachmentContainers: h.attachmentContainers } : {}),
          container: bodyEl ?? h.container,
        };
      });
    }
    if (doc.querySelector('iframe#early-child')) return [];
    const sb = extractICloudSandbox(doc);
    if (sb.active && sb.container) {
      return [{
        senderName: '',
        senderAddress: '',
        body: sb.body,
        links: sb.links,
        ...(sb.attachments.length ? { attachments: sb.attachments } : {}),
        container: sb.container,
      }];
    }
    return [];
  },
  extract(doc) {
    const all = icloud.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
