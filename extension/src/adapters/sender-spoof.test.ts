// @vitest-environment happy-dom
// The sender controls the display name, so an address written into it must never become the sender address.
import { describe, expect, it } from 'vitest';
import { gmail } from './gmail';
import { extractICloudHeaders } from './icloud';
import { proton } from './proton';

describe('display-name address spoofing', () => {
  it('iCloud: a contact token whose text is an address but has no address attribute yields no sender address', () => {
    document.body.innerHTML = `<div id="message-iframe-INBOX/1"><div class="conversation-list-item">
      <span class="contact-token" role="button">service@paypal.com</span><h2>Statement</h2><iframe></iframe></div></div>`;
    expect(extractICloudHeaders(document)[0]!.senderAddress).toBe('');
  });

  it('iCloud: a "Cc:" display name does not blank the real sender', () => {
    document.body.innerHTML = `<div id="message-iframe-INBOX/2"><div class="conversation-list-item">
      <span class="contact-token" role="button" title="alerts@paypa1.com">Cc: Bank Alerts</span><h2>Alert</h2><iframe></iframe></div></div>`;
    expect(extractICloudHeaders(document)[0]!.senderAddress).toBe('alerts@paypa1.com');
  });

  it('Proton: the from-block wins over the outer header that starts with the display name', () => {
    document.body.innerHTML = `<article data-testid="message-view-0"><header data-testid="message-header-expanded">
        <span>service@paypal.com</span>
        <div data-testid="message-header:from"><span data-testid="recipient-name">service@paypal.com</span>
          <span data-testid="recipient-address" title="x@evil.example">&lt;x@evil.example&gt;</span></div>
      </header><div data-testid="message-content:body">Verify now <a href="https://evil.example/">go</a></div></article>`;
    expect(proton.extractAll!(document)[0]!.senderAddress).toBe('x@evil.example');
  });

  it('Gmail spam layout: an address in the display-name chip is ignored', () => {
    document.body.innerHTML = `<div class="adn"><h3 class="iw"><span class="qu">
        <span class="gD"><span>service@paypal.com</span></span><span class="go gD">x@evil.example</span>
      </span></h3><div class="a3s">Verify now</div></div>`;
    expect(gmail.extract(document)!.senderAddress).toBe('x@evil.example');
  });
});
