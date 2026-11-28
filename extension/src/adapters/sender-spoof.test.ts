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

  // A Gmail sender chip written into the email HTML (the sanitizer keeping the non-standard email attribute).
  const PLANTED = '<span class="gD" email="alex@corp.example" name="Alex Kim" style="display:none"></span>';

  it('Gmail spam layout: a sender chip written into the body is ignored', () => {
    document.body.innerHTML = `<div class="adn"><h3 class="iw"><span class="qu">
        <span class="gD"><span>Alex Kim</span></span><span class="go gD">x@evil.example</span>
      </span></h3><div class="a3s">${PLANTED}Verify now</div></div>`;
    expect(gmail.extract(document)).toMatchObject({ senderAddress: 'x@evil.example', senderName: 'Alex Kim' });
  });

  it('Gmail without a message card: the header chip wins over a later chip in the body', () => {
    document.body.innerHTML = `<div class="gE"><span class="gD" email="x@evil.example" name="X">X</span></div>
      <div class="a3s">${PLANTED}Verify now</div>`;
    expect(gmail.extract(document)).toMatchObject({ senderAddress: 'x@evil.example', senderName: 'X' });
  });

  it('Gmail: a chip in a quoted message body nested in the card is ignored too', () => {
    document.body.innerHTML = `<div class="adn"><span class="gD" email="x@evil.example" name="X">X</span>
      <div class="a3s">Verify now<div class="a3s">${PLANTED}quoted</div></div></div>`;
    document.querySelector('.adn')!.prepend(document.createRange().createContextualFragment(
      `<div class="a3s" hidden>${PLANTED}</div>`,
    ));
    expect(gmail.extract(document)).toMatchObject({ senderAddress: 'x@evil.example', senderName: 'X' });
  });
});

describe('message scope is the card around the body, not the body wrapper', () => {
  it('Yahoo: sender and attachment tile next to a wrapped body are found', async () => {
    const { yahoo } = await import('./yahoo');
    document.body.innerHTML = `<div data-test-id="message-card">
      <span data-test-id="message-from" title="billing@vendor.example">Vendor</span>
      <div data-test-id="message-view-body"><div class="msg-body">Invoice attached <a href="https://vendor.example/">portal</a></div></div>
      <div data-test-id="attachment-tile" title="invoice.pdf.html">invoice.pdf.html</div></div>`;
    const [e] = yahoo.extractAll!(document);
    expect(e!.senderAddress).toBe('billing@vendor.example');
    expect(e!.attachments?.map((a) => a.name)).toContain('invoice.pdf.html');
  });

  it('Proton: a message-view:body container still finds the sender in the message view', () => {
    document.body.innerHTML = `<article data-testid="message-view-0">
      <div data-testid="message-header:from"><span data-testid="recipient-address" title="billing@vendor.example">x</span></div>
      <div data-testid="message-view:body">Invoice attached <a href="https://vendor.example/">portal</a></div>
      <div data-testid="attachment-list"><button data-testid="attachment-item-0"><span data-testid="attachment-item:name">invoice.html</span></button></div>
    </article>`;
    const [e] = proton.extractAll!(document);
    expect(e!.senderAddress).toBe('billing@vendor.example');
    expect(e!.attachments?.map((a) => a.name)).toContain('invoice.html');
  });
});
