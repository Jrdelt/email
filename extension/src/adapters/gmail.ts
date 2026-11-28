import { cleanAttachmentName } from '../attachments';
import { KNOWN_ESP_DOMAINS } from '../brands';
import { isValidDomain, registrableDomain } from '../domain';
import { closestEl } from '../dom';
import {
  ADDRESS_TOKEN_RE,
  MAX_ATTACHMENTS,
  MAX_HEADER_CHARS,
  capText,
  bodyText,
  withSubject,
  inlineAttachmentsIn,
  isHidden,
  isUnsafeNode,
  linkFields,
} from './extract';
import type { AttachmentRef, ExtractedEmail, WebmailAdapter } from './types';

const extractEmailText = (raw: string): string => capText(raw, MAX_HEADER_CHARS).match(ADDRESS_TOKEN_RE)?.[0]?.trim() ?? '';

const cleanHost = (raw: string): string =>
  raw.trim().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '').toLowerCase();

const DISPLAY_NAME_SEL = 'span.gD:not(.go), [name]';
const VIA_LABEL_RE = /^via\s+([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/i;

function extractViaDomain(scope: Document | HTMLElement, container: HTMLElement): string | undefined {
  for (const anchor of scope.querySelectorAll<HTMLElement>('a.acP, a[href*="support.google.com/mail/answer/1311182"]')) {
    if (container.contains(anchor)) continue;
    const sib = cleanHost(anchor.parentElement?.nextElementSibling?.textContent ?? '');
    if (sib && isValidDomain(sib)) return sib;
    const afterVia = (anchor.parentElement?.textContent ?? '').match(/\bvia\s+([^\s,;()]+)/i)?.[1] ?? '';
    const candidate = cleanHost(afterVia);
    if (candidate && isValidDomain(candidate)) return candidate;
  }
  // Only Gmail's own "via <relay>" label counts: never h3.iw as a whole or the display-name chip, whose text
  // the sender controls ("Boss via sendgrid.net" must not hide the real relay).
  const candidates: string[] = [];
  for (const el of scope.querySelectorAll<HTMLElement>('span.go')) {
    if (container.contains(el) || el.closest(DISPLAY_NAME_SEL) || el.querySelector(DISPLAY_NAME_SEL)) continue;
    const m = (el.textContent ?? '').trim().match(VIA_LABEL_RE);
    const candidate = cleanHost(m?.[1] ?? '');
    if (candidate && isValidDomain(candidate) && !candidates.includes(candidate)) candidates.push(candidate);
  }
  // More than one relay label means one is spoofed: fail closed by reporting a non-ESP relay if there is one.
  return candidates.find((c) => !KNOWN_ESP_DOMAINS.has(registrableDomain(c))) ?? candidates[0];
}

function isUnauthenticated(scope: Document | HTMLElement, container: HTMLElement): boolean {
  const unauthRe = /couldn['’]t verify|could not verify/i;
  for (const el of scope.querySelectorAll<HTMLElement>('[aria-label], [data-tooltip], [title], img[alt]')) {
    if (container.contains(el)) continue;
    const text = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''} ${el.getAttribute('title') ?? ''} ${el.getAttribute('alt') ?? ''}`;
    if (unauthRe.test(text)) return true;
  }
  for (const el of scope.querySelectorAll<HTMLElement>('.gE')) {
    if (!container.contains(el) && /gmail couldn['’]t verify/i.test(el.textContent ?? '')) return true;
  }
  return false;
}

function nameFromDownloadUrl(raw: string): string {
  if (!raw) return '';
  const firstColon = raw.indexOf(':');
  if (firstColon === -1) return '';
  const urlStart = raw.search(/:https?:\/\//i);
  const encoded = urlStart > firstColon ? raw.slice(firstColon + 1, urlStart) : raw.slice(firstColon + 1).split(':')[0];
  try {
    return cleanAttachmentName(decodeURIComponent(encoded));
  } catch {
    return cleanAttachmentName(encoded);
  }
}

function isGmailBulkAction(el: Element): boolean {
  const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-tooltip') ?? ''} ${el.getAttribute('title') ?? ''}`;
  return /\b(?:download\s+all|save\s+all\s+to\s+drive|add\s+all\s+to\s+drive)\b/i.test(label);
}

function gmailChipName(chip: HTMLElement): string {
  const dlUrl = chip.getAttribute('download_url') ?? chip.getAttribute('data-ped-att-download-url') ?? '';
  const fromUrl = nameFromDownloadUrl(dlUrl);
  if (fromUrl) return fromUrl;

  const v3 = cleanAttachmentName(chip.querySelector('.aV3')?.textContent ?? '');
  if (v3) return v3;

  const dl = cleanAttachmentName(chip.getAttribute('download') ?? chip.getAttribute('data-ped-att-download') ?? '');
  if (dl) return dl;

  for (const attr of ['aria-label', 'title', 'data-tooltip'] as const) {
    const candidate = cleanAttachmentName(chip.getAttribute(attr) ?? '');
    if (candidate) return candidate;
  }

  const text = (chip.textContent ?? '').trim();
  return text.length <= 180 ? cleanAttachmentName(text) : '';
}

// Gmail's attachment URLs carry the exact query parameter view=att (not view=attendees or preview=att).
const VIEW_ATT_SEL = (attr: string): string[] => [
  `a[${attr}*="?view=att&"]`,
  `a[${attr}*="&view=att&"]`,
  `a[${attr}$="?view=att"]`,
  `a[${attr}$="&view=att"]`,
];

function extractGmailAttachments(
  scope: Document | HTMLElement | null,
  container: HTMLElement,
): { attachments: AttachmentRef[]; attachmentContainers: HTMLElement[] } {
  const attachments: AttachmentRef[] = [...inlineAttachmentsIn(container)];
  const inlineCount = attachments.length; // the chip cap below counts this adapter's own chips only
  const shelves: HTMLElement[] = [];
  const attachmentContainers: HTMLElement[] = [];

  if (!scope) return { attachments, attachmentContainers };

  // Shelves and chips are Gmail chrome beside the body, never inside it: in the email HTML, class="hq" or a
  // ?view=att link is not an attachment (inline downloads come from inlineAttachmentsIn).
  const shouldSkip = (el: Element): boolean =>
    isUnsafeNode(el) ||
    container.contains(el) ||
    el.contains(container) ||
    (el instanceof HTMLElement && isHidden(el)) ||
    el.closest('div.M9, [role="dialog"], [contenteditable="true"]') !== null;

  for (const shelf of scope.querySelectorAll<HTMLElement>('div.aQH, .hq')) {
    if (shouldSkip(shelf) || shelves.some((prev) => prev.contains(shelf))) continue;
    shelves.push(shelf);
    attachmentContainers.push(shelf);
  }

  const chipSel = [
    'span.aZo',
    '[download_url]',
    '[data-ped-att-download-url]',
    'a[download]',
    'a[data-ped-att-download]',
    'a[href*="mail-attachment.googleusercontent.com"]',
    'a[data-ped-att-href*="mail-attachment.googleusercontent.com"]',
    ...VIEW_ATT_SEL('href'),
    ...VIEW_ATT_SEL('data-ped-att-href'),
  ].join(', ');

  for (const chip of scope.querySelectorAll<HTMLElement>(chipSel)) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (shouldSkip(chip) || isGmailBulkAction(chip)) continue;
    if (attachments.some((prev) => prev.element === chip || prev.element.contains(chip))) continue;
    attachments.push({ name: gmailChipName(chip), element: chip });
  }

  const bulkSel =
    '[aria-label*="Download all" i], [data-tooltip*="Download all" i], [aria-label*="Save all to Drive" i], [data-tooltip*="Add all to Drive" i]';
  for (const btn of scope.querySelectorAll<HTMLElement>(bulkSel)) {
    if (shouldSkip(btn) || attachmentContainers.some((c) => c === btn || c.contains(btn))) continue;
    attachmentContainers.push(btn);
  }

  for (const shelf of shelves) {
    if (attachments.length - inlineCount >= MAX_ATTACHMENTS) break;
    if (!attachments.some((a) => shelf.contains(a.element) || a.element === shelf)) {
      attachments.push({ name: '', element: shelf });
    }
  }

  return { attachments, attachmentContainers };
}

// Best-effort Gmail selectors (T7: verify against saved fixtures and live Gmail).
// div.a3s = message body; span.gD[email] = standard sender chip; span.go.gD = Spam/via bare address; h2.hP = subject.
// Inbox/list rows (not an opened conversation). Their file buttons are recognised by Gmail's attachment endpoints
// (attid= / view=att), drag-to-download attributes and the list's chip containers. Matching a non-file button here only
// asks the user to open the email first; missing one leaves the pre-existing gap, so the selectors err wide.
const LIST_ROW_SEL = 'tr.zA, [role="main"] [role="row"]';
const LIST_FILE_SEL = [
  'a[href*="attid="]',
  'a[href*="view=att"]',
  'a[href*="mail-attachment.googleusercontent.com"]',
  'a[download]',
  'a[href^="blob:"]',
  'a[href^="data:"]',
  '[download_url]',
  // The chips themselves (icon and padding included) and controls in the chip strip, but never the strip
  // container itself, which may be a wider wrapper on real Gmail.
  '.brc',
  '.brg',
  '.brd [role="link"]',
  '.brd [role="button"]',
  '.brd a',
].join(', ');
// Anything the adapter treats as an opened message (and its attachment shelf) is handled by the normal locks.
const OPENED_EMAIL_SEL = 'div.adn, div.a3s, [role="listitem"], div.hq, div.aQH, [role="dialog"]';

// UI languages whose verification labels the adapter reads (isUnauthenticated, VIA_LABEL_RE are English). In any
// other language Gmail's localized "couldn't verify" badge is invisible to it, so a forged copy of a trusted address
// would look verified: report no auth signals there (fail closed). Gmail sets <html lang> to its UI language; a
// missing lang counts as unreadable.
const READABLE_LANG_RE = /^en(?:-|$)/i;

export const gmail: WebmailAdapter = {
  name: 'gmail',
  authSignals: (doc) => READABLE_LANG_RE.test((doc.documentElement?.getAttribute('lang') ?? '').trim()),
  listAttachmentAt(el: Element): HTMLElement | null {
    const chip = closestEl(el, LIST_FILE_SEL);
    if (!chip || !closestEl(chip, LIST_ROW_SEL) || closestEl(chip, OPENED_EMAIL_SEL)) return null;
    return chip as HTMLElement;
  },
  matches: (url) => url.hostname === 'mail.google.com',
  extractAll(doc): ExtractedEmail[] {
    const containers = [...doc.querySelectorAll<HTMLElement>('div.a3s')].filter(
      (el) => !isHidden(el) && el.parentElement?.closest('div.a3s') === null,
    );
    const subject = (doc.querySelector<HTMLElement>('h2.hP')?.textContent ?? '').trim();
    return containers.map((container) => {
      const msg = container.closest<HTMLElement>('.adn, [role="listitem"]');
      const scope = msg ?? (containers.length === 1 ? doc : null);
      // Sender chips are Gmail's header markup: never one written into a message body (this one or any other
      // div.a3s), whose HTML the sender controls. Without a card, the last chip outside every body wins.
      const inBody = (el: Element): boolean => container.contains(el) || closestEl(el, 'div.a3s') !== null;
      const headerChips = (root: Document | HTMLElement): HTMLElement[] =>
        [...root.querySelectorAll<HTMLElement>('span.gD[email]')].filter((el) => !inBody(el));
      const emailChip =
        (msg ? headerChips(msg)[0] : undefined) ?? (containers.length === 1 ? headerChips(doc).pop() : undefined);

      let senderAddress = emailChip?.getAttribute('email')?.trim() ?? '';
      if (!senderAddress && scope) {
        // Gmail's own address chips only, in priority order: never h3.iw or the display-name chip, whose text
        // the sender controls ("service@paypal.com via sendgrid.net").
        for (const sel of ['span.go.gD', 'span.go']) {
          for (const el of scope.querySelectorAll<HTMLElement>(sel)) {
            if (inBody(el) || el.closest(DISPLAY_NAME_SEL)) continue;
            senderAddress = extractEmailText(el.textContent ?? '');
            if (senderAddress) break;
          }
          if (senderAddress) break;
        }
      }

      let senderName = emailChip?.getAttribute('name')?.trim() ?? '';
      if (!senderName && emailChip) {
        const t = (emailChip.textContent ?? '').trim();
        if (t && !t.includes('@')) senderName = t;
      }
      if (!senderName && scope) {
        for (const el of scope.querySelectorAll<HTMLElement>('span.gD')) {
          if (inBody(el)) continue;
          const t = (el.textContent ?? '').trim();
          if (t && !t.includes('@')) {
            senderName = t;
            break;
          }
        }
      }

      const viaDomain = scope ? extractViaDomain(scope, container) : undefined;
      const unauthenticated = scope ? isUnauthenticated(scope, container) : false;
      const { attachments, attachmentContainers } = extractGmailAttachments(scope, container);
      const body = withSubject(subject, bodyText(container));
      return {
        senderName,
        senderAddress,
        ...(viaDomain ? { viaDomain } : {}),
        ...(unauthenticated ? { unauthenticated: true } : {}),
        body,
        ...linkFields(container),
        ...(attachments.length ? { attachments } : {}),
        ...(attachmentContainers.length ? { attachmentContainers } : {}),
        container,
      };
    });
  },
  extract(doc) {
    const all = gmail.extractAll!(doc);
    return all[all.length - 1] ?? null;
  },
};
