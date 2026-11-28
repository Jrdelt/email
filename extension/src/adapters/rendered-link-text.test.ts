// @vitest-environment happy-dom
// The text/destination mismatch check reads a link's text: it must be the text the reader sees. Hidden splitters
// (display:none, font-size:0, a stylesheet class), a reversed string under an RTL bidi override (<bdo dir=rtl>,
// unicode-bidi:bidi-override, U+202E) made a link that shows https://www.paypal.com/signin look like no host at all.
import { describe, expect, it, vi } from 'vitest';
import { scoreEmail } from '../features';
import { scanLinks, textCouldShowHost } from './extract';
import { gmail } from './gmail';

const EVIL = 'https://evil.example/signin';
const body = (html: string) => {
  document.body.innerHTML = `<div id="m">${html}</div>`;
  return document.getElementById('m')!;
};
const textOfOnlyLink = (inner: string, attrs = '') => {
  const { links } = scanLinks(body(`<p>Please confirm your billing details:</p><a href="${EVIL}"${attrs}>${inner}</a>`));
  expect(links).toHaveLength(1);
  return links[0]!.text;
};
const showsPaypal = (text: string) => {
  const v = scoreEmail('billing@attacker.example', 'Please confirm your billing details:', [{ text, href: EVIL }]);
  expect(v.reasons).toContain('A link says www.paypal.com but actually goes to evil.example');
};

describe('link text is the text the reader sees', () => {
  const cases: [string, string, string?][] = [
    ['a display:none splitter', 'https://<span style="display:none">x </span>www.paypal.com/signin'],
    ['a font-size:0 space', 'https://www.paypal<span style="font-size:0"> </span>.com/signin'],
    ['a visibility:hidden splitter', 'www.<span style="visibility:hidden">x y</span>paypal.com'],
    ['an opacity:0 splitter', 'www.pay<span style="opacity:0">-</span>pal.com'],
    ['a [hidden] splitter', 'www.paypal<span hidden> </span>.com'],
    ['a splitter hidden by a stylesheet class', '<style>.z{display:none}</style>www.paypal<b class="z">, see</b>.com'],
    ['reversed text in <bdo dir=rtl>', '<bdo dir="rtl">nignis/moc.lapyap.www//:sptth</bdo>'],
    ['reversed text in a bidi-override span', '<span style="unicode-bidi:bidi-override;direction:rtl">moc.lapyap.www</span>'],
    ['reversed text under U+202E', '\u202emoc.lapyap.www\u202c'],
    ['reversed text on the link itself', 'moc.lapyap.www', ' style="unicode-bidi: bidi-override; direction: rtl"'],
    // Look-alike dots NFKC or the fold turn into '.', split by a hidden node.
    ['a splitter before a one-dot leader (U+2024)', 'www<span hidden>x</span>\u2024paypal\u2024com'],
    ['a splitter before a small full stop (U+FE52)', 'www.paypal<span hidden>x</span>\ufe52com'],
    ['a splitter before a Lisu letter tone (U+A4F8)', 'www.paypal<span hidden> </span>\ua4f8com'],
    ['a splitter between a dot node and a letter node', 'www.paypal<span>.</span><span hidden> </span><span>com</span>'],
  ];
  for (const [label, inner, attrs] of cases) {
    it(`shows the host behind ${label}`, () => showsPaypal(textOfOnlyLink(inner, attrs)));
  }

  it('shows the host when the link sits inside an RTL override', () => {
    const { links } = scanLinks(body(`<bdo dir="rtl"><a href="${EVIL}">moc.lapyap.www</a></bdo>`));
    showsPaypal(links[0]!.text);
  });

  it('shows the host when a stylesheet class sets the override around the link', () => {
    const css = '<style>.r{unicode-bidi:bidi-override;direction:rtl}</style>';
    const { links } = scanLinks(body(`${css}<div class="r"><a href="${EVIL}">moc.lapyap.www</a></div>`));
    showsPaypal(links[0]!.text);
  });

  it("reads a frame body's whole document for style sheets (an email rendered in its own document)", () => {
    document.head.innerHTML = '<style>.r{unicode-bidi:bidi-override;direction:rtl}</style>';
    document.body.innerHTML = `<p class="r"><a href="${EVIL}">moc.lapyap.www</a></p>`;
    try {
      showsPaypal(scanLinks(document.body).links[0]!.text);
    } finally {
      document.head.innerHTML = '';
    }
  });

  it('shows a bare IPv4 address behind a hidden splitter', () => {
    const text = textOfOnlyLink('1<span hidden>x</span>92.168.10.1');
    const v = scoreEmail('billing@attacker.example', 'Please confirm your billing details:', [{ text, href: EVIL }]);
    expect(v.reasons).toContain('A link says 192.168.10.1 but actually goes to evil.example');
  });

  it('fails closed (truncated) past the style budget instead of reading later links as before', () => {
    const link = (n: number) => `<a href="${EVIL}">${'<span>www.</span>'.repeat(n)}paypal.com</a>`;
    expect(scanLinks(body(Array.from({ length: 10 }, () => link(100)).join(' '))).truncated).toBe(false);
    expect(scanLinks(body(Array.from({ length: 10 }, () => link(250)).join(' ')))).toMatchObject({
      truncated: true,
      truncatedBy: 'markup', // few links: their formatting, not their number, ended the check
    });
  });

  it('keeps an LTR override inside an RTL one in reading order', () => {
    showsPaypal(textOfOnlyLink('<bdo dir="rtl"><bdo dir="ltr">www.paypal.com</bdo></bdo>'));
  });

  it('keeps ordinary link text exactly as before', () => {
    expect(textOfOnlyLink('Visit <b>www.paypal.com</b> now')).toBe('Visit www.paypal.com now');
    expect(textOfOnlyLink('Reset <span style="color:red">password</span>')).toBe('Reset password');
  });

  it('keeps the raw text when only it shows another host (fail closed: either reading counts)', () => {
    const text = textOfOnlyLink('<span style="display:none">https://www.paypal.com/ </span>Log in');
    showsPaypal(text);
  });

  it('does not flag a link whose shown text matches its destination', () => {
    const { links } = scanLinks(
      body('<a href="https://shop.example/x">shop<span style="display:none">-tracking-</span>.example</a>'),
    );
    const v = scoreEmail('news@shop.example', 'Sale', links);
    expect(v.reasons.join(' ')).not.toMatch(/A link says/);
  });

  it('scores the audit email the same with and without the hidden splitter (Gmail)', () => {
    const page = (inner: string) => `<h2 class="hP">Billing</h2><div class="adn">
      <span class="gD" email="billing@attacker.example" name="Billing">Billing</span>
      <div class="a3s">Please confirm your billing details: <a href="${EVIL}">${inner}</a></div></div>`;
    const score = () => {
      const e = gmail.extract(document)!;
      return scoreEmail(e.senderAddress, e.body, e.links);
    };
    document.body.innerHTML = page('https://www.paypal.com/signin');
    const plain = score();
    document.body.innerHTML = page('https://<span style="display:none">x </span>www.paypal.com/signin');
    const hidden = score();
    expect(plain.reasons).toContain('A link says www.paypal.com but actually goes to evil.example');
    expect(hidden).toEqual(plain);
  });
});

describe('which link text can show a host once CSS leaves parts out (no style reads otherwise)', () => {
  it.each([
    [['Merino scarf'], 'a product name'],
    [['$19.99'], 'a price'],
    [['19,99 \u20ac'], 'a euro price'],
    [['Merino scarf', '$19.99', 'Shop now'], 'a product card'],
    [['\u00c9charpe en laine', '\u2605\u2605\u2605\u2605\u2606', '\u00a0', '4.5'], 'accents, stars, &nbsp; and a rating'],
    [['Merino scarf in wool\u2026', '$19.99'], 'an ellipsis'],
    [['Shop now.', 'New arrivals'], 'a sentence then more words (whitespace inside)'],
    [['Price:', '$19.99'], 'a label and a price'],
  ])('%j (%s) cannot', (nodes) => {
    expect(textCouldShowHost(nodes)).toBe(false);
  });

  it.each([
    [['www', '.', 'paypal', '.com']],
    [['paypal.', 'com']],
    [['www.paypal', 'x', '.com']],
    [['https:', 'x', '//evil.example']],
    [['Visit https://www.', 'paypal.com']],
    [['1', 'x', '92.168.0.1']],
    [['[', '::1]']],
    [['www\u2024paypal\u2024com']],
    [['(www', '.', 'paypal.com)']],
  ])('%j can', (nodes) => {
    expect(textCouldShowHost(nodes)).toBe(true);
  });

  // A retail newsletter: hundreds of product cards, each a table inside one <a>, with prices, &nbsp; and accents.
  const card = (n: number) => `
    <a href="https://shop.example/p/${n}">
      <table>
        <tr><td><img src="https://shop.example/i/${n}.jpg" alt=""></td></tr>
        <tr><td><span>\u00c9charpe m\u00e9rinos</span>&nbsp;<span>No ${n}</span></td></tr>
        <tr><td><span>$19.99</span> <s>29,99&nbsp;\u20ac</s> <span>\u2605\u2605\u2605\u2605\u2606</span></td></tr>
      </table>
    </a>`;

  it('checks a 300-card newsletter in full and reads no style for it', () => {
    const el = body(`<p>This week's picks</p>${Array.from({ length: 300 }, (_, i) => card(i)).join('')}`);
    const spy = vi.spyOn(window, 'getComputedStyle');
    try {
      const r = scanLinks(el);
      expect(r.truncated).toBe(false);
      expect(r.links).toHaveLength(300);
      expect(spy).not.toHaveBeenCalled();
      expect(scoreEmail('news@shop.example', "This week's picks", r.links).level).toBe('safe');
    } finally {
      spy.mockRestore();
    }
  });
});
