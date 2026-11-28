// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { analyzeSender } from '../sender';
import {
  MAX_ATTACHMENTS,
  MAX_BODY_CHARS,
  MAX_LINK_TEXT_CHARS,
  MAX_LINKS,
  bodyText,
  capLinkText,
  capText,
  inlineAttachmentsIn,
  parseSenderHeader,
  scanLinks,
} from './extract';
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


describe('form submissions to data:/blob: URLs are inline downloads', () => {
  const html = `<form id="f" action="data:application/zip;base64,TVqQ" method="post"><button id="fb">Get</button></form>
    <form id="g"><button id="b" formaction=" BLOB:https://x.example/1">Get</button><input type="image" id="i" formaction="da&#10;ta:x"></form>
    <form id="ok" action="https://x.example/data:y"><button formaction="/blob:z">Search</button></form>`;

  it('finds the form for a data: action and the control for a data:/blob: formaction, not ordinary forms', () => {
    expect(inlineAttachmentsIn(body(html)).map((a) => a.element.id)).toEqual(['f', 'b', 'i']);
  });

  it('keeps finding them, and scores the same links, once the attachment lock has stashed the targets', async () => {
    const { lockAttachments, unlockAttachments } = await import('../ui/attachmentLock');
    const m = body(html);
    const before = scanLinks(m).links;
    const found = inlineAttachmentsIn(m).map((a) => a.element);
    lockAttachments(found);
    expect(document.getElementById('f')!.hasAttribute('action')).toBe(false);
    expect(document.getElementById('b')!.hasAttribute('formaction')).toBe(false);
    expect(inlineAttachmentsIn(m).map((a) => a.element)).toEqual(found);
    expect(scanLinks(m).links).toEqual(before);
    unlockAttachments(found);
    expect(document.getElementById('f')!.getAttribute('action')).toBe('data:application/zip;base64,TVqQ');
    expect(document.getElementById('b')!.getAttribute('formaction')).toBe(' BLOB:https://x.example/1');
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

describe('bodies without text are still scanned', () => {
  it('Outlook: an attachment-only email (empty body) is found and its attachment collected', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer"><div aria-label="Email message">
      <span class="OZZZK">X &lt;x@evil.example&gt;</span><div aria-label="Message body"></div>
      <div role="listitem" aria-label="Attached file invoice.html"><button>invoice.html</button></div></div></div>`;
    const [e] = outlook.extractAll!(document);
    expect(e).toBeDefined();
    expect(e!.attachments?.map((a) => a.name).join(' ')).toContain('invoice.html');
  });

  it('Yahoo and Proton: SVG-only and form-only bodies are scanned', () => {
    document.body.innerHTML = `<div data-test-id="message-card"><span data-test-id="message-from" title="x@evil.example">X</span>
      <div data-test-id="message-view-body-content"><svg><a xlink:href="http://192.168.4.20/"><rect width="9" height="9"/></a></svg></div></div>`;
    expect(yahoo.extractAll!(document)[0]!.links.map((l) => l.href)).toContain('http://192.168.4.20/');
    document.body.innerHTML = `<article><span data-testid="message-header:from" title="x@evil.example">X</span>
      <div data-testid="message-content:body"><form action="https://evil.example/steal"><input name="pw"></form></div></article>`;
    expect(proton.extractAll!(document)[0]!.links.map((l) => l.href)).toContain('https://evil.example/steal');
  });
});

describe('link truncation is reported (fail closed)', () => {
  it('flags emails with more distinct links than can be checked', async () => {
    const { scanLinks, MAX_LINKS } = await import('./extract');
    const pad = (n: number, off: number) =>
      Array.from({ length: n }, (_, i) => `<a href="https://www.paypal.com/help/${i + off}">help</a>`).join('');
    const half = MAX_LINKS / 2 + 10;
    const both = scanLinks(body(`${pad(half, 0)}<a href="http://192.168.4.20/">x</a>${pad(half, 5000)}`));
    expect(both.truncated).toBe(true);
    expect(both.links.length).toBeLessThanOrEqual(MAX_LINKS);
    expect(scanLinks(body(`${'<a href="https://a.example/">same</a>'.repeat(500)}`)).truncated).toBe(false); // duplicates collapse
  });
});

describe('filler cannot hide content past the work caps', () => {
  it('examines the last links when thousands of identical filler links come first, and reports truncation', () => {
    const pad = '<a href="https://www.paypal.com/">PayPal</a>'.repeat(2100);
    const { links, truncated } = scanLinks(body(`${pad}<a href="http://192.168.4.20/login">https://www.paypal.com/signin</a>`));
    expect(links.map((l) => l.href)).toContain('http://192.168.4.20/login');
    expect(truncated).toBe(true);
  });

  it('collapses repeated SMIL values so they cannot exhaust the link budget', () => {
    const vals = Array.from({ length: 2500 }, () => 'https://www.paypal.com/').join(';');
    const { links, truncated } = scanLinks(
      body(`<svg><a><set attributeName="href" values="${vals}"/><text>x</text></a></svg><a href="http://192.168.4.20/x">y</a>`),
    );
    expect(links.map((l) => l.href)).toEqual(['https://www.paypal.com/', 'http://192.168.4.20/x']);
    expect(truncated).toBe(false);
  });

  it('keeps the end of the body however much hidden filler precedes it', () => {
    const t = bodyText(body(`<div style="display:none">${'a '.repeat(150_000)}</div><p>URGENT verify your password</p>`));
    expect(t.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
    expect(t).toContain('URGENT verify your password');
    expect(t.startsWith('a a a')).toBe(true);
  });

  it('returns short bodies whole and joins head and tail without a gap when they meet', () => {
    expect(bodyText(body('<p>Hello</p><style>.x{}</style><noscript>n</noscript><template>t</template> world'))).toBe('Hello world');
    const half = MAX_BODY_CHARS / 2;
    const t = bodyText(body(`<p>${'h'.repeat(MAX_BODY_CHARS)}</p><p>${'m'.repeat(100)}</p><p>${'t'.repeat(half)}</p>`));
    expect(t).toBe(`${'h'.repeat(half)}\n${'t'.repeat(half)}`);
  });

  it('caps long link text to exactly the limit, keeping the end after invisible filler', () => {
    const { links } = scanLinks(body(`<a href="https://paypal-signin-verify.com/">${'​'.repeat(5000)}https://www.paypal.com/signin</a>`));
    expect(links[0]!.text).toBe('https://www.paypal.com/signin');
    const visible = capText(`${'x'.repeat(5000)} https://www.paypal.com/signin`, MAX_LINK_TEXT_CHARS);
    expect(visible.length).toBe(MAX_LINK_TEXT_CHARS);
    expect(visible.endsWith('https://www.paypal.com/signin')).toBe(true);
  });

  it('finds the address after a very long display name', () => {
    const parsed = parseSenderHeader(`PayPal Service${'​'.repeat(3000)}${' '.repeat(3000)}<service@paypa1-alerts.com>`);
    expect(parsed?.senderAddress).toBe('service@paypa1-alerts.com');
    expect(analyzeSender(parsed!.senderName, parsed!.senderAddress, []).warnings.join(' ')).toMatch(/PayPal/);
  });
});

describe('inline download pre-filter', () => {
  it('finds every spelling the URL parser treats as data:/blob: and skips ordinary links', () => {
    const spellings = [' data:text/html,x', '\tda\nta:x', 'DATA:x', '\u0001blob:https://a/1', 'b\rl\to\nb:https://a/2', 'data\t:x'];
    for (const s of spellings) expect(new URL(s, 'https://mail.example/').protocol).toMatch(/^(data|blob):$/);
    const html = spellings.map((s, i) => `<a id="d${i}" href="${s.replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\u0001/g, '&#1;')}">f</a>`).join('');
    const found = inlineAttachmentsIn(body(`${html}<a href="https://x.example/data:y">n</a><a href="/blob:z">n</a><a href="mailto:a@b.c">m</a>`));
    expect(found.map((a) => a.element.id)).toEqual(spellings.map((_, i) => `d${i}`));
  });
});

describe('attachment-only message inside a conversation', () => {
  const shape = (all: { senderAddress: string; container: HTMLElement; attachments?: { element: HTMLElement }[] }[]) =>
    all.map((e) => ({ s: e.senderAddress, c: e.container.id, att: e.attachments?.map((a) => a.element.id) ?? [] }));
  const expected = [
    { s: 'bob@corp.example', c: 'a', att: [] },
    { s: 'x@evil.example', c: 'b', att: ['att'] },
  ];

  it('is still extracted (and so attachment-locked) on Outlook when another message has text', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div aria-label="Email message"><span class="OZZZK">Colleague &lt;bob@corp.example&gt;</span>
        <div aria-label="Message body" id="a">See below.</div></div>
      <div aria-label="Email message"><span class="OZZZK">X &lt;x@evil.example&gt;</span>
        <div aria-label="Message body" id="b"></div>
        <div role="listitem" aria-label="Attached file invoice.html" id="att"><button>invoice.html</button></div></div></div>`;
    expect(shape(outlook.extractAll!(document))).toEqual(expected);
  });

  it('is still extracted on Yahoo', () => {
    document.body.innerHTML = `<div data-test-id="message-group-view">
      <div data-test-id="message-card"><span data-test-id="message-from" title="bob@corp.example">Bob</span>
        <div data-test-id="message-view-body-content" id="a">See below.</div></div>
      <div data-test-id="message-card"><span data-test-id="message-from" title="x@evil.example">X</span>
        <div data-test-id="message-view-body-content" id="b"></div>
        <div data-test-id="attachment-list"><div data-test-id="attachment-tile" id="att" title="invoice.html">invoice.html</div></div></div></div>`;
    expect(shape(yahoo.extractAll!(document))).toEqual(expected);
  });

  it('is still extracted on Proton', () => {
    document.body.innerHTML = `<div data-testid="conversation-view">
      <article data-testid="message-view-0"><div data-testid="message-header:from" title="bob@corp.example">Bob</div>
        <div data-testid="message-content:body" id="a">See below.</div></article>
      <article data-testid="message-view-1"><div data-testid="message-header:from" title="x@evil.example">X</div>
        <div data-testid="message-content:body" id="b"></div>
        <div data-testid="attachment-list"><button data-testid="attachment-item-0" id="att"><span data-testid="attachment-item:name">invoice.html</span></button></div></article></div>`;
    expect(shape(proton.extractAll!(document))).toEqual(expected);
  });
});

describe('filler on both sides (sandwich)', () => {
  it('keeps the URL a link shows when filler surrounds it on both sides', () => {
    const pad = (n: number) => `${'\ufe0f'.repeat(n)}${'lorem ipsum '.repeat(n / 10)}`;
    const { links } = scanLinks(body(`<a href="https://paypal-signin-verify.com/">${pad(3000)}https://www.paypal.com/signin ${pad(3000)}</a>`));
    expect(links[0]!.text.length).toBeLessThanOrEqual(MAX_LINK_TEXT_CHARS);
    expect(links[0]!.text).toContain('https://www.paypal.com/signin');
    expect(capLinkText(`${'x '.repeat(3000)}\uff48\uff54\uff54\uff50\uff53://evil.example/ ${'y '.repeat(3000)}`)).toContain('https://evil.example/');
  });

  it('does not count blank or invisible filler toward the body sample', () => {
    const filler = `${'\n'.repeat(15_000)}${'\ufe0f'.repeat(15_000)}`;
    const t = bodyText(body(`<p>Hi</p>${filler}<p>URGENT verify your password</p>${filler}<p>Bye</p>`));
    expect(t).toBe('Hi URGENT verify your password Bye');
  });

  it('reads SMIL from= values: an event-started animation holds them before it runs', () => {
    const m = body(`<svg><a id="d" href="#x"><animate attributeName="href" from="data:text/html,x" to="#x" begin="mousedown" dur="indefinite"/><text>f</text></a>
      <a><animate attributeName="href" from="https://evil.example/" to="#y" begin="click"/><text>g</text></a></svg>`);
    expect(inlineAttachmentsIn(m).map((a) => a.element.id)).toEqual(['d']);
    expect(scanLinks(m).links.map((l) => l.href)).toContain('https://evil.example/');
  });

  it('does not fail closed on a typical large newsletter (300 distinct tracked links)', () => {
    const links = Array.from({ length: 300 }, (_, i) => `<a href="https://click.news.example.com/c/${i}">Item ${i}</a>`).join(' ');
    expect(scanLinks(body(links)).truncated).toBe(false);
    expect(MAX_LINKS).toBeGreaterThanOrEqual(300);
  });
});

describe('review of the newest fixes', () => {
  it('scores the one risky link hidden among more distinct filler links than are scored', () => {
    const filler = (from: number) => Array.from({ length: 600 }, (_, i) => `<a href="https://shop.example/p/${from + i}"></a>`).join('');
    const { links, truncated } = scanLinks(body(`${filler(0)}<a href="http://192.168.4.20/login">https://www.paypal.com/signin</a>${filler(600)}`));
    expect(truncated).toBe(true);
    expect(links.length).toBeLessThanOrEqual(MAX_LINKS);
    expect(links.map((l) => l.href)).toContain('http://192.168.4.20/login');
  });

  it('keeps an aimed SMIL download detected after the attachment lock stashes the animation', async () => {
    const { lockAttachments, unlockAttachments } = await import('../ui/attachmentLock');
    const m = body('<svg><a id="dl"><rect/></a><set href="#dl" attributeName="href" to="data:application/octet-stream;base64,TVqQ"/></svg>');
    const first = inlineAttachmentsIn(m).map((a) => a.element.id);
    expect(first).toEqual(['m']);
    lockAttachments([m]);
    expect(inlineAttachmentsIn(m).map((a) => a.element.id)).toEqual(['m']); // no lock/unlock flip-flop
    unlockAttachments([m]);
  });

  it('scores an aimed SMIL retarget with the text of the link it changes', () => {
    const m = body('<svg><a id="svga"><text>https://www.paypal.com/signin</text></a><set href="#svga" attributeName="href" to="https://login-verify.example/signin" begin="3s"/></svg>');
    const smil = scanLinks(m).links.find((l) => l.href === 'https://login-verify.example/signin');
    expect(smil?.text).toBe('https://www.paypal.com/signin');
  });
});

describe('bodyText on one huge text node', () => {
  it('keeps both ends of a single text node far longer than the sample', () => {
    const t = bodyText(body(`<p>START ${'lorem ipsum '.repeat(100_000)}URGENT verify your password</p>`));
    expect(t.startsWith('START lorem')).toBe(true);
    expect(t.endsWith('URGENT verify your password')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(MAX_BODY_CHARS + 1);
  });

  it('reads a node only once when head and tail meet inside it', () => {
    const t = bodyText(body(`<p>${'a'.repeat(MAX_BODY_CHARS - 10)}MIDDLE${'b'.repeat(5000)}</p>`));
    expect(t).toBe(`${'a'.repeat(MAX_BODY_CHARS / 2)}\n${`${'a'.repeat(MAX_BODY_CHARS - 10)}MIDDLE${'b'.repeat(5000)}`.slice(-MAX_BODY_CHARS / 2)}`);
  });
});

describe('Gmail inbox-list file buttons', () => {
  it('recognises file buttons on list rows but not the row itself or files inside an opened email', async () => {
    const { gmail } = await import('./gmail');
    document.body.innerHTML = `<div role="main"><table><tbody>
      <tr class="zA zE" role="row" id="row"><td><span class="yP" email="it@evil.example" name="IT Desk">IT Desk</span></td>
        <td><span class="bog" id="subj">Invoice</span>
          <div class="brc"><div class="brg" role="link" tabindex="0" id="chip"><span id="chiptext">invoice.html</span></div></div>
          <a id="dl" href="https://mail.google.com/mail/u/0/?ui=2&ik=x&attid=0.1&permmsgid=msg-f:1&view=att&disp=safe">invoice.html</a>
        </td></tr></tbody></table></div>
      <div class="adn"><div class="a3s"><a id="inmail" href="https://mail.google.com/mail/u/0/?view=att&attid=0.2">open.pdf</a></div></div>`;
    const at = (id: string) => gmail.listAttachmentAt!(document.getElementById(id)!);
    expect(at('chiptext')?.id).toBe('chip');
    expect(at('dl')?.id).toBe('dl');
    expect(at('subj')).toBeNull();
    expect(at('row')).toBeNull();
    expect(at('inmail')).toBeNull();
  });

  it('matches the chip container itself (icon or padding clicks) and never an opened message rendered as a list item', async () => {
    const { gmail } = await import('./gmail');
    document.body.innerHTML = `<table><tbody><tr class="zA" role="row"><td>
        <div class="brd"><div class="brc" role="link" tabindex="0" id="chip"><img id="icon" alt=""><span class="brg">a.pdf</span></div></div>
        <a id="dlattr" download="b.pdf" href="https://example.com/b.pdf">b.pdf</a></td></tr></tbody></table>
      <div role="main"><div role="row"><div role="listitem"><div class="hq"><a id="shelf" href="https://mail.google.com/mail/u/0/?view=att&attid=0.3">c.pdf</a></div></div></div></div>`;
    const at = (id: string) => gmail.listAttachmentAt!(document.getElementById(id)!);
    expect(at('icon')?.id).toBe('chip');
    expect(at('dlattr')?.id).toBe('dlattr');
    expect(at('shelf')).toBeNull();
  });
});
