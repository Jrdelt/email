// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { analyzeSender } from '../sender';
import { removeBanner, showBanner, decideBanner } from './banner';
import { renderDetails } from './details';
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
    showBanner({ level: 'warning', title: 'Check the sender', reasons: sender.warnings, linksLocked: false, sender, intel: 'loading' }, actions());
    showBanner({ level: 'warning', title: 'Check the sender', reasons: ['<img src=x onerror=alert(1)>'], linksLocked: false, sender }, actions());
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
    const banner = decideBanner({ score: 0.2, level: 'safe', reasons: ['Urgent or credential-related wording'] }, sender, cleanIntel, false);
    expect(banner).toBeNull();
  });

  it('shows warning banner with sender warning first when safe verdict has sender warning', () => {
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    const banner = decideBanner({ score: 0.2, level: 'safe', reasons: ['Urgent or credential-related wording'] }, sender, undefined, false)!;
    expect(banner.level).toBe('warning');
    expect(banner.title).toBe('Check the sender');
    expect(banner.linksLocked).toBe(false);
    expect(banner.reasons[0]).toMatch(/Name says "PayPal"/);
    expect(banner.reasons[1]).toBe('Urgent or credential-related wording');
  });

  it('shows danger banner and unlocks only when unlockedThisSession is true', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const verdict = { score: 0.6, level: 'likely-phishing' as const, reasons: ['Link text shows paypal.com but goes to evil.example'] };
    const locked = decideBanner(verdict, sender, undefined, false)!;
    expect(locked.level).toBe('danger');
    expect(locked.linksLocked).toBe(true);
    const unlocked = decideBanner(verdict, sender, undefined, true)!;
    expect(unlocked.level).toBe('danger');
    expect(unlocked.linksLocked).toBe(false);
  });
});

describe('details', () => {
  it('shows sender, domain and lookup results as text', () => {
    const sender = analyzeSender('Bank <script>', 'alerts@mail.bank.com', []);
    const dl = renderDetails(document, sender, {
      domain: 'bank.com', checkedAt: new Date().toISOString(),
      rdap: { status: 'ok', registered: '2001-01-01T00:00:00Z', registrar: 'R', expires: '2030-01-01T00:00:00Z' },
      dns: { status: 'ok', mx: ['mx.bank.com'], spf: 'v=spf1 -all', dmarcPolicy: 'reject' },
      reputation: { status: 'ok', source: 'URIBL', listed: [] },
    });
    const text = dl.textContent!;
    expect(text).toContain('Bank <script> <alerts@mail.bank.com>');
    expect(text).toContain('bank.com (sent from mail.bank.com)');
    expect(text).toContain('policy reject');
    expect(text).toContain('not listed');
    expect(dl.querySelector('script')).toBeNull();
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
