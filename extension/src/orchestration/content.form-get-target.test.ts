// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// Where a form submission really goes, on an email that is NOT locked. The click-time check must look at the URL the
// browser requests, not at the action attribute alone:
// - a GET submission replaces the action's query with the form's fields (the submitter's own name/value included),
//   so a redirect target in a hidden field (Bing /ck/a u=, Google /url q=, Safe Links url=) is the destination;
// - method/formmethod is an enumerated attribute matched without trimming: " dialog" is GET, not "dialog";
// - only ASCII whitespace is stripped from action/formaction: "&nbsp;" is a relative URL resolved against <base>.
// The warning page is never given a field value: a GET form's URL is sent without its query, and never as `via`.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { $, type Msg, bootContent, gmailMessage, lastVerdict, lookups, navigations, settled, submit, tick, until } from './harness';

const DAY = 86_400_000;
const aged = (domain: string) => ({
  domain,
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: new Date(Date.now() - 900 * DAY).toISOString() },
  dns: { status: 'ok', mx: ['mx.example.net'], nxdomain: false },
});
const intel = (domain: unknown) =>
  domain === 'evil.example'
    ? { ...aged('evil.example'), rdap: { status: 'notfound' }, dns: { status: 'ok', mx: [], nxdomain: true } }
    : aged(String(domain));

const EVIL_ZIP = 'https://evil.example/f.zip';
const BING_EVIL = 'a1aHR0cHM6Ly9ldmlsLmV4YW1wbGUvZi56aXA'; // a1 + base64url(EVIL_ZIP)
const BING_SHOP = 'a1aHR0cHM6Ly9zaG9wLmV4YW1wbGUvc2FsZQ'; // a1 + base64url('https://shop.example/sale')

const PAGE =
  // An email can carry a <base> (an iCloud message frame is the email itself); relative actions resolve against it.
  '<base href="https://evil.example/d/">' +
  gmailMessage({
    name: 'Shop',
    email: 'news@shop.example',
    subject: 'Your order',
    body: `Hello, your order has shipped.
    <form id="bing" action="https://www.bing.com/ck/a" method="get">
      <input type="hidden" name="u" value="${BING_EVIL}"><input type="hidden" name="ntb" value="1">
      <button id="bing-go">View document</button></form>
    <form id="google" action="https://www.google.com/url">
      <input type="hidden" name="q" value="https://evil.example/g.zip"><button id="google-go">Open</button></form>
    <form id="btn" action="https://www.bing.com/ck/a" method="GET"><input type="hidden" name="ntb" value="1">
      <button id="btn-go" name="u" value="${BING_EVIL}">View</button></form>
    <form id="ownq" action="https://www.google.com/url?q=https://shop.example/sale" method="get">
      <input type="hidden" name="q" value="https://evil.example/q.zip"><button id="ownq-go">Shop</button></form>
    <form id="fm" action="https://www.bing.com/ck/a?u=${BING_SHOP}" method="post">
      <input type="hidden" name="u" value="${BING_EVIL}"><button id="fm-go" formmethod="get">Go</button></form>
    <form id="pw" action="http://shop.example/login" method="get">
      <input type="password" name="pw" value="hunter2"><button id="pw-go">Sign in</button></form>
    <form id="sl" action="https://nam12.safelinks.protection.outlook.com/" method="get">
      <input type="hidden" name="url" value="${EVIL_ZIP}"><input type="password" name="pw" value="hunter2">
      <button id="sl-go">Sign in</button></form>
    <form id="d1" action="https://files.example/a.exe" method=" dialog"><button id="d1-go">Close</button></form>
    <form id="d2" action="https://files.example/b.exe" method="dialog&#10;"><button id="d2-go">Close</button></form>
    <form id="d3" action="https://files.example/c.exe" method="post">
      <button id="d3-go" formmethod="dialog ">Close</button></form>
    <form id="nb" action="&nbsp;" method="post"><input name="q" value="secret"><button id="nb-go">Submit</button></form>
    <form id="nbf" action="https://shop.example/ok" method="post">
      <button id="nbf-go" formaction="&nbsp;">Submit</button></form>
    <form id="nbs" action="&nbsp;https://mail.google.com/x.zip" method="post"><button id="nbs-go">Submit</button></form>
    <form id="plain" action="https://northwind.example/survey" method="get">
      <input name="rating" value="5"><button id="plain-go">Send</button></form>`,
  });

let sent: Msg[];
const resubmitted: string[] = [];

beforeAll(async () => {
  vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
    resubmitted.push(this.id);
  });
  ({ sent } = await bootContent(PAGE, { intel }));
  await settled(sent);
});

const warned = async (form: string, submitter: string) => {
  const mark = sent.length;
  expect(submit($(form), $(submitter)), 'cancelled').toBe(true);
  await until(() => expect(navigations(sent, mark)).toHaveLength(1));
  return { msg: navigations(sent, mark)[0]!, all: JSON.stringify(sent.slice(mark)), mark };
};

describe('content.ts: the URL a form submission really requests', () => {
  it('scores the email safe and leaves it unlocked', () => {
    expect(document.baseURI).toBe('https://evil.example/d/');
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('unwraps a Bing /ck/a target sent in a hidden field of a GET form', async () => {
    const { msg } = await warned('bing', 'bing-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: EVIL_ZIP, level: 'warning', kind: 'form' });
    expect(msg).not.toHaveProperty('via');
  });

  it('unwraps a Google /url q= target sent in a field (method defaults to GET)', async () => {
    const { msg } = await warned('google', 'google-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: 'https://evil.example/g.zip', kind: 'form' });
  });

  it("includes the submit button's own name and value", async () => {
    const { msg } = await warned('btn', 'btn-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: EVIL_ZIP });
  });

  it("ignores the action's own query, which a GET submission replaces", async () => {
    const { msg } = await warned('ownq', 'ownq-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: 'https://evil.example/q.zip' });
  });

  it("follows the submitter's formmethod=get over the form's method=post", async () => {
    const { msg } = await warned('fm', 'fm-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: EVIL_ZIP });
  });

  it("never sends a GET form's field values to the warning page", async () => {
    const { msg, all } = await warned('pw', 'pw-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: 'http://shop.example/login', level: 'warning' });
    expect(msg).not.toHaveProperty('via');
    expect(all).not.toContain('hunter2');
  });

  it('never sends a Safe Links GET form (with a password field) as `via`', async () => {
    const { msg, all } = await warned('sl', 'sl-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: EVIL_ZIP });
    expect(msg).not.toHaveProperty('via');
    expect(all).not.toContain('hunter2');
  });

  it.each([
    ['d1', 'd1-go', 'https://files.example/a.exe'],
    ['d2', 'd2-go', 'https://files.example/b.exe'],
    ['d3', 'd3-go', 'https://files.example/c.exe'],
  ])('checks a form whose method is a padded "dialog" (%s), which the browser submits', async (form, button, href) => {
    const { msg } = await warned(form, button);
    expect(msg).toMatchObject({ type: 'openWarning', href: expect.stringContaining(href), level: 'danger' });
  });

  it('resolves action="&nbsp;" against the base URL, not as "this page"', async () => {
    const { msg, all } = await warned('nb', 'nb-go');
    expect(lookups(sent).at(-1)).toBe('evil.example');
    expect(msg).toMatchObject({ type: 'openWarning', href: 'https://evil.example/d/%C2%A0', level: 'danger' });
    expect(all).not.toContain('secret');
  });

  it('resolves formaction="&nbsp;" against the base URL too', async () => {
    const { msg } = await warned('nbf', 'nbf-go');
    expect(msg).toMatchObject({ type: 'openWarning', href: 'https://evil.example/d/%C2%A0' });
  });

  it('does not strip a leading &nbsp; off an absolute action', async () => {
    const { msg } = await warned('nbs', 'nbs-go');
    expect(msg).toMatchObject({ type: 'openWarning', registrable: 'evil.example' });
  });

  it('submits a GET form again once its real destination checks out', async () => {
    const mark = sent.length;
    expect(submit($('plain'), $('plain-go'))).toBe(true);
    await until(() => expect(resubmitted).toEqual(['plain']));
    expect(lookups(sent, mark)).toEqual(['northwind.example']);
    expect(navigations(sent, mark)).toEqual([]);
  });

  it('pauses a GET submission whose fields cannot be read, rather than letting it through', async () => {
    document.getElementById('ped-toast-host')?.remove();
    const mark = sent.length;
    const original = globalThis.FormData;
    globalThis.FormData = class {
      constructor() {
        throw new TypeError('no fields');
      }
    } as unknown as typeof FormData;
    try {
      expect(submit($('plain'), $('plain-go'))).toBe(true);
    } finally {
      globalThis.FormData = original;
    }
    await tick();
    expect(navigations(sent, mark)).toEqual([]);
    expect(document.getElementById('ped-toast-host'), '"paused" notice').not.toBeNull();
  });
});
