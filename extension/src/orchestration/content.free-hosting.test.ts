// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// A safe-scoring, unlocked email links to a site on a free hosting service (<site>.pages.dev). The registrable domain
// is pages.dev, whose clean, years-old record says nothing about who runs the site, so the click must not be cleared
// by that lookup: it goes to the warning page (src/linkGuard.ts freeSiteSuffix) and nothing is looked up for it.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, click, gmailMessage, lastVerdict, lookups, navigations, settled, until } from './harness';

// What a lookup of the platform's own domain would answer: old, has mail, not listed.
const AGED_PLATFORM = {
  domain: 'pages.dev',
  checkedAt: new Date().toISOString(),
  rdap: { status: 'ok', registered: '2019-02-05T00:00:00Z' },
  dns: { status: 'ok', mx: ['mx.example'], nxdomain: false },
};

const PAGE = gmailMessage({
  name: 'File Share',
  email: 'files@northwind.example',
  subject: 'A document was shared with you',
  body: 'A document was shared with you. <a id="doc" href="https://account-verify-demo.pages.dev/login">Open document</a>',
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, { intel: (domain: unknown) => (domain === 'pages.dev' ? AGED_PLATFORM : undefined) }));
  await settled(sent);
});

describe('content.ts: a link to a site on a free hosting service', () => {
  it('leaves the safe-scoring email unlocked', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
  });

  it('sends the click to the warning page without vouching for it through the platform domain', async () => {
    const mark = sent.length;
    expect(click($('doc'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    const [warning] = navigations(sent, mark);
    expect(warning).toMatchObject({
      type: 'openWarning',
      href: 'https://account-verify-demo.pages.dev/login',
      host: 'account-verify-demo.pages.dev',
      registrable: 'pages.dev',
      level: 'warning',
    });
    expect((warning!.reasons as string[]).join(' ')).toMatch(/free hosting service \(pages\.dev\)/);
    expect(lookups(sent, mark)).toEqual([]);
  });
});
