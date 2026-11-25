// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { lockLinks, unlockLinks } from '../ui/linkLock';
import {
  combineICloudThread,
  extractICloudHeaders,
  extractICloudSandbox,
  icloud,
  icloudFrameRole,
} from './icloud';

describe('icloudFrameRole', () => {
  it('classifies iCloud shell, mail2 app, and sandbox message frames strictly', () => {
    expect(icloudFrameRole(new URL('https://www.icloud.com/mail/'))).toBe('shell');
    expect(
      icloudFrameRole(new URL('https://www.icloud.com/applications/mail2/current/en-us/index.html?rootDomain=www')),
    ).toBe('app');
    expect(
      icloudFrameRole(
        new URL('https://www-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html'),
      ),
    ).toBe('sandbox');
    expect(
      icloudFrameRole(
        new URL('https://p42-mail.icloud-sandbox.com/applications/mail2-message/current/en-us/index.html'),
      ),
    ).toBe('sandbox');
    expect(icloudFrameRole(new URL('https://www.icloud.com/photos/'))).toBeNull();
    expect(icloudFrameRole(new URL('https://evil-icloud-sandbox.com/applications/mail2-message/'))).toBeNull();
    expect(icloudFrameRole(new URL('https://www-mail.icloud-sandbox.com/other/'))).toBeNull();
  });
});

describe('extractICloudHeaders', () => {
  it('extracts collapsed mail2 header metadata and ignores the off-screen pooled iframe', () => {
    document.body.innerHTML = `
      <div id="root">
        <div class="pane thread-detail-pane">
          <div class="dynamic-rendering-list conversation-list">
            <div id="message-iframe-Junk/42">
              <div class="conversation-list-item">
                <div>
                  <span class="contact-token" role="button"><span>PayPal Support</span></span>
                  <span>Today at 10:15 AM</span>
                  <div class="allow-select"></div>
                  <button class="push primary" aria-label="Expand message header">Details</button>
                </div>
                <h2>Urgent verification required</h2>
                <div><iframe src="about:blank"></iframe></div>
              </div>
            </div>
          </div>
        </div>
        <div style="position:absolute;top:-10000px;left:-10000px;width:0;height:0">
          <iframe src="about:blank"></iframe>
        </div>
      </div>`;

    const headers = extractICloudHeaders(document);
    expect(headers).toHaveLength(1);
    expect(headers[0].id).toBe('message-iframe-Junk/42');
    expect(headers[0].senderName).toBe('PayPal Support');
    expect(headers[0].senderAddress).toBe('');
    expect(headers[0].subject).toBe('Urgent verification required');
    expect(headers[0].iframeCount).toBe(1);
  });

  it('extracts sender address when contact-token exposes an address', () => {
    document.body.innerHTML = `
      <div id="message-iframe-INBOX/7">
        <div class="conversation-list-item">
          <span class="contact-token" role="button" title="alerts@bank.example">Bank Alerts</span>
          <h2>Statement Ready</h2>
          <iframe src="about:blank"></iframe>
        </div>
      </div>`;
    const headers = extractICloudHeaders(document);
    expect(headers).toHaveLength(1);
    expect(headers[0].senderName).toBe('Bank Alerts');
    expect(headers[0].senderAddress).toBe('alerts@bank.example');
  });

  it('extracts expanded From address from Details (.allow-select) without mistaking To/Cc recipients', () => {
    document.body.innerHTML = `
      <div id="message-iframe-Junk/99">
        <div class="conversation-list-item">
          <span class="contact-token" role="button">Security Desk</span>
          <div class="allow-select">
            <div>To: You &lt;me@icloud.com&gt;</div>
            <div>Cc: Audit &lt;audit@icloud.com&gt;</div>
            <div>From: Security Desk &lt;alert@fake-login.example&gt;</div>
          </div>
          <h2>Action Required</h2>
          <iframe src="about:blank"></iframe>
        </div>
      </div>`;
    const headers = extractICloudHeaders(document);
    expect(headers).toHaveLength(1);
    expect(headers[0].senderName).toBe('Security Desk');
    expect(headers[0].senderAddress).toBe('alert@fake-login.example');
  });

  it('extracts iCloud mail2 attachment elements and combines sandbox inline attachmentNames', () => {
    document.body.innerHTML = `
      <div id="message-iframe-Junk/12">
        <div class="conversation-list-item">
          <span class="contact-token" title="alerts@evil.example">Alerts</span>
          <h2>Receipt</h2>
          <div class="attachments-bar attachment-list" id="att-bar">
            <button id="att-btn" aria-label="Download statement.pdf.html">statement.pdf.html</button>
          </div>
          <iframe src="about:blank"></iframe>
        </div>
      </div>`;
    const headers = extractICloudHeaders(document);
    expect(headers[0].attachments.map((a) => a.name)).toEqual(['statement.pdf.html']);
    expect(headers[0].attachments.map((a) => a.element.id)).toEqual(['att-btn']);
    expect(headers[0].attachmentContainers.map((c) => c.id)).toEqual(['att-bar']);

    const combined = combineICloudThread(
      headers,
      new Map([[55, { body: 'See file', links: [], attachmentNames: ['extra.zip'] }]]),
    );
    expect(combined[0].attachmentNames).toEqual(['statement.pdf.html', 'extra.zip']);
    expect(combined[0].frameId).toBe(55);
  });

  it('extracts multiple expanded messages in a thread top to bottom', () => {
    document.body.innerHTML = `
      <div class="conversation-list">
        <div id="message-iframe-INBOX/1">
          <div class="conversation-list-item">
            <span class="contact-token" data-email="first@evil.example">First Sender</span>
            <h2>Re: Invoice</h2>
            <iframe src="about:blank"></iframe>
          </div>
        </div>
        <div id="message-iframe-INBOX/2">
          <div class="conversation-list-item">
            <span class="contact-token" data-email="second@bank.com">Second Sender</span>
            <h2>Re: Invoice</h2>
            <iframe src="about:blank"></iframe>
          </div>
        </div>
      </div>`;
    const headers = extractICloudHeaders(document);
    expect(headers).toHaveLength(2);
    expect(headers.map((h) => [h.id, h.senderName, h.senderAddress])).toEqual([
      ['message-iframe-INBOX/1', 'First Sender', 'first@evil.example'],
      ['message-iframe-INBOX/2', 'Second Sender', 'second@bank.com'],
    ]);
  });
});

describe('extractICloudSandbox', () => {
  it('extracts body and links (even while locked) for visible non-empty sandbox frames', () => {
    document.body.innerHTML = `
      <p>Please verify your account now.</p>
      <a id="l" href="https://evil.example/login">https://paypal.com/verify</a>`;

    const first = extractICloudSandbox(document, { width: 640, height: 480 });
    expect(first.active).toBe(true);
    expect(first.body).toContain('Please verify your account now.');
    expect(first.links).toEqual([{ text: 'https://paypal.com/verify', href: 'https://evil.example/login' }]);
    expect(first.container).toBe(document.body);

    lockLinks(document.body);
    const locked = extractICloudSandbox(document, { width: 640, height: 480 });
    expect(locked.active).toBe(true);
    expect(locked.links).toEqual([{ text: 'https://paypal.com/verify', href: 'https://evil.example/login' }]);
    unlockLinks(document.body);
  });

  it('detects inline download/data attachments in sandbox frames', () => {
    document.body.innerHTML = `<a id="dl" download="smuggled.html" href="blob:https://mail.icloud-sandbox.com/1">Download</a>`;
    const res = extractICloudSandbox(document, { width: 640, height: 480 });
    expect(res.active).toBe(true);
    expect(res.attachments).toHaveLength(1);
    expect(res.attachments[0].name).toBe('smuggled.html');
  });

  it('marks empty bodies or 0x0 pooled iframes as inactive', () => {
    document.body.innerHTML = '<p>Pooled content</p><a href="https://example.com">Link</a>';
    expect(extractICloudSandbox(document, { width: 0, height: 0 })).toEqual({
      active: false,
      body: '',
      links: [],
      attachments: [],
      container: null,
    });

    document.body.innerHTML = '   ';
    expect(extractICloudSandbox(document, { width: 600, height: 400 }).active).toBe(false);
  });
});

describe('combineICloudThread', () => {
  it('returns [] when no header cards are open even if sandbox bodies exist', () => {
    const bodies = new Map([[12, { body: 'Stale body', links: [] }]]);
    expect(combineICloudThread([], bodies)).toEqual([]);
  });

  it('pairs single and multi-message headers with sandbox payloads in order', () => {
    document.body.innerHTML = `
      <div id="message-iframe-INBOX/1"><div class="conversation-list-item">
        <span class="contact-token" title="a@evil.example">A</span><h2>First</h2>
      </div></div>
      <div id="message-iframe-INBOX/2"><div class="conversation-list-item">
        <span class="contact-token" title="b@bank.com">B</span><h2>Second</h2>
      </div></div>`;
    const headers = extractICloudHeaders(document);
    const bodies = new Map([
      [101, { body: 'Top body', links: [{ text: 'Top', href: 'https://evil.example/1' }] }],
      [102, { body: 'Bottom body', links: [{ text: 'Bot', href: 'https://bank.com/2' }] }],
    ]);
    const combined = combineICloudThread(headers, bodies);
    expect(combined).toEqual([
      {
        senderName: 'A',
        senderAddress: 'a@evil.example',
        body: 'First\nTop body',
        links: [{ text: 'Top', href: 'https://evil.example/1' }],
        frameId: 101,
      },
      {
        senderName: 'B',
        senderAddress: 'b@bank.com',
        body: 'Second\nBottom body',
        links: [{ text: 'Bot', href: 'https://bank.com/2' }],
        frameId: 102,
      },
    ]);
  });

  it('pairs active sandbox payload with expanded card (iframeCount > 0) rather than collapsed earlier card', () => {
    document.body.innerHTML = `
      <div id="message-iframe-INBOX/1"><div class="conversation-list-item">
        <span class="contact-token" title="collapsed@bank.com">Collapsed</span><h2>Re: Hello</h2>
      </div></div>
      <div id="message-iframe-INBOX/2"><div class="conversation-list-item">
        <span class="contact-token" title="expanded@evil.example">Expanded</span><h2>Re: Hello</h2>
        <iframe src="about:blank"></iframe>
      </div></div>`;
    const headers = extractICloudHeaders(document);
    expect(headers.map((h) => h.iframeCount)).toEqual([0, 1]);
    const bodies = new Map([
      [202, { body: 'Malicious expanded body', links: [{ text: 'Verify', href: 'https://evil.example/p' }] }],
    ]);
    const combined = combineICloudThread(headers, bodies);
    expect(combined[0]).toMatchObject({
      senderAddress: 'collapsed@bank.com',
      body: 'Re: Hello',
      links: [],
      frameId: undefined,
    });
    expect(combined[1]).toMatchObject({
      senderAddress: 'expanded@evil.example',
      body: 'Re: Hello\nMalicious expanded body',
      links: [{ text: 'Verify', href: 'https://evil.example/p' }],
      frameId: 202,
    });
  });
});

describe('icloud adapter', () => {
  it('returns null/[] in the outer shell frame and extracts in sandbox or synthetic fixtures', () => {
    document.body.innerHTML = '<iframe id="early-child" class="child-application"></iframe>';
    expect(icloud.extract(document)).toBeNull();
    expect(icloud.extractAll!(document)).toEqual([]);

    document.body.innerHTML = '<p>Verify now <a href="https://evil.example">paypal.com</a></p>';
    const sb = icloud.extract(document)!;
    expect(sb).not.toBeNull();
    expect(sb.body).toContain('Verify now');
    expect(sb.links).toEqual([{ text: 'paypal.com', href: 'https://evil.example/' }]);

    document.body.innerHTML = `
      <div id="message-iframe-Junk/5">
        <div class="conversation-list-item">
          <span class="contact-token" data-email="phish@evil.example">Billing</span>
          <h2>Invoice Due</h2>
          <div data-message-body><p>Pay today</p><a href="https://evil.example/pay">Pay</a></div>
        </div>
      </div>`;
    const msg = icloud.extract(document)!;
    expect(msg.senderName).toBe('Billing');
    expect(msg.senderAddress).toBe('phish@evil.example');
    expect(msg.body).toBe('Invoice Due\nPay todayPay');
    expect(msg.links).toEqual([{ text: 'Pay', href: 'https://evil.example/pay' }]);
  });
});

describe('icloudFrameRole matches only the manifest paths', () => {
  it('rejects look-alike paths', () => {
    for (const u of ['https://www.icloud.com/mail2', 'https://www.icloud.com/mailto/x', 'https://www.icloud.com/applications/mail2xyz', 'https://p1.icloud-sandbox.com/applications/mail2-messagefoo']) {
      expect(icloudFrameRole(new URL(u))).toBeNull();
    }
    expect(icloudFrameRole(new URL('https://www.icloud.com/mail/'))).toBe('shell');
  });
});

describe('combineICloudThread pairs by frame id when available', () => {
  it('keeps each body with its own card even when frames reported in reverse order', () => {
    document.body.innerHTML = `
      <div id="message-iframe-1"><div class="conversation-list-item"><span class="contact-token" title="colleague@corp.example">C</span><h2>Hi</h2><iframe id="f1"></iframe></div></div>
      <div id="message-iframe-2"><div class="conversation-list-item"><span class="contact-token" title="phish@evil.example">P</span><h2>Hi</h2><iframe id="f2"></iframe></div></div>`;
    const headers = extractICloudHeaders(document);
    const bodies = new Map([
      [9, { body: 'phishing body', links: [{ text: 'x', href: 'http://192.168.4.20/' }] }],
      [7, { body: 'colleague body', links: [] }],
    ]);
    const ids: Record<string, number> = { f1: 7, f2: 9 };
    const msgs = combineICloudThread(headers, bodies, (el) => ids[el.id]);
    expect(msgs.map((m) => [m.senderAddress, m.frameId, m.body.includes('phishing')])).toEqual([
      ['colleague@corp.example', 7, false],
      ['phish@evil.example', 9, true],
    ]);
  });
});
