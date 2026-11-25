// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// C6: click-time destination checks on an email that is NOT locked (safe body, untrusted sender). A click on a link
// to another site is cancelled and decided at click time: the destination's registrable domain (and nothing else)
// is looked up, then the link is opened through the background (openSafeLink) or sent to the warning page
// (openWarning). The href is read at click time, so a link the webmail rewrites to a redirect wrapper after the
// scan (Gmail swaps in google.com/url?q=... when a link is clicked) is unwrapped and checked as it is then.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  $,
  type Msg,
  bootContent,
  click,
  gmailMessage,
  lastVerdict,
  lookups,
  navigations,
  settled,
  until,
} from './harness';

const NXDOMAIN = {
  domain: 'contoso-files.example',
  checkedAt: new Date().toISOString(),
  rdap: { status: 'notfound' },
  dns: { status: 'ok', mx: [], nxdomain: true },
  reputation: { status: 'ok', source: 'URIBL', listed: [] },
};

const PAGE = gmailMessage({
  name: 'Jordan Lee',
  email: 'jordan@northwind.example',
  subject: 'Notes',
  body: `Hi team, my <a id="docs" href="https://docs.contoso.example/notes?id=42#top">notes</a> from Tuesday,
    the <a id="share" href="https://northwind.example/share">shared folder</a> and the
    <a id="files" href="https://contoso-files.example/q3">Q3 files</a>. Thanks!`,
});

let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE, {
    // Only the click-time lookup of contoso-files.example has a finding; every other lookup is unavailable.
    intel: (domain: unknown) => (domain === 'contoso-files.example' ? NXDOMAIN : undefined),
  }));
  await settled(sent);
});

describe('content.ts: click-time checks on an unlocked email', () => {
  it('scores the email safe and leaves it unlocked', () => {
    expect(lastVerdict(sent)).toMatchObject({ verdict: { level: 'safe' }, trusted: false });
    expect(document.querySelector('div.a3s')!.hasAttribute('data-ped-locked')).toBe(false);
    expect(lookups(sent)).toEqual(['northwind.example']); // the sender's domain only, so far
  });

  it('cancels a click to another site, looks up its registrable domain only, then opens it via the background', async () => {
    const mark = sent.length;
    expect(click($('docs'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(lookups(sent, mark)).toEqual(['contoso.example']); // no subdomain, path, query or fragment
    expect(navigations(sent, mark)).toEqual([
      { type: 'openSafeLink', href: 'https://docs.contoso.example/notes?id=42#top', active: true },
    ]);
  });

  it('opens a ctrl-click in a background tab', async () => {
    const mark = sent.length;
    expect(click($('docs'), { ctrlKey: true })).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({ type: 'openSafeLink', active: false });
  });

  it('sends a link rewritten to a redirect wrapper around a numeric address to the warning page', async () => {
    $('share').setAttribute('href', 'https://www.google.com/url?q=http://192.0.2.10/login&sa=D');
    const mark = sent.length;
    expect(click($('share'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(navigations(sent, mark)[0]).toMatchObject({
      type: 'openWarning',
      href: 'http://192.0.2.10/login',
      host: '192.0.2.10',
      level: 'danger',
    });
    expect((navigations(sent, mark)[0]!.reasons as string[]).join(' ')).toMatch(/numeric web address/);
    expect(lookups(sent, mark)).toEqual([]); // decided locally: a numeric address is never looked up
  });

  it('sends a link whose destination lookup reports a non-existent domain to the warning page', async () => {
    const mark = sent.length;
    expect(click($('files'))).toBe(true);
    await until(() => expect(navigations(sent, mark)).toHaveLength(1));
    expect(lookups(sent, mark)).toEqual(['contoso-files.example']);
    const [warning] = navigations(sent, mark);
    expect(warning).toMatchObject({
      type: 'openWarning',
      href: 'https://contoso-files.example/q3',
      registrable: 'contoso-files.example',
      level: 'danger',
      intel: { domain: 'contoso-files.example' },
    });
    expect(warning!.reasons).toContain('This destination website (contoso-files.example) does not exist');
  });
});
