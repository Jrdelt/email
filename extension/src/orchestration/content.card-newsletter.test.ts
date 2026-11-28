// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// A retail newsletter whose product cards are each a whole <table> inside one <a>, with prices, &nbsp; and accented
// names. Its link text can show no host however CSS renders it, so the rendered-link-text check reads no styles for
// it and the email is checked in full: safe, links open (it used to run out of the style budget and fail closed as
// "too many links").
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, gmailMessage, lastVerdict, settled } from './harness';

const card = (n: number) => `
  <a href="https://shop.example/item/${n}">
    <table>
      <tr><td><img src="https://shop.example/i/${n}.jpg" alt=""></td></tr>
      <tr><td><span>Maison</span>&nbsp;<span>Écharpe ${n}</span></td></tr>
      <tr><td><span>USD ${n}.99</span>&nbsp;<s>${n + 10},99&nbsp;€</s></td></tr>
    </table>
  </a>`;
const PAGE = gmailMessage({
  name: 'Shop',
  email: 'news@shop.example',
  subject: "This week's picks",
  body: `Hello, here are this week's picks.${Array.from({ length: 200 }, (_, i) => card(i)).join('')}`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

describe('content.ts: a card-style newsletter', () => {
  it('scores safe, fully checked, with its links open', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(lastVerdict(sent)?.verdict.unchecked).toBeUndefined();
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });
});
