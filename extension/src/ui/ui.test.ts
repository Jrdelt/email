// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { analyzeSender } from '../sender';
import { removeBanner, showBanner } from './banner';
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
