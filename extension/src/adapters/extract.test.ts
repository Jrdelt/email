// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { analyzeSender } from '../sender';
import { MAX_ATTACHMENTS, inlineAttachmentsIn, parseSenderHeader } from './extract';
import { outlook } from './outlook';
import { proton } from './proton';
import { yahoo } from './yahoo';

const body = (html: string) => {
  document.body.innerHTML = `<div id="m">${html}</div>`;
  return document.getElementById('m')!;
};

describe('inlineAttachmentsIn', () => {
  it('finds image-map, SVG xlink:href and whitespace/newline-obfuscated data: downloads', () => {
    const m = body(`
      <img usemap="#map"><map name="map"><area id="area" download="invoice.html" href="data:text/html;base64,AA=="></map>
      <svg><a id="svg" xlink:href="data:application/octet-stream;base64,AA=="><rect width="5" height="5"/></a></svg>
      <a id="space" href=" data:text/html,x">invoice</a>
      <a id="newline" href="da&#10;ta:text/html,x">statement</a>
      <a id="blob" href="BLOB:https://x.example/1">blob</a>
      <a id="plain" href="https://example.org/page">read more</a>`);
    const ids = inlineAttachmentsIn(m).map((a) => a.element.id);
    expect(ids).toEqual(['area', 'svg', 'space', 'newline', 'blob']);
  });

  it('still finds downloads whose href was stashed by a lock', () => {
    const m = body('<a id="s" data-ped-href="data:text/html,x">x</a><a id="t" data-ped-att-download="a.html">y</a>');
    expect(inlineAttachmentsIn(m).map((a) => a.element.id)).toEqual(['s', 't']);
  });

  it('locks the whole body instead of leaving downloads past the cap live', () => {
    const decoys = Array.from({ length: MAX_ATTACHMENTS }, (_, i) => `<a download="p${i}.jpg" href="data:image/jpeg,AA">p</a>`).join('');
    const m = body(`${decoys}<a id="evil" download="invoice.html" href="data:text/html,x">invoice</a>`);
    const found = inlineAttachmentsIn(m);
    expect(found).toHaveLength(MAX_ATTACHMENTS + 1);
    expect(found[found.length - 1]!.element).toBe(m);
  });
});


describe('decoy body markers inside the email cannot replace the real body', () => {
  const PHISH = '<a id="evil" href="http://192.168.4.20/login">https://www.paypal.com/signin</a>';
  const cases = [
    {
      name: 'outlook',
      adapter: outlook,
      html: `<div aria-label="Reading Pane"><div role="listitem"><span aria-label="From: X &lt;x@evil.example&gt;">X</span>
        <div id="UniqueMessageBody_1">Urgent ${PHISH}<div aria-label="Message body">Regards</div></div></div></div>`,
    },
    {
      name: 'yahoo',
      adapter: yahoo,
      html: `<div data-test-id="message-card"><span data-test-id="message-from" title="x@evil.example">X</span>
        <div class="msg-body">Urgent ${PHISH}<div data-test-id="message-view-body-content">Regards</div></div></div>`,
    },
    {
      name: 'proton',
      adapter: proton,
      html: `<article><span data-testid="message-header:from" title="x@evil.example">X</span>
        <div class="message-content">Urgent ${PHISH}<div data-testid="message-content:body">Regards</div></div></article>`,
    },
  ];
  for (const { name, adapter, html } of cases) {
    it(`${name}: the outermost body is scanned, so the phishing link is seen`, () => {
      document.body.innerHTML = html;
      const all = adapter.extractAll!(document);
      expect(all).toHaveLength(1);
      expect(all[0]!.container.contains(document.getElementById('evil'))).toBe(true);
      expect(all[0]!.links.map((l) => l.href)).toContain('http://192.168.4.20/login');
    });
  }
});

describe('address parsing stays linear on attacker text', () => {
  it('handles display names made of thousands of @ and dots within a few ms', () => {
    for (const name of ['@'.repeat(5000), `a@${'.'.repeat(5000)}`, 'a@b.'.repeat(2000)]) {
      const t = performance.now();
      parseSenderHeader(name);
      analyzeSender(name, 'x@evil.example', []);
      expect(performance.now() - t).toBeLessThan(50);
    }
  });

  it('still parses normal headers', () => {
    expect(parseSenderHeader('PayPal <service@paypal.com>')).toEqual({ senderName: 'PayPal', senderAddress: 'service@paypal.com' });
    expect(parseSenderHeader('From: billing@shop.example')).toEqual({ senderName: '', senderAddress: 'billing@shop.example' });
  });
});

describe('gmail via relay', () => {
  it('ignores "via <ESP>" written into the display name and keeps the real relay', async () => {
    const { gmail } = await import('./gmail');
    document.body.innerHTML = `
      <div class="adn"><h3 class="iw"><span class="qu">
        <span class="gD"><span>Boss via sendgrid.net</span></span>
        <span class="go gD">boss@company.example</span>
        <span class="go">via 12.relay.evil.example</span>
      </span></h3><div class="a3s">Please wire the payment today.</div></div>`;
    expect(gmail.extract(document)!.viaDomain).toBe('12.relay.evil.example');
  });
});

describe('padding cannot push the real message out of scanning range', () => {
  it('skips CSS/script text and keeps the end of an over-long body', async () => {
    const { bodyText, MAX_BODY_CHARS } = await import('./extract');
    const m = body(`<style>.a{color:red}</style><div>${'lorem '.repeat(5000)}</div><p>URGENT verify your password</p><script>x()</script>`);
    const t = bodyText(m);
    expect(t).not.toContain('color:red');
    expect(t).not.toContain('x()');
    expect(t).toContain('URGENT verify your password');
    expect(t.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
  });

  it('keeps a link that follows hundreds of padding links', async () => {
    const { linksIn, MAX_LINKS } = await import('./extract');
    const pad = Array.from({ length: 300 }, (_, i) => `<a href="https://www.paypal.com/help/${i}"></a>`).join('');
    const links = linksIn(body(`${pad}<a href="http://192.168.4.20/login">https://www.paypal.com/signin</a>`));
    expect(links.length).toBeLessThanOrEqual(MAX_LINKS);
    expect(links.map((l) => l.href)).toContain('http://192.168.4.20/login');
  });
});
