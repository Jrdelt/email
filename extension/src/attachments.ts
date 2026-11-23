export type AttachmentRiskLevel = 'none' | 'locked' | 'warning' | 'danger';

export interface AttachmentAnalysis {
  count: number;
  names: string[];
  level: AttachmentRiskLevel;
  reasons: string[];
}

const MAX_ATTACHMENT_NAMES = 50;

const HTML_SVG_EXTS = new Set(['html', 'htm', 'shtml', 'xhtml', 'svg', 'mht', 'mhtml']);

const EXEC_EXTS = new Set([
  'exe', 'msi', 'dmg', 'pkg', 'apk', 'iso', 'img', 'lnk', 'scr', 'bat', 'cmd', 'ps1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'com', 'pif', 'reg', 'cpl',
  'docm', 'xlsm', 'pptm', 'dotm', 'xltm', 'potm', 'xlam', 'ppam',
]);

const DANGEROUS_EXTS = new Set([...HTML_SVG_EXTS, ...EXEC_EXTS]);

const ARCHIVE_EXTS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'cab', 'xz', 'bz2']);

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
  return s.slice(0, 160);
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
    if (uniqueNames.length >= MAX_ATTACHMENT_NAMES) break;
  }

  const count = Math.max(uniqueNames.length, rawCount);
  if (count === 0) return { count: 0, names: [], level: 'none', reasons: [] };

  let hasDanger = false;
  let hasWarning = false;
  const reasons: string[] = [];

  for (const name of uniqueNames) {
    const trimmed = name.replace(/[. ]+$/, '');
    const dbl = trimmed.match(/\.([a-z0-9]{2,5})\.([a-z0-9]{2,5})$/i);
    if (dbl) {
      const ext = dbl[2].toLowerCase();
      if (DANGEROUS_EXTS.has(ext)) {
        hasDanger = true;
        reasons.push(
          `Attachment "${name}" uses a disguised double extension (.${ext}) commonly used in phishing or malware`,
        );
        continue;
      }
    }

    const ext = trimmed.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ?? '';
    if (!ext) continue;
    if (HTML_SVG_EXTS.has(ext)) {
      hasDanger = true;
      reasons.push(`Attachment "${name}" is an HTML/SVG web file (.${ext}) commonly used for offline phishing pages`);
    } else if (EXEC_EXTS.has(ext)) {
      hasDanger = true;
      reasons.push(`Attachment "${name}" is a high-risk file type (.${ext}) that can run code or carry malware`);
    } else if (ARCHIVE_EXTS.has(ext)) {
      hasWarning = true;
      reasons.push(
        `Attachment "${name}" is an archive (.${ext}) — archives are commonly used to hide phishing pages or malware`,
      );
    }
  }

  const deduped = [...new Set(reasons)];
  if (deduped.length === 0) {
    const shown =
      uniqueNames.length > 0
        ? ` (${uniqueNames.slice(0, 2).join(', ')}${uniqueNames.length > 2 ? ` +${uniqueNames.length - 2} more` : ''})`
        : '';
    return {
      count,
      names: uniqueNames,
      level: 'locked',
      reasons: [`Attachments from untrusted emails are blocked until you trust this email or sender${shown}`],
    };
  }

  return {
    count,
    names: uniqueNames,
    level: hasDanger ? 'danger' : hasWarning ? 'warning' : 'locked',
    reasons: deduped,
  };
}
