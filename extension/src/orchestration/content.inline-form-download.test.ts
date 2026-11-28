// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// A form that submits to a data: (or blob:) URL is an inline download: Chromium saves a non-renderable data:
// response as a file. On an untrusted email it is attachment-locked like <a href="data:..."> (AGENTS.md: inline
// data:/blob: downloads are always blocked), even when the body scores safe and shows no banner: the form (for
// `action`) or the submitting control (for `formaction`) is locked, its target stashed, and submit, click and Enter
// are cancelled. An ordinary https form stays usable.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, press, settled, submit, tick } from './harness';

const DATA = 'data:application/zip;base64,TVqQAAMAAAAEAAAA';
const PAGE = gmailMessage({
  name: 'Shop billing',
  email: 'billing@shop.example',
  subject: 'Your statement',
  body: `Hello, your monthly statement is ready.
    <form id="f1" action="${DATA}" method="post"><button id="b1">Download your statement</button></form>
    <form id="f2" method="post"><input id="q2" name="q"><button id="b2" formmethod="post" formaction=" da&#10;ta:application/zip;base64,TVqQ">Download</button></form>
    <form id="f3" action="${DATA}" method="post"><input name="getAttribute"><input name="hasAttribute"><input name="closest"></form>
    <form id="f4" action="BLOB:https://mail.google.com/0b1c" method="post"><input type="submit" id="b4" value="Get it"></form>
    <form id="ok" action="https://shop.example/search"><input name="q"><button id="go">Search</button></form>`,
});

// Through the prototype: the f3 form's named controls shadow its own hasAttribute/getAttribute.
const has = (el: Element, attr: string): boolean => Element.prototype.hasAttribute.call(el, attr);

let sent: Msg[];
beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

describe('content.ts: data:/blob: form downloads in an untrusted, safe-scoring email', () => {
  it('reports them as locked attachments on a safe body with no link lock', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'safe' },
      attachments: { count: 4, level: 'locked' },
      trusted: false,
    });
    expect(has(document.querySelector('div.a3s')!, 'data-ped-locked')).toBe(false);
  });

  it('locks a form whose action is a data:/blob: URL: marked, action stashed, submit/click/Enter cancelled', () => {
    for (const id of ['f1', 'f3', 'f4']) {
      expect(has($(id), 'data-ped-att-locked'), id).toBe(true);
      expect(has($(id), 'action'), id).toBe(false);
      expect(submit($(id)), id).toBe(true);
    }
    expect(click($('b1'))).toBe(true);
    expect(press($('b1'), 'Enter')).toBe(true);
    expect(click($('b4'))).toBe(true);
  });

  it('locks a control whose formaction is a data: URL (in any spelling the URL parser accepts)', () => {
    const b2 = $('b2');
    expect(has(b2, 'data-ped-att-locked')).toBe(true);
    expect(has(b2, 'formaction')).toBe(false);
    expect(click(b2)).toBe(true);
    expect(press(b2, 'Enter')).toBe(true);
  });

  it('leaves an ordinary https form alone', () => {
    expect(has($('ok'), 'data-ped-att-locked')).toBe(false);
    expect($('ok').getAttribute('action')).toBe('https://shop.example/search');
    expect(submit($('ok'))).toBe(false);
  });

  it('re-stashes a data: action written back onto a locked form', async () => {
    $('f1').setAttribute('action', DATA);
    await tick();
    expect(has($('f1'), 'action')).toBe(false);
  });
});
