export type AttachmentRiskLevel = 'none' | 'locked' | 'warning' | 'danger';

export interface AttachmentAnalysis {
  count: number;
  names: string[];
  level: AttachmentRiskLevel;
  reasons: string[];
}

/** Names (and reasons) kept for display and for the iCloud frame relay's per-message summary. */
export const MAX_ATTACHMENT_NAMES = 50;
/** Names classified per email: every attachment the adapters collect (MAX_ATTACHMENTS in adapters/extract.ts). */
export const MAX_CLASSIFIED_ATTACHMENTS = 500;

import { ellipsizeMiddle, hasBidiControls, showable } from './text';

const HTML_SVG_EXTS = new Set(['html', 'htm', 'shtml', 'xhtml', 'xht', 'svg', 'svgz', 'mht', 'mhtml']);

const EXEC_EXTS = new Set([
  'exe', 'msi', 'dmg', 'pkg', 'apk', 'iso', 'img', 'lnk', 'scr', 'bat', 'cmd', 'ps1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'com', 'pif', 'reg', 'cpl',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'xlam', 'ppam',
  // Containers and script types abused in recent campaigns (OneNote, disk images that skip Mark-of-the-Web,
  // Excel add-ins, MMC snap-ins, shortcuts, help files, scriptlets, app installers, search/library connectors).
  'one', 'vhd', 'vhdx', 'xll', 'msc', 'url', 'chm', 'wsc', 'sct', 'inf', 'psm1', 'appx', 'msix', 'appxbundle',
  'msixbundle', 'appinstaller', 'jnlp', 'xlsb', 'library-ms', 'search-ms', 'settingcontent-ms', 'application',
  // Rogue RDP connection files, macro slideshows/slides/add-ins, Windows Search connectors, Excel web query and
  // SYLK files, troubleshooting packs, installer patches/updates, shell command files, PowerShell/Monad scripts and
  // type files, ClickOnce references, and libraries for side-loading.
  'rdp', 'ppsm', 'sldm', 'xla', 'searchconnector-ms', 'iqy', 'slk', 'diagcab', 'msp', 'msu', 'scf', 'ps1xml',
  'msh', 'appref-ms', 'dll',
]);

const DANGEROUS_EXTS = new Set([...HTML_SVG_EXTS, ...EXEC_EXTS]);

/**
 * File types a clicked link must not download directly: the attachment danger list minus plain web pages
 * (.html/.htm are normal link targets), .com (ambiguous in URL paths) and .dll (IIS ISAPI web apps are served as
 * /app.dll?...). Shared with linkGuard so they can't drift.
 */
export const RISKY_DOWNLOAD_EXTS: ReadonlySet<string> = new Set(
  [...DANGEROUS_EXTS].filter((e) => !['html', 'htm', 'shtml', 'xhtml', 'xht', 'com', 'dll'].includes(e)),
);

/** Archive types: a warning as an attachment, and a warning (not danger) when a clicked link downloads one. */
export const ARCHIVE_EXTS: ReadonlySet<string> = new Set([
  'zip', 'zipx', 'rar', 'r00', '001', '7z', 'tar', 'gz', 'tgz', 'cab', 'xz', 'bz2', 'arj', 'lzh', 'ace', 'uue',
]);
const EXT = '([a-z0-9-]{1,20})';
const SINGLE_EXT_RE = new RegExp(`\\.${EXT}$`, 'i');
const DOUBLE_EXT_RE = new RegExp(`\\.${EXT}\\.${EXT}$`, 'i');
const MAX_NAME_CHARS = 1024; // classify the real (untruncated) name, bounded so matching stays cheap

const PREFIX_RE =
  /^(?:attached\s+file|attachment|download\s+attachment|open\s+attachment|save\s+to\s+drive|download|preview)(?:\s*:\s*|\s+|$)/i;

/** Normalize a raw webmail attachment label/tooltip into a clean filename, or '' if empty. */
export function cleanAttachmentName(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  for (let i = 0; i < 2; i++) {
    const next = s.replace(PREFIX_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  s = s
    .replace(/\s*\(\s*\d+(?:[.,]\d+)?\s*(?:bytes?|kb|mb|gb)\s*\)\s*$/i, '')
    .replace(/,\s*\d+(?:[.,]\d+)?\s*(?:bytes?|kb|mb|gb)\s*$/i, '')
    .trim();
  // Keep the end: a name padded past any display limit must not lose the extension the danger check reads.
  return s.length > MAX_NAME_CHARS ? s.slice(-MAX_NAME_CHARS) : s;
}

/** Locally classify attachment filenames from an untrusted email; zero file contents touched. */
export function analyzeAttachments(names: readonly string[], rawCount = 0): AttachmentAnalysis {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const cleaned = cleanAttachmentName(raw);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(cleaned);
    if (uniqueNames.length >= MAX_CLASSIFIED_ATTACHMENTS) break;
  }

  const count = Math.max(uniqueNames.length, rawCount);
  if (count === 0) return { count: 0, names: [], level: 'none', reasons: [] };

  // Every collected name is classified (a dangerous file after 50 photos still counts); only the reasons and names
  // kept for display are bounded, with the danger reasons first.
  const dangerReasons: string[] = [];
  const warningReasons: string[] = [];
  const danger = (r: string) => {
    if (dangerReasons.length < MAX_ATTACHMENT_NAMES) dangerReasons.push(r);
  };

  for (const name of uniqueNames) {
    const shown = () => showable(ellipsizeMiddle(name));
    if (hasBidiControls(name)) {
      danger(`Attachment "${shown()}" hides its real file type with invisible text-direction characters`);
      continue;
    }
    const trimmed = name.replace(/[. ]+$/, '');
    const dbl = trimmed.match(DOUBLE_EXT_RE);
    if (dbl) {
      const ext = dbl[2]!.toLowerCase();
      if (DANGEROUS_EXTS.has(ext)) {
        danger(`Attachment "${shown()}" uses a disguised double extension (.${ext}) commonly used in phishing or malware`);
        continue;
      }
    }

    const ext = trimmed.match(SINGLE_EXT_RE)?.[1]?.toLowerCase() ?? '';
    if (!ext) continue;
    if (HTML_SVG_EXTS.has(ext)) {
      danger(`Attachment "${shown()}" is an HTML/SVG web file (.${ext}) commonly used for offline phishing pages`);
    } else if (EXEC_EXTS.has(ext)) {
      danger(`Attachment "${shown()}" is a high-risk file type (.${ext}) that can run code or carry malware`);
    } else if (ARCHIVE_EXTS.has(ext) && warningReasons.length < MAX_ATTACHMENT_NAMES) {
      warningReasons.push(
        `Attachment "${shown()}" is an archive (.${ext}) — archives are commonly used to hide phishing pages or malware`,
      );
    }
  }

  const hasDanger = dangerReasons.length > 0;
  const hasWarning = warningReasons.length > 0;
  const deduped = [...new Set([...dangerReasons, ...warningReasons])].slice(0, MAX_ATTACHMENT_NAMES);
  const shownNames = uniqueNames.slice(0, MAX_ATTACHMENT_NAMES);
  if (deduped.length === 0) {
    const shown =
      uniqueNames.length > 0
        ? ` (${uniqueNames
            .slice(0, 2)
            .map((n) => showable(ellipsizeMiddle(n, 80)))
            .join(', ')}${uniqueNames.length > 2 ? ` +${uniqueNames.length - 2} more` : ''})`
        : '';
    return {
      count,
      names: shownNames,
      level: 'locked',
      reasons: [`Attachments from untrusted emails are blocked until you trust this email or sender${shown}`],
    };
  }

  return {
    count,
    names: shownNames,
    level: hasDanger ? 'danger' : hasWarning ? 'warning' : 'locked',
    reasons: deduped,
  };
}
