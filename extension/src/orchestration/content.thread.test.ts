// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C9: a Gmail conversation with several open messages (one div.adn wrapper each). One of them is phishing; the
// warning pauses the links of every untrusted message in the thread, not only the flagged one (a phishing reply can
// point at a benign-looking earlier message). A message from an allowlisted sender stays unlocked.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, fakeBrowser, lastVerdict, lookups, navigations, settled } from './harness';

const message = (o: { id: string; name: string; email: string; body: string }) =>
  `<div class="adn"><span class="gD" email="${o.email}" name="${o.name}">${o.name}</span>
    <div class="a3s" id="${o.id}">${o.body}</div></div>`;

const PAGE = `<h2 class="hP">Quarterly review</h2>
  ${message({
    id: 'trusted',
    name: 'Alex Kim',
    email: 'alex@corp.example',
    body: 'Adding the <a id="l0" href="https://corp.example/review">review page</a>.',
  })}
  ${message({
    id: 'benign',
    name: 'Jordan Lee',
    email: 'jordan@northwind.example',
    body: 'Hi team, the <a id="l1" href="https://northwind.example/agenda">agenda</a> is on the wiki. Thanks!',
  })}
  ${message({
    id: 'phish',
    name: 'PayPal Support',
    email: 'help@paypa1-secure.example',
    body: `Your PayPal account is locked. Verify your password now or it will be suspended.
      <a id="l2" href="https://evil.example/login">www.paypal.com</a>`,
  })}`;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    beforeMain: () => fakeBrowser.storage.local.set({ trustedSenders: ['alex@corp.example'] }),
  }));
  await settled(sent);
});

const locked = (id: string) => $(id).hasAttribute('data-ped-locked');

describe('content.ts: Gmail thread with a benign and a phishing message', () => {
  it('reports the phishing message as the thread verdict and looks up each untrusted sender domain', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: { level: 'likely-phishing' },
      sender: { address: 'help@paypa1-secure.example' },
      trusted: false,
    });
    expect([...lookups(sent)].sort()).toEqual(['northwind.example', 'paypa1-secure.example']);
  });

  it('locks both untrusted messages, the benign one included', () => {
    expect(locked('phish')).toBe(true);
    expect(locked('benign')).toBe(true);
    expect($('l1').hasAttribute('href')).toBe(false);
    expect($('l2').hasAttribute('href')).toBe(false);
    expect(click($('l1'))).toBe(true);
    expect(click($('l2'))).toBe(true);
    expect(navigations(sent)).toEqual([]);
  });

  it('leaves the allowlisted sender message unlocked', () => {
    expect(locked('trusted')).toBe(false);
    expect($('l0').getAttribute('href')).toBe('https://corp.example/review');
    expect(click($('l0'))).toBe(false); // a same-site link of an unlocked message goes through natively
  });
});
