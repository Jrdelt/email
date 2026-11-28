// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://mail.google.com/mail/u/0/#inbox"}
// An untrusted email's attachments are always blocked (AGENTS.md), however the adapter found them. Here Gmail's
// attachment chips and shelf are not recognised (say, after a markup change), but its "Download all attachments"
// control is: the adapter reports it as an attachment control only (attachmentContainers, no named attachment).
// It must be locked like any attachment, with the attachment notice, not left clickable.
import { beforeAll, describe, expect, it } from 'vitest';
import { $, type Msg, bootContent, captureBanner, click, lastVerdict, settled } from './harness';

const PAGE = `<h2 class="hP">Photos from Saturday</h2>
  <div class="adn"><span class="gD" email="jordan@northwind.example" name="Jordan Lee">Jordan Lee</span>
    <div class="a3s">Hi, here are the photos from Saturday. Thanks!</div>
    <div class="unrecognised-shelf"><span class="unrecognised-chip">IMG_0412.jpg</span>
      <div id="all" role="button" aria-label="Download all attachments">Download all</div></div></div>`;

const banner = captureBanner();
let sent: Msg[];

beforeAll(async () => {
  ({ sent } = await bootContent(PAGE));
  await settled(sent);
});

describe('content.ts: an email whose only recognised attachment control is "Download all"', () => {
  it('counts it as an attachment of the untrusted email', () => {
    expect(lastVerdict(sent)).toMatchObject({ trusted: false, attachments: { count: 1 } });
    expect(banner.root(), 'attachment notice').not.toBeNull();
  });

  it('blocks the control', () => {
    expect($('all').hasAttribute('data-ped-att-locked')).toBe(true);
    expect(click($('all'))).toBe(true);
  });
});
