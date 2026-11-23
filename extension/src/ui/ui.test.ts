// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { gmail } from '../adapters/gmail';
import { linksIn } from '../adapters/extract';
import { analyzeSender } from '../sender';
import { decideBanner, removeBanner, showBanner } from './banner';
import { formatAge, formatITReport, renderITDetails, renderSimpleDetails } from './details';
import { createCloseIcon, createLockIcon, createLogoSvg, createStatusIcon } from './icons';
import { isLocked, lockLinks, unlockLinks } from './linkLock';

const actions = () => ({ onUnlock: vi.fn(), onTrustSender: vi.fn(async () => true), onReport: vi.fn(async () => {}), onDismiss: vi.fn() });

describe('linkLock', () => {
  it('stashes and restores href, blocks links only while locked, and leaves outside links alone', () => {
    document.body.innerHTML = '<div id="m"><a id="l" href="https://evil.example/a?x=1">x</a></div><a id="o" href="https://ok.example">o</a>';
    const m = document.getElementById('m')!;
    const l = document.getElementById('l')!;
    const click = (target: Node) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(e);
      return e.defaultPrevented;
    };
    lockLinks(m);
    expect(isLocked(m)).toBe(true);
    expect(l.hasAttribute('href')).toBe(false);
    expect(l.getAttribute('data-ped-href')).toBe('https://evil.example/a?x=1');
    expect(l.getAttribute('aria-disabled')).toBe('true');
    expect(click(l)).toBe(true);
    expect(click(l.firstChild!)).toBe(true); // Text node inside locked link
    expect(click(document.getElementById('o')!)).toBe(false);
    expect(linksIn(m)).toEqual([{ text: 'x', href: 'https://evil.example/a?x=1' }]);

    unlockLinks(m);
    expect(isLocked(m)).toBe(false);
    expect(l.getAttribute('href')).toBe('https://evil.example/a?x=1');
    expect(l.hasAttribute('data-ped-href')).toBe(false);
    expect(l.hasAttribute('aria-disabled')).toBe(false);
    expect(click(l)).toBe(false);
  });

  it('blocks embedded image links, image maps, and form submissions while locked', () => {
    document.body.innerHTML = `
      <div id="m">
        <a id="img-link" href="https://evil.example/img"><img id="img" src="x.png" alt="banner"></a>
        <map name="m"><area id="area" shape="rect" coords="0,0,10,10" href="https://evil.example/area"></map>
        <form id="f" action="https://evil.example/steal"><button id="sub" type="submit">Go</button></form>
      </div>`;
    const m = document.getElementById('m')!;
    const f = document.getElementById('f')!;
    const area = document.getElementById('area')!;

    lockLinks(m);
    expect(area.hasAttribute('href')).toBe(false);
    expect(f.hasAttribute('action')).toBe(false);

    const imgClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('img')!.dispatchEvent(imgClick);
    expect(imgClick.defaultPrevented).toBe(true);

    const areaClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    area.dispatchEvent(areaClick);
    expect(areaClick.defaultPrevented).toBe(true);

    const subClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('sub')!.dispatchEvent(subClick);
    expect(subClick.defaultPrevented).toBe(true);

    const submit = new Event('submit', { bubbles: true, cancelable: true });
    f.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);

    unlockLinks(m);
    expect(area.getAttribute('href')).toBe('https://evil.example/area');
    expect(f.getAttribute('action')).toBe('https://evil.example/steal');
    const afterUnlock = new Event('submit', { bubbles: true, cancelable: true });
    f.dispatchEvent(afterUnlock);
    expect(afterUnlock.defaultPrevented).toBe(false);
  });
});

describe('banner', () => {
  it('renders once and is removable', () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: false, sender, intel: 'loading' }, actions());
    showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: ['<img src=x onerror=alert(1)>'], linksLocked: false, sender }, actions());
    expect(document.querySelectorAll('#ped-banner-host')).toHaveLength(1);
    expect(document.querySelector('img')).toBeNull();
    removeBanner();
    expect(document.getElementById('ped-banner-host')).toBeNull();
  });

  it('calls onTrustSender without calling onUnlock, and calls onUnlock on "I trust this email"', async () => {
    document.body.innerHTML = '';
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    let capturedRoot: ShadowRoot | undefined;
    const origAttach = HTMLElement.prototype.attachShadow;
    const spy = vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, init) {
      capturedRoot = origAttach.call(this, init);
      return capturedRoot;
    });
    try {
      const act1 = actions();
      showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: true, sender }, act1);
      const btns1 = [...capturedRoot!.querySelectorAll('button')];
      const trustSenderBtn = btns1.find((b) => b.textContent === 'Always trust sender')!;
      trustSenderBtn.click();
      await vi.waitFor(() => expect(act1.onTrustSender).toHaveBeenCalledTimes(1));
      expect(act1.onUnlock).not.toHaveBeenCalled();
      expect(document.getElementById('ped-banner-host')).toBeNull();

      const act2 = actions();
      showBanner({ level: 'warning', title: 'Check this sender.', tag: 'SENDER WARNING', reasons: sender.warnings, linksLocked: true, sender }, act2);
      const btns2 = [...capturedRoot!.querySelectorAll('button')];
      const trustEmailBtn = btns2.find((b) => b.textContent === 'I trust this email')!;
      trustEmailBtn.click();
      await vi.waitFor(() => expect(trustEmailBtn.textContent).toBe('Trusted — links enabled'));
      expect(act2.onUnlock).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      removeBanner();
    }
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

  it('shows warning banner and locks links when safe verdict has sender warning', () => {
    const sender = analyzeSender('PayPal Support', 'help@gmail.com', []);
    const locked = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, undefined, false)!;
    expect(locked.level).toBe('warning');
    expect(locked.title).toBe('Check this sender.');
    expect(locked.tag).toBe('SENDER WARNING');
    expect(locked.linksLocked).toBe(true);
    expect(locked.reasons[0]).toMatch(/Claims to be PayPal/);
    expect(locked.reasons[1]).toBe('Uses urgent wording about passwords or your account');

    const unlocked = decideBanner({ score: 0.2, level: 'safe', reasons: ['Uses urgent wording about passwords or your account'] }, sender, undefined, true)!;
    expect(unlocked.linksLocked).toBe(false);
  });

  it('shows warning banner and locks links on async spam-listed domain intel', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const spamIntel = {
      domain: 'evil.example', checkedAt: '2026-11-22T00:00:00Z',
      rdap: { status: 'ok' as const, registered: '2015-01-01T00:00:00Z' },
      dns: { status: 'ok' as const, mx: ['mx.evil.example'] },
      reputation: { status: 'ok' as const, source: 'URIBL' as const, listed: ['black'] },
    };
    const banner = decideBanner({ score: 0, level: 'safe', reasons: [] }, sender, spamIntel, false)!;
    expect(banner.level).toBe('warning');
    expect(banner.tag).toBe('DOMAIN WARNING');
    expect(banner.linksLocked).toBe(true);
    expect(banner.reasons[0]).toMatch(/reported for spam online/);
  });

  it('shows danger banner and unlocks only when unlockedThisSession is true', () => {
    const sender = analyzeSender('Someone', 'a@evil.example', []);
    const verdict = { score: 0.6, level: 'likely-phishing' as const, reasons: ['A link says paypal.com but actually goes to evil.example'] };
    const locked = decideBanner(verdict, sender, undefined, false)!;
    expect(locked.level).toBe('danger');
    expect(locked.title).toBe('Possible phishing.');
    expect(locked.tag).toBe('PHISHING WARNING');
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
  it('extracts all expanded messages in a multi-message thread top to bottom', () => {
    document.body.innerHTML = `
      <div class="adn">
        <span class="gD" email="top@evil.example" name="Top Sender">Top Sender</span>
        <div class="a3s" id="top">Top message <a href="https://evil.example/1">Link 1</a></div>
      </div>
      <div class="adn">
        <span class="gD" email="bottom@bank.com" name="Bottom Sender">Bottom Sender</span>
        <div class="a3s" id="bottom">Bottom message <a href="https://bank.com/2">Link 2</a></div>
      </div>`;
    const all = gmail.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all[0].senderAddress).toBe('top@evil.example');
    expect(all[0].container.id).toBe('top');
    expect(all[0].links).toEqual([{ text: 'Link 1', href: 'https://evil.example/1' }]);
    expect(all[1].senderAddress).toBe('bottom@bank.com');
    expect(all[1].container.id).toBe('bottom');
    expect(all[1].links).toEqual([{ text: 'Link 2', href: 'https://bank.com/2' }]);
  });
  it('extracts sender from Gmail Spam/via headers without email attribute and prepends h2.hP subject', () => {
    document.body.innerHTML = `
      <h2 class="hP">We've Blocked Your Account! Your photos and videos will be deleted</h2>
      <div class="adn ads">
        <div class="gs">
          <div class="gE iv gt">
            <h3 class="iw gFxsud">
              <span class="qu yKyxu">
                <span class="gD"><span>GmailSupportTeam</span></span>
                <span class="go gD">alert-442-320397@nozfr.itl</span>
                <span class="go">via 442.320397.jnc7.one.bss0019.narodaro.my.id</span>
              </span>
            </h3>
          </div>
          <div><div class="ii gt"><div class="a3s">
            Please update your billing details.
            <a href="https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl">Review billing</a>
          </div></div></div>
        </div>
      </div>`;
    const e = gmail.extract(document)!;
    expect(e.senderName).toBe('GmailSupportTeam');
    expect(e.senderAddress).toBe('alert-442-320397@nozfr.itl');
    expect(e.body).toContain("We've Blocked Your Account!");
    expect(e.body).toContain('Please update your billing details.');
    expect(e.links).toEqual([{ text: 'Review billing', href: 'https://storage.googleapis.com/hmdbox/hmd_v2.html#?act=cl' }]);
  });

  it('returns null with no open email', () => {
    document.body.innerHTML = '<div>inbox</div>';
    expect(gmail.extract(document)).toBeNull();
  });
});

describe('icons', () => {
  it('renders logo and semantic status SVGs cleanly via createElementNS', () => {
    const logo = createLogoSvg(document, 28);
    expect(logo.tagName.toLowerCase()).toBe('svg');
    expect(logo.getAttribute('aria-hidden')).toBe('true');
    expect(logo.getAttribute('width')).toBe('28');
    expect(logo.querySelectorAll('path, rect, circle').length).toBeGreaterThanOrEqual(4);

    for (const kind of ['safe', 'warning', 'danger'] as const) {
      const icon = createStatusIcon(document, kind, 20);
      expect(icon.tagName.toLowerCase()).toBe('svg');
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.children.length).toBeGreaterThanOrEqual(2);
    }

    expect(createLockIcon(document).getAttribute('aria-hidden')).toBe('true');
    expect(createCloseIcon(document).getAttribute('aria-hidden')).toBe('true');
  });
});
