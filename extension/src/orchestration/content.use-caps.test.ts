// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Click-time checks for links an SVG <use> renders, on an email that is NOT locked. A click on a <use> instance is
// retargeted to the <use> element, so the guard works out which link it renders (src/dom.ts useLinks). That walk is
// bounded, but the browser renders every link however many or deeply nested: when the walk stops at a bound, or
// cannot tell which of several links was clicked, the click is paused (fail closed) instead of going through
// unchecked or being checked against the wrong link.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, navigations, settled, tick, until } from './harness';

const EVIL = 'https://files.example/invoice.exe';
const filler = '<a href="https://shop.example/p"><rect width="1" height="1"/></a>'.repeat(20);
const deep = Array.from({ length: 4 }, (_, i) => `<g id="d${i + 1}"><use href="#${i ? `d${i}` : 'd0'}"/></g>`).join('');

const PAGE = gmailMessage({
  name: 'Shop',
  email: 'news@shop.example',
  subject: 'Newsletter',
  body: `Hello, your monthly newsletter.
    <svg width="400" height="100"><defs>
      <g id="wide">${filler}<a href="${EVIL}"><rect width="400" height="100"/></a></g>
      <a id="d0" href="${EVIL}"><rect width="400" height="100"/></a>${deep}
      <g id="gap"><a><rect width="1" height="1"/></a><a href="${EVIL}"><rect width="400" height="100"/></a></g>
      <a id="one" href="${EVIL}"><rect width="400" height="100"/></a>
      <a id="own" href="https://shop.example/sale"><rect width="400" height="100"/></a>
      <use id="via" href="#one"/>${Array.from({ length: 5 }, (_, i) => `<use id="c${i + 1}" href="#${i ? `c${i}` : 'one'}"/>`).join('')}
      <g id="mixed"><a href="https://mail.google.com/mail/u/0/#x"><rect width="400" height="50"/></a><rect y="80" width="400" height="20"/></g>
    </defs>
    <use id="wide21" href="#wide"/><use id="deep5" href="#d4"/><use id="hrefless" href="#gap"/>
    <use id="use1" href="#one"/><use id="same" href="#own"/><use id="useuse" href="#via"/><use id="chain6" href="#c5"/>
    <a><use id="wrapNoHref" href="#one"/></a><a href="#top"><use id="wrapHash" href="#one"/></a>
    <a href="https://mail.google.com/mail/u/0/#x"><use id="wrapSameOrigin" href="#one"/></a>
    <a href="${EVIL}"><use id="outerEvilInnerSafe" href="#mixed"/></a></svg>
    <a><svg><use id="wrapHtmlNoHref" href="#one"/></svg></a><a href="#top"><svg><use id="wrapHtmlHash" href="#one"/></svg></a>`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

const toast = () => document.getElementById('ped-toast-host');
const clearToast = () => toast()?.remove();

describe('content.ts: clicks on SVG <use> instances of links in an unlocked email', () => {
  it('scores the email safe and leaves it unlocked', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('checks the one link behind a single <use> at click time', async () => {
    const mark = sent.length;
    expect(click($('use1'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: EVIL });
  });

  it('lets a same-site link behind a <use> through natively', () => {
    expect(click($('same'))).toBe(false);
  });

  it('pauses a click on a <use> that renders more links than the guard follows', async () => {
    clearToast();
    const mark = sent.length;
    expect(click($('wide21'))).toBe(true);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
    expect(toast()).not.toBeNull();
  });

  it('pauses a click on a link behind more nested <use> levels than the guard follows', async () => {
    clearToast();
    const mark = sent.length;
    expect(click($('deep5'))).toBe(true);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
    expect(toast()).not.toBeNull();
  });

  it('checks the link that has a target, not a link-free one before it', async () => {
    const mark = sent.length;
    expect(click($('hrefless'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: EVIL });
  });

  it('checks a link behind a <use> that references another <use>', async () => {
    const mark = sent.length;
    expect(click($('useuse'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: EVIL });
  });

  it('pauses a click on a direct <use> chain longer than the guard follows', async () => {
    clearToast();
    const mark = sent.length;
    expect(click($('chain6'))).toBe(true);
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
    expect(toast()).not.toBeNull();
  });

  // The browser activates the link the instance renders, not the <a> around the <use>.
  it.each(['wrapNoHref', 'wrapHash', 'wrapHtmlNoHref', 'wrapHtmlHash'])(
    'checks the link a <use> renders inside an <a> that navigates nowhere (%s)',
    async (id) => {
      const mark = sent.length;
      expect(click($(id))).toBe(true);
      await until(() => expect(navigations(sent, mark)).toHaveLength(1));
      expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openWarning', href: EVIL });
    },
  );

  // Either the wrapper or the rendered link may navigate, depending on where the click lands: never guess.
  it.each(['wrapSameOrigin', 'outerEvilInnerSafe'])(
    'pauses a click on a <use> whose wrapper and rendered link go to different places (%s)',
    async (id) => {
      clearToast();
      const mark = sent.length;
      expect(click($(id))).toBe(true);
      await tick();
      expect(navigations(sent, mark)).toEqual([]);
      expect(toast()).not.toBeNull();
    },
  );
});
