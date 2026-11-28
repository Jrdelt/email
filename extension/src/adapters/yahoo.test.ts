// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { yahoo } from './yahoo';

describe('yahoo adapter', () => {
  it('extracts sender, subject, body, links, and attachments while ignoring compose editors', () => {
    document.body.innerHTML = `
      <div data-test-id="compose-editor" contenteditable="true">Draft text <a href="https://draft.example">draft</a></div>
      <div data-test-id="message-group-view">
        <h1 data-test-id="message-group-subject-text">Action Required: Confirm Billing</h1>
        <div data-test-id="message-card">
          <div data-test-id="message-header">
            <span data-test-id="message-from" title="alerts@evil-billing.example">Billing Support</span>
            <div data-test-id="recipient-list"><span title="me@yahoo.com">Me</span></div>
          </div>
          <div data-test-id="message-view-body-content" id="y-body">
            Please verify your account within 24 hours.
            <a href="https://urlto.me/2r7Nf">Verify Now</a>
          </div>
          <div data-test-id="attachment-list" id="y-att-list">
            <div data-test-id="attachment-tile" id="y-tile">
              <span data-test-id="attachment-filename">invoice.pdf.html</span>
            </div>
          </div>
        </div>
      </div>`;

    const all = yahoo.extractAll!(document);
    expect(all).toHaveLength(1);
    expect(all[0].senderName).toBe('Billing Support');
    expect(all[0].senderAddress).toBe('alerts@evil-billing.example');
    expect(all[0].body).toContain('Action Required: Confirm Billing');
    expect(all[0].body).toContain('Please verify your account');
    expect(all[0].links).toEqual([{ text: 'Verify Now', href: 'https://urlto.me/2r7Nf' }]);
    expect(all[0].attachments?.map((a) => a.name)).toEqual(['invoice.pdf.html']);
    expect(all[0].attachmentContainers?.map((el) => el.id)).toEqual(['y-att-list']);
  });

  it('never takes the sender from an attachment tile or the subject, and marks a scope-wide match uncertain', () => {
    const page = (fromTitle: string, extra: string, subject = '') => `
      <div data-test-id="message-group-view">${subject}<div data-test-id="message-card">
        <div data-test-id="message-header"><span data-test-id="message-from"${fromTitle}>Mallory Ops</span></div>
        <div data-test-id="message-view-body-content">Please pay <a href="https://evil.example/pay">Pay</a></div>
        ${extra}
        <a href="mailto:mallory@evil.example" id="reply">mallory@evil.example</a>
      </div></div>`;
    const tile = (t: string) =>
      `<div data-test-id="attachment-list"><div data-test-id="attachment-tile" title="${t}"><span data-test-id="attachment-filename">${t}</span></div></div>`;
    for (const t of ['boss@corp.example.pdf', 'Invoice (boss@corp.example).pdf']) {
      document.body.innerHTML = page('', tile(t));
      expect(yahoo.extract(document), t).toMatchObject({ senderAddress: 'mallory@evil.example', pairingUncertain: true });
    }
    document.body.innerHTML = page('', '', '<h1 data-test-id="message-group-subject-text" title="boss@corp.example">Boss</h1>');
    expect(yahoo.extract(document)).toMatchObject({ senderAddress: 'mallory@evil.example', pairingUncertain: true });
    // No message card: the conversation view (which holds the subject) is the scope.
    document.body.innerHTML = `<div data-test-id="message-group-view">
      <h1 data-test-id="message-group-subject-text" title="boss@corp.example">Boss</h1>
      <div data-test-id="message-view-body-content">Please pay <a href="https://evil.example/pay">Pay</a></div>
      <a href="mailto:mallory@evil.example">mallory@evil.example</a></div>`;
    expect(yahoo.extract(document)).toMatchObject({ senderAddress: 'mallory@evil.example', pairingUncertain: true });
    // The header's own sender node stays certain.
    document.body.innerHTML = page(' title="mallory@evil.example"', tile('boss@corp.example.pdf'));
    const e = yahoo.extract(document)!;
    expect(e.senderAddress).toBe('mallory@evil.example');
    expect(e.pairingUncertain).toBeUndefined();
  });

  it('returns null when no Yahoo message is open', () => {
    document.body.innerHTML = '<div data-test-id="virtual-list">Inbox list</div>';
    expect(yahoo.extract(document)).toBeNull();
  });
});
