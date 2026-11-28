// @vitest-environment happy-dom
// The text/destination mismatch check reads a link's text: it must be the text the reader sees. Hidden splitters
// (display:none, font-size:0, a stylesheet class), a reversed string under an RTL bidi override (<bdo dir=rtl>,
// unicode-bidi:bidi-override, U+202E) made a link that shows https://www.paypal.com/signin look like no host at all.
import { describe, expect, it } from 'vitest';
import { scoreEmail } from '../features';
import { scanLinks } from './extract';
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

  it('fails closed (truncated) past the style budget instead of reading later links as before', () => {
    const link = (n: number) => `<a href="${EVIL}">${'<span>www.</span>'.repeat(n)}paypal.com</a>`;
    expect(scanLinks(body(Array.from({ length: 10 }, () => link(100)).join(' '))).truncated).toBe(false);
    expect(scanLinks(body(Array.from({ length: 10 }, () => link(250)).join(' '))).truncated).toBe(true);
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
