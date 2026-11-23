// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { outlook, unwrapSafeLink } from './outlook';

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

  it('ignores compose boxes and returns null in inbox view', () => {
    document.body.innerHTML = `
      <div aria-label="Compose">
        <div aria-label="Message body" contenteditable="true">Draft text here</div>
      </div>`;
    expect(outlook.extract(document)).toBeNull();

    document.body.innerHTML = `<div role="main"><div role="listbox">Inbox list</div></div>`;
    expect(outlook.extract(document)).toBeNull();
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
