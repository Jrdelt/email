// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { analyzeSender } from '../sender';
import { decideBanner, removeBanner, showBanner } from './banner';
import { formatAge, formatITReport, renderITDetails, renderSimpleDetails } from './details';
import { isLocked, lockLinks, unlockLinks } from './linkLock';

const actions = () => ({ onUnlock: vi.fn(), onTrustSender: vi.fn(async () => true), onReport: vi.fn(async () => {}), onDismiss: vi.fn() });

describe('linkLock', () => {
  it('blocks clicks on links only while locked', () => {
    document.body.innerHTML = '<div id="m"><a id="l" href="https://evil.example">x</a></div><a id="o" href="https://ok.example">o</a>';
    const m = document.getElementById('m')!;
    const click = (id: string) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.getElementById(id)!.dispatchEvent(e);
      return e.defaultPrevented;
    };
    lockLinks(m);
    expect(isLocked(m)).toBe(true);
    expect(click('l')).toBe(true);
    expect(click('o')).toBe(false);
    unlockLinks(m);
    expect(click('l')).toBe(false);
  });
});

describe('banner', () => {
  it('renders once, warning level does not lock, removable', () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    showBanner({ level: 'warning', title: 'Double-check this sender', reasons: sender.warnings, linksLocked: false, sender, intel: 'loading' }, actions());
    showBanner({ level: 'warning', title: 'Double-check this sender', reasons: ['<img src=x onerror=alert(1)>'], linksLocked: false, sender }, actions());
    expect(document.querySelectorAll('#ped-banner-host')).toHaveLength(1);
    expect(document.querySelector('img')).toBeNull();
    removeBanner();
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });
});

describe('decideBanner', () => {
  const cleanIntel = {
    domain: 'mongodb.com', checkedAt: '2026-11-22T00:00:00Z',
    rdap: { status: 'ok' as const, registered: '2008-07-08T00:00:00Z' },
    dns: { status: 'ok' as const, mx: ['aspmx.l.google.com'] },
    reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: [] },
  };

  it('returns null for safe email with urgency wording and clean sender/intel', () => {
    const sender = analyzeSender('MongoDB Cloud', 'cloud-manager-support@mongodb.com', []);
    const banner = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, cleanIntel, false);
    expect(banner).toBeNull();
  });

  it('shows warning banner with sender warning first when safe verdict has sender warning', () => {
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    const banner = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, undefined, false)!;
    expect(banner.level).toBe('warning');
    expect(banner.title).toBe('Double-check this sender');
    expect(banner.linksLocked).toBe(false);
    expect(banner.reasons[0]).toMatch(/Claims to be PayPal/);
    expect(banner.reasons[1]).toBe('Uses urgent wording about passwords or your account');
  });

  it('shows danger banner and unlocks only when unlockedThisSession is true', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const verdict = { score: 0.6, level: 'likely-phishing' as const, reasons: ['A link says paypal.com but actually goes to evil.example'] };
    const locked = decideBanner(verdict, sender, undefined, false)!;
    expect(locked.level).toBe('danger');
    expect(locked.title).toBe('Possible phishing email');
    expect(locked.linksLocked).toBe(true);
    const unlocked = decideBanner(verdict, sender, undefined, true)!;
    expect(unlocked.level).toBe('danger');
    expect(unlocked.linksLocked).toBe(false);
  });
});

describe('formatAge', () => {
  it.each([
    [undefined, ''],
    [0, 'created today'],
    [1, '1 day old'],
    [12, '12 days old'],
    [40, '40 days old'],
    [90, '3 months old'],
    [365, '1 year old'],
    [8585, '23 years old'],
  ])('%s -> %s', (days, expected) => expect(formatAge(days)).toBe(expected));
});

describe('details', () => {
  const sampleIntel = {
    domain: 'bank.com', checkedAt: new Date().toISOString(),
    rdap: { status: 'ok' as const, registered: '2001-01-01T00:00:00Z', registrar: 'Example Registrar', expires: '2030-01-01T00:00:00Z' },
    dns: { status: 'ok' as const, mx: ['mx.bank.com'], spf: 'v=spf1 -all', dmarcPolicy: 'reject' },
    reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: [] },
  };

  it('renderSimpleDetails shows plain-English rows without technical jargon and escapes HTML', () => {
    const sender = analyzeSender('Bank <script>', 'alerts@mail.bank.com', []);
    const dl = renderSimpleDetails(document, sender, sampleIntel);
    const text = dl.textContent!;
    expect(text).toContain('Sent by');
    expect(text).toContain('Bank <script> (alerts@mail.bank.com)');
    expect(text).toContain('Website');
    expect(text).toContain('bank.com — ');
    expect(text).toContain('Spam check');
    expect(text).toContain('No spam reports found');
    expect(text).toContain('Links go to');
    expect(text).not.toMatch(/\b(MX|SPF|DMARC|URIBL|Registrar)\b/);
    expect(dl.querySelector('script')).toBeNull();
  });

  it('renderITDetails puts technical diagnostics inside a collapsed More options for IT section', () => {
    const sender = analyzeSender('Bank', 'alerts@mail.bank.com', []);
    const verdict = { score: 0.4, level: 'suspicious' as const, reasons: ['r1'] };
    const details = renderITDetails(document, sender, sampleIntel, verdict, ['r1']);
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('More options for IT');
    const text = details.textContent!;
    expect(text).toContain('suspicious (score 0.40)');
    expect(text).toContain('Example Registrar');
    expect(text).toContain('mx.bank.com');
    expect(text).toContain('policy reject');
    expect(text).toContain('not listed');
    expect(details.querySelector('button.copy-it')?.textContent).toBe('Copy details for IT');
  });

  it('formatITReport includes technical fields and excludes email body', () => {
    const sender = analyzeSender('Bank', 'alerts@mail.bank.com', []);
    const report = formatITReport(sender, sampleIntel, { score: 0.4, level: 'suspicious', reasons: ['sig1'] }, ['sig1']);
    expect(report).toContain('Verdict: suspicious (score 0.40)');
    expect(report).toContain('Registrar: Example Registrar');
    expect(report).toContain('Mail servers (MX): mx.bank.com');
    expect(report).toContain('DMARC: policy reject');
    expect(report).toContain('- sig1');
  });
});

describe('gmail adapter', () => {
  it('extracts sender, body and links from fixture HTML', () => {
    document.body.innerHTML = `<div class="adn"><span class="gD" email="Help@Gmail.com" name="PayPal Support">PayPal Support</span>
      <div class="a3s">Your account is locked. <a href="https://evil.example/login">www.paypal.com</a></div></div>`;
    const e = gmail.extract(document)!;
    expect(e.senderName).toBe('PayPal Support');
    expect(e.senderAddress).toBe('Help@Gmail.com');
    expect(e.body).toContain('account is locked');
    expect(e.links).toEqual([{ text: 'www.paypal.com', href: 'https://evil.example/login' }]);
  });
  it('returns null with no open email', () => {
    document.body.innerHTML = '<div>inbox</div>';
    expect(gmail.extract(document)).toBeNull();
  });
});
