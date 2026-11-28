import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS } from './adapters/extract';
import { analyzeAttachments, cleanAttachmentName, MAX_ATTACHMENT_NAMES, MAX_CLASSIFIED_ATTACHMENTS } from './attachments';
import { ellipsizeMiddle } from './text';

describe('cleanAttachmentName', () => {
  it('strips webmail action prefixes and trailing file sizes', () => {
    expect(cleanAttachmentName('  Download attachment   invoice.pdf, 45 KB  ')).toBe('invoice.pdf');
    expect(cleanAttachmentName('Attached file: report_2026.html (1.2 MB)')).toBe('report_2026.html');
    expect(cleanAttachmentName('Preview: doc.svg')).toBe('doc.svg');
    expect(cleanAttachmentName('Save to Drive: archive.zip')).toBe('archive.zip');
    expect(cleanAttachmentName('Download')).toBe('');
    expect(cleanAttachmentName('Download attachment')).toBe('');
  });
});

describe('analyzeAttachments', () => {
  it('returns none when rawCount is 0 and names are empty', () => {
    expect(analyzeAttachments([])).toEqual({ count: 0, names: [], level: 'none', reasons: [] });
    expect(analyzeAttachments(['', 'Download'], 0)).toEqual({ count: 0, names: [], level: 'none', reasons: [] });
  });

  it('flags HTML/SVG smuggling attachments as danger', () => {
    for (const file of ['secure-login.html', 'invoice.htm', 'notice.xhtml', 'qr.svg', 'mail.mhtml']) {
      const res = analyzeAttachments([file]);
      expect(res.level).toBe('danger');
      expect(res.reasons[0]).toMatch(/HTML\/SVG web file/i);
    }
  });

  it('flags executables, scripts, installers, disk images, and macro Office files as danger', () => {
    for (const file of ['setup.exe', 'patch.dmg', 'disk.iso', 'shortcut.lnk', 'run.ps1', 'macro.xlsm', 'app.apk']) {
      const res = analyzeAttachments([file]);
      expect(res.level).toBe('danger');
      expect(res.reasons[0]).toMatch(/high-risk file type/i);
    }
  });

  it('flags disguised double extensions as danger', () => {
    const res = analyzeAttachments(['invoice.pdf.html', 'receipt.jpg.exe']);
    expect(res.level).toBe('danger');
    expect(res.count).toBe(2);
    expect(res.reasons).toHaveLength(2);
    expect(res.reasons[0]).toMatch(/disguised double extension \(\.html\)/i);
    expect(res.reasons[1]).toMatch(/disguised double extension \(\.exe\)/i);
  });

  it('flags archive formats as warning', () => {
    for (const file of ['documents.zip', 'bundle.rar', 'backup.7z', 'files.tgz']) {
      const res = analyzeAttachments([file]);
      expect(res.level).toBe('warning');
      expect(res.reasons[0]).toMatch(/archive/i);
    }
  });

  it('locks safe/unknown or unnamed attachments when email is untrusted', () => {
    const named = analyzeAttachments(['statement.pdf', 'receipt.png', 'notes.docx']);
    expect(named.level).toBe('locked');
    expect(named.count).toBe(3);
    expect(named.names).toEqual(['statement.pdf', 'receipt.png', 'notes.docx']);
    expect(named.reasons[0]).toContain('Attachments from untrusted emails are blocked');
    expect(named.reasons[0]).toContain('(statement.pdf, receipt.png +1 more)');

    const unnamed = analyzeAttachments([], 2);
    expect(unnamed.level).toBe('locked');
    expect(unnamed.count).toBe(2);
    expect(unnamed.names).toEqual([]);
    expect(unnamed.reasons[0]).toBe('Attachments from untrusted emails are blocked until you trust this email or sender');
  });

  it('escalates to danger when mixing benign and dangerous attachments', () => {
    const res = analyzeAttachments(['statement.pdf', 'verify.html', 'archive.zip']);
    expect(res.level).toBe('danger');
    expect(res.count).toBe(3);
    expect(res.reasons).toHaveLength(2);
  });
});

describe('attachment classification hardening', () => {
  it('classifies the real extension of very long names and shows them shortened', () => {
    const name = `Remittance_Advice_${'x'.repeat(170)}.html`;
    const a = analyzeAttachments([name]);
    expect(a.level).toBe('danger');
    expect(a.reasons[0]!.length).toBeLessThan(300);
    expect(a.reasons[0]).toContain('.html');
  });

  it('flags commonly abused container and script types', () => {
    for (const n of ['invoice.one', 'scan.vhd', 'addin.xll', 'console.msc', 'update.appinstaller', 'q.search-ms']) {
      expect(analyzeAttachments([n]).level).toBe('danger');
    }
    expect(analyzeAttachments(['photos.zipx']).level).toBe('warning');
  });

  it('treats right-to-left override names as dangerous and keeps them from reordering the sentence', () => {
    const a = analyzeAttachments(['invoice‮fdp.exe']);
    expect(a.level).toBe('danger');
    expect(a.reasons.join(' ')).not.toMatch(/[‪-‮⁦-⁩]/);
  });
});

describe('current attack file types and long attachment lists', () => {
  it('flags rogue RDP files, macro slideshows, search connectors, Excel web queries and other code-running types', () => {
    for (const ext of [
      'rdp', 'ppsm', 'sldm', 'searchConnector-ms', 'iqy', 'slk', 'diagcab', 'msp', 'scf', 'xla', 'ps1xml', 'msh',
      'dll', 'appref-ms', 'msu',
    ]) {
      const a = analyzeAttachments([`Q3.${ext}`]);
      expect(a.level, ext).toBe('danger');
      expect(a.reasons[0]).toMatch(/high-risk file type/);
    }
  });

  it('classifies a dangerous file listed after 50 harmless ones, but shows at most 50 names', () => {
    const photos = Array.from({ length: 60 }, (_, i) => `IMG_${i}.jpg`);
    for (const late of ['invoice.html', 'Q3.rdp']) {
      const a = analyzeAttachments([...photos, late]);
      expect(a.level, late).toBe('danger');
      expect(a.count).toBe(61);
      expect(a.names).toHaveLength(MAX_ATTACHMENT_NAMES);
      expect(a.reasons.join(' ')).toContain(late);
    }
  });

  it('lists the danger reasons first and keeps the reason list bounded', () => {
    const many = [...Array.from({ length: 80 }, (_, i) => `backup_${i}.zip`), 'payload.exe'];
    const a = analyzeAttachments(many);
    expect(a.level).toBe('danger');
    expect(a.reasons[0]).toContain('payload.exe');
    expect(a.reasons.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NAMES);
  });

  it('classifies as many names as the adapters collect', () => {
    expect(MAX_CLASSIFIED_ATTACHMENTS).toBe(MAX_ATTACHMENTS);
  });
});

describe('bidi marks in ordinary right-to-left filenames', () => {
  it('classifies by the real extension when a name has only direction marks, but flags reordering controls', () => {
    const rtl = analyzeAttachments(['דוח‏.pdf', 'تقرير؜.docx', 'report‎.pdf']);
    expect(rtl.level).not.toBe('danger');
    expect(analyzeAttachments(['invoice‮fdp.exe']).level).toBe('danger');
    expect(analyzeAttachments(['invoice⁧fdp.exe']).level).toBe('danger');
  });
});

describe('ellipsizeMiddle', () => {
  it('never splits a surrogate pair', () => {
    const s = `${'a'.repeat(79)}\u{1d400}${'b'.repeat(200)}\u{1f600}${'c'.repeat(78)}`;
    const out = ellipsizeMiddle(s, 160);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
