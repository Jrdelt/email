// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { proton } from './proton';

describe('proton adapter', () => {
  it('extracts decrypted message body, sender, subject, links, and attachments while ignoring composer', () => {
    document.body.innerHTML = `
      <div data-testid="composer:body" contenteditable="true">Composing draft</div>
      <div data-testid="conversation-view">
        <h1 data-testid="conversation-header:subject">Security Verification Needed</h1>
        <article data-testid="message-view-0">
          <header data-testid="message-header-expanded">
            <div data-testid="message-header:from">
              <span data-testid="recipient-name">Account Security</span>
              <span data-testid="recipient-address" title="security@fake-portal.example">&lt;security@fake-portal.example&gt;</span>
            </div>
            <div data-testid="recipients:to"><span title="me@proton.me">me@proton.me</span></div>
          </header>
          <div data-testid="message-content:body" id="p-body">
            Unusual activity detected. Please confirm your account.
            <a href="https://evil-login.example/verify">https://account.proton.me/verify</a>
          </div>
          <div data-testid="attachment-list" id="p-att-list">
            <button data-testid="attachment-item-0" id="p-att-0">
              <span data-testid="attachment-item:name">document.svg</span>
            </button>
          </div>
        </article>
      </div>`;

    const all = proton.extractAll!(document);
    expect(all).toHaveLength(1);
    expect(all[0].senderName).toBe('Account Security');
    expect(all[0].senderAddress).toBe('security@fake-portal.example');
    expect(all[0].body).toContain('Security Verification Needed');
    expect(all[0].body).toContain('Unusual activity detected');
    expect(all[0].links).toEqual([
      { text: 'https://account.proton.me/verify', href: 'https://evil-login.example/verify' },
    ]);
    expect(all[0].attachments?.map((a) => a.name)).toEqual(['document.svg']);
    expect(all[0].attachmentContainers?.map((el) => el.id)).toEqual(['p-att-list']);
  });

  it('extracts decrypted message content from Proton content-iframe when accessible', () => {
    document.body.innerHTML = `
      <div data-testid="conversation-view">
        <h1 data-testid="conversation-header:subject">Invoice</h1>
        <article data-testid="message-view-0">
          <div data-testid="message-header:from" title="billing@vendor.example">Vendor Billing</div>
          <iframe data-testid="content-iframe" id="proton-frame"></iframe>
        </article>
      </div>`;
    const frame = document.getElementById('proton-frame') as HTMLIFrameElement;
    const fdoc = document.implementation.createHTMLDocument('');
    fdoc.body.innerHTML = '<p>See link <a href="https://evil.example/pay">Pay now</a></p>';
    Object.defineProperty(frame, 'contentDocument', { value: fdoc, configurable: true });

    const e = proton.extract(document)!;
    expect(e).not.toBeNull();
    expect(e.senderAddress).toBe('billing@vendor.example');
    expect(e.body).toContain('Invoice');
    expect(e.body).toContain('See link');
    expect(e.links).toEqual([{ text: 'Pay now', href: 'https://evil.example/pay' }]);
    expect(e.container).toBe(fdoc.body);
  });

  it('without a From block, never takes the sender from an attachment and marks a scope-wide match uncertain', () => {
    document.body.innerHTML = `
      <div data-testid="conversation-view">
        <article data-testid="message-view-0">
          <div data-testid="attachment-list">
            <button data-testid="attachment-item-0" title="Boss &lt;boss@corp.example&gt;.pdf">
              <span data-testid="attachment-item:name">Boss &lt;boss@corp.example&gt;.pdf</span>
            </button>
          </div>
          <span title="mallory@evil.example">Mallory Ops</span>
          <div data-testid="message-content:body">Please pay <a href="https://evil.example/pay">Pay</a></div>
        </article>
      </div>`;
    expect(proton.extract(document)).toMatchObject({ senderAddress: 'mallory@evil.example', pairingUncertain: true });
  });

  it('returns null when no Proton message is open', () => {
    document.body.innerHTML = '<main>Inbox</main>';
    expect(proton.extract(document)).toBeNull();
  });
});
