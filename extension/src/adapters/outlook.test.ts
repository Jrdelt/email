// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { unwrapRedirectUrl as unwrapSafeLink } from '../linkGuard';
import { outlook } from './outlook';

describe('outlook adapter', () => {
  it('extracts sender, body, and links from modern Outlook Web layout', () => {
    document.body.innerHTML = `
      <div data-app-section="ConversationContainer">
        <div aria-label="Email message">
          <div>
            <span class="OZZZK">MongoDB Cloud&lt;cloud-manager-support@mongodb.com&gt;</span>
          </div>
          <div aria-label="Message body">
            <p>Please review your cluster settings.</p>
            <a href="https://account.mongodb.com/account/reset">Reset password</a>
          </div>
        </div>
      </div>`;
    const e = outlook.extract(document)!;
    expect(e).not.toBeNull();
    expect(e.senderName).toBe('MongoDB Cloud');
    expect(e.senderAddress).toBe('cloud-manager-support@mongodb.com');
    expect(e.body).toContain('Please review your cluster settings.');
    expect(e.links).toEqual([{ text: 'Reset password', href: 'https://account.mongodb.com/account/reset' }]);
  });

  it('extracts sender from From aria-label with UniqueMessageBody', () => {
    document.body.innerHTML = `
      <div aria-label="Reading Pane">
        <div role="listitem">
          <button aria-label="From: PayPal Support &lt;help@gmail.com&gt;">PayPal Support</button>
          <div id="UniqueMessageBody_1">Urgent notice about your account.</div>
        </div>
      </div>`;
    const e = outlook.extract(document)!;
    expect(e).not.toBeNull();
    expect(e.senderName).toBe('PayPal Support');
    expect(e.senderAddress).toBe('help@gmail.com');
    expect(e.body).toContain('Urgent notice');
  });

  it('uses sender title attribute and ignores To: recipients and body emails', () => {
    document.body.innerHTML = `
      <header role="banner"><button title="me@ewu.edu">My Account</button></header>
      <div aria-label="Reading Pane">
        <div aria-label="Email message">
          <span title="alerts@bank.com">Bank Alerts</span>
          <div aria-label="To: You &lt;me@ewu.edu&gt;">You</div>
          <div aria-label="Message body">Contact fake@body.example if needed.</div>
        </div>
      </div>`;
    const e = outlook.extract(document)!;
    expect(e).not.toBeNull();
    expect(e.senderName).toBe('Bank Alerts');
    expect(e.senderAddress).toBe('alerts@bank.com');
  });

  it('extracts all expanded messages in a multi-message thread top to bottom', () => {
    document.body.innerHTML = `
      <div data-app-section="ConversationContainer">
        <div aria-label="Email message">
          <span class="OZZZK">Top Sender&lt;top@evil.example&gt;</span>
          <div aria-label="Message body" id="top">Top body <a href="https://evil.example/1">Top link</a></div>
        </div>
        <div aria-label="Email message">
          <span class="OZZZK">Bottom Sender&lt;bottom@bank.com&gt;</span>
          <div aria-label="Message body" id="bottom">Bottom body <a href="https://bank.com/2">Bottom link</a></div>
        </div>
      </div>`;
    const all = outlook.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all[0].senderAddress).toBe('top@evil.example');
    expect(all[0].container.id).toBe('top');
    expect(all[0].links).toEqual([{ text: 'Top link', href: 'https://evil.example/1' }]);
    expect(all[1].senderAddress).toBe('bottom@bank.com');
    expect(all[1].container.id).toBe('bottom');
    expect(all[1].links).toEqual([{ text: 'Bottom link', href: 'https://bank.com/2' }]);
  });

  it('ignores compose boxes and returns null in inbox view', () => {
    document.body.innerHTML = `
      <div aria-label="Compose">
        <div aria-label="Message body" contenteditable="true">Draft text here</div>
      </div>`;
    expect(outlook.extract(document)).toBeNull();

    document.body.innerHTML = `<div role="main"><div role="listbox">Inbox list</div></div>`;
    expect(outlook.extract(document)).toBeNull();
  });

  it('extracts attachment wells and cards while excluding compose attach buttons', () => {
    document.body.innerHTML = `
      <div aria-label="Compose">
        <button aria-label="Attach file">Attach</button>
      </div>
      <div aria-label="Reading Pane">
        <div aria-label="Email message">
          <button aria-label="From: Billing &lt;bill@vendor.com&gt;">Billing</button>
          <div role="region" aria-label="Attachments" id="well">
            <div data-testid="attachment-card" id="card1" aria-label="Attached file: invoice.html, 12 KB">
              <span>invoice.html</span>
              <button aria-label="Download invoice.html">Download</button>
            </div>
            <button id="dl-all" aria-label="Download all attachments">Download all</button>
          </div>
          <div aria-label="Message body" id="body">
            Please review <a id="inline" download="manual.pdf" href="data:application/pdf;base64,AA==">manual.pdf</a>.
          </div>
        </div>
      </div>`;
    const e = outlook.extract(document)!;
    expect(e.attachments?.map((a) => a.name)).toEqual(['manual.pdf', 'invoice.html']);
    expect(e.attachments?.map((a) => a.element.id)).toEqual(['inline', 'card1']);
    expect(e.attachmentContainers?.map((el) => el.id)).toEqual(['well']);
  });
});

describe('outlook sender: attachment names and the subject are never the sender', () => {
  // The header as OWA renders it, but with its build-hashed class renamed (span.OZZZK no longer matches pass 1).
  const page = (extra: string, subject = '') => `
    <div data-app-section="ConversationContainer">
      <div aria-label="Email message">${subject}
        <div><span class="Xk2Pq">Mallory Ops<span>&lt;mallory@evil.example&gt;</span></span></div>
        <div aria-label="Message body"><p>Please pay</p><a href="https://evil.example/pay">Pay now</a></div>
        ${extra}
      </div>
    </div>`;
  const cases: [string, string, string?][] = [
    ['an attachment card text', '<div role="listitem" aria-label="Attached file" id="att"><span>Boss &lt;boss@corp.example&gt;.pdf</span></div>'],
    ['an attachment option title', '<div role="region" aria-label="Attachments"><div role="option" title="Boss &lt;boss@corp.example&gt;.pdf"><span>Boss.pdf</span></div></div>'],
    ['a parenthesised address in a file name', '<div role="listitem" aria-label="Attached file"><span>Invoice (boss@corp.example).pdf</span></div>'],
    ['a download button label', '<button aria-label="Download Boss &lt;boss@corp.example&gt;.pdf">Download</button>'],
    ['the subject heading', '', '<div role="heading" aria-level="2"><span>Boss &lt;boss@corp.example&gt;</span></div>'],
  ];
  for (const [label, extra, subject] of cases) {
    it(`takes the header's address, not ${label}`, () => {
      document.body.innerHTML = page(extra, subject);
      const e = outlook.extract(document)!;
      expect(e.senderAddress).toBe('mallory@evil.example');
      expect(e.senderName).toBe('Mallory Ops');
    });
  }

  it('marks an address found only by the scope-wide passes as uncertain (never allowlist-trusted)', () => {
    document.body.innerHTML = page('');
    expect(outlook.extract(document)!.pairingUncertain).toBe(true);
    document.body.innerHTML = `<div aria-label="Reading Pane"><div aria-label="Email message">
      <span title="alerts@bank.com">Bank Alerts</span><div aria-label="Message body">x</div></div></div>`;
    expect(outlook.extract(document)).toMatchObject({ senderAddress: 'alerts@bank.com', pairingUncertain: true });
  });

  it('keeps an explicit From node certain', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer"><div aria-label="Email message">
      <span class="OZZZK">Mallory Ops&lt;mallory@evil.example&gt;</span><div aria-label="Message body">x</div></div></div>`;
    expect(outlook.extract(document)!.pairingUncertain).toBeUndefined();
  });

  it('uses the first address in DOM order, not a later leaf that also carries a name', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer"><div aria-label="Email message">
      <div><span class="Xk2Pq">&lt;mallory@evil.example&gt;</span></div>
      <div><span>Boss &lt;boss@corp.example&gt;</span></div>
      <div aria-label="Message body">x</div></div></div>`;
    expect(outlook.extract(document)!.senderAddress).toBe('mallory@evil.example');
  });
});

describe('unwrapSafeLink', () => {
  it('unwraps Microsoft Safe Links to http(s) targets', () => {
    expect(
      unwrapSafeLink('https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example%2Flogin&data=x'),
    ).toBe('https://evil.example/login');
  });

  it('leaves normal URLs untouched and ignores non-http(s) url params', () => {
    expect(unwrapSafeLink('https://account.mongodb.com/login')).toBe('https://account.mongodb.com/login');
    const js = 'https://nam12.safelinks.protection.outlook.com/?url=javascript%3Aalert(1)';
    expect(unwrapSafeLink(js)).toBe(js);
  });
});
