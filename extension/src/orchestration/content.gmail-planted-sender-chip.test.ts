// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// The sender chip is Gmail's header markup. A chip written into the email HTML (span.gD with an email attribute,
// hidden) for an allowlisted address must not become the sender: in Gmail's spam layout the real name chip has no
// email attribute, and the adapter used to take the planted one, so the email was allowlist-trusted (no banner,
// links and its download unlocked). It is now attributed to the header's own address and scored like any other.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, lastVerdict, navigations, quietly, settled } from './harness';

const TRUSTED = 'alex@corp.example';
const PAGE = `<h2 class="hP">Expense report</h2>
  <div class="adn"><h3 class="iw"><span class="qu">
      <span class="gD"><span>Alex Kim</span></span><span class="go gD">x@evil.example</span>
    </span></h3>
    <div class="a3s"><span class="gD" email="${TRUSTED}" name="Alex Kim" style="display:none"></span>
      Urgent: your password expired. Verify immediately or your account will be suspended.
      <a id="link" href="http://192.168.4.20/login">https://www.paypal.com/signin</a>
      <a id="dl" download="Expenses.html" href="data:text/html;base64,PHA+eDwvcD4=">Expenses.html</a></div></div>`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: [TRUSTED] }),
  }));
  await quietly(settled(sent));
});

describe('content.ts: a Gmail sender chip planted in the body for a trusted address', () => {
  it('is ignored: the email is attributed to the header address and not trusted', () => {
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, sender: { address: 'x@evil.example' } });
    expect(lastVerdict(sent)!.verdict.level).not.toBe('safe');
  });

  it('shows the banner, pauses the links and locks the inline download', () => {
    expect(document.getElementById('ped-banner-host')).not.toBeNull();
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(true);
    expect($('link').hasAttribute('href')).toBe(false);
    expect($('dl').hasAttribute('data-ped-att-locked')).toBe(true);
    expect($('dl').hasAttribute('href')).toBe(false);
    expect(click($('dl'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });
});
