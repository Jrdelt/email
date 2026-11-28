// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// An email with a few links whose text is split by so much markup that working out what the reader sees would use up
// the style budget: it fails closed (links paused), and the notice names the link formatting, not "too many links".
import { beforeAll, describe, expect, it } from 'vitest';
import { type Msg, bootContent, gmailMessage, lastVerdict, quietly, settled } from './harness';

const link = () => `<a href="https://northwind.example/x">${'<span>www.</span>'.repeat(250)}northwind.example</a>`;
const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Links',
  body: `Hi, the links: ${Array.from({ length: 10 }, link).join(' ')}`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await quietly(settled(sent));
});

describe('content.ts: an email whose link formatting is too much to check', () => {
  it('fails closed with a notice about the formatting', () => {
    expect(lastVerdict(sent)).toMatchObject({
      verdict: {
        level: 'suspicious',
        unchecked: true,
        reasons: ['This email has too much link formatting to check every link, so its links are paused'],
      },
    });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(true);
  });
});
