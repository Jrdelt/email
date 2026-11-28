// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://outlook.live.com/mail/0/"}
// In an M365 tenant every link is rewritten to Microsoft Defender Safe Links, whose time-of-click check, block page
// and click log are the organisation's second layer. The click guard checks the destination behind the wrapper, and
// links it lets through still open through the wrapper (openSafeLink gets the clicked URL). A link it stops opens
// warning.html, whose "Open anyway" must go through the wrapper too: the content script passes the clicked URL
// along as `via` (nothing new: it is what the user clicked), next to the destination it checked.
import { beforeAll, describe, expect, it } from 'vitest';
import type { DomainIntel } from '../domainIntel';
import { $, type Msg, bootContent, click, navigations, quietly, tick, until } from './harness';

const ADDRESS = 'news@northwind.example';
const safeLinks = (target: string) =>
  `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(target)}&data=05%7C01%7C&reserved=0`;
const RISKY = safeLinks('http://news.example.org/offer'); // unencrypted: stopped locally ("Check where this link goes")
const UNKNOWN = safeLinks('https://deals.fresh-offers.net/spring'); // stopped by the destination lookup
const PAGE = `<div data-app-section="ConversationContainer">
  <div aria-label="Email message"><span class="OZZZK">Northwind News &lt;${ADDRESS}&gt;</span>
    <div aria-label="Message body" id="body">Hi, our spring newsletter is out. Read the
      <a id="risky" href="${RISKY}">offer</a> or the <a id="unknown" href="${UNKNOWN}">deals</a>. Thanks!</div>
  </div></div>`;

const NXDOMAIN: DomainIntel = {
  domain: 'fresh-offers.net',
  checkedAt: new Date().toISOString(),
  rdap: { status: 'notfound' },
  dns: { status: 'ok', mx: [], nxdomain: true },
  reputation: { status: 'ok', source: 'URIBL', listed: [] },
} as unknown as DomainIntel;

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    intel: (domain: unknown) => (domain === 'fresh-offers.net' ? NXDOMAIN : undefined),
  }));
  await quietly(until(() => expect(sent.some((m) => m.type === 'verdict')).toBe(true)));
  await tick();
});

describe('content.ts: a stopped Safe Links link keeps its gateway for "Open anyway"', () => {
  it('sends the checked destination and the clicked gateway URL to the warning page', async () => {
    const mark = sent.length;
    expect(click($('risky'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({
      type: 'openWarning',
      href: 'http://news.example.org/offer',
      via: RISKY,
    });
  });

  it('does the same for a link the destination lookup escalates', async () => {
    const mark = sent.length;
    expect(click($('unknown'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({
      type: 'openWarning',
      href: 'https://deals.fresh-offers.net/spring',
      via: UNKNOWN,
    });
  });
});
