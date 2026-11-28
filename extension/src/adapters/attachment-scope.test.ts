// @vitest-environment happy-dom
// Native attachment shelves and cards are webmail chrome beside the body, never inside it: ordinary links and
// markup in the email HTML ("Download on the App Store", ?view=attendees) must not become blocked attachments.
// Real inline downloads keep coming from inlineAttachmentsIn.
import { describe, expect, it } from 'vitest';
import { gmail } from './gmail';
import { outlook } from './outlook';
import { proton } from './proton';
import { yahoo } from './yahoo';
import type { ExtractedEmail } from './types';

const ids = (e: ExtractedEmail) => ({
  att: e.attachments?.map((a) => a.element.id) ?? [],
  containers: e.attachmentContainers?.map((c) => c.id) ?? [],
});
const INLINE = '<a id="inline" download="manual.pdf" href="data:application/pdf;base64,AA==">manual.pdf</a>';

describe('attachment chips are never read from inside the message body', () => {
  it('Outlook: body "Download ..." links and attachment-like markup are not attachments; the real card still is', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer"><div aria-label="Email message">
      <span class="OZZZK">Shop News&lt;news@shop.example&gt;</span>
      <div aria-label="Message body" id="body">
        <a id="badge" aria-label="Download on the App Store" href="https://apps.apple.com/app/id1">App Store</a>
        <button id="guide" aria-label="Download the guide">Guide</button>
        <div data-testid="attachment-preview" id="fake">x</div>
        <div class="AttachmentWell" id="fakewell"><a id="fakecard" aria-label="Attached file x.pdf" href="https://shop.example/x">x</a></div>
        ${INLINE}</div>
      <div role="listitem" aria-label="Attached file minutes.pdf" id="att"><button>minutes.pdf</button></div></div></div>`;
    expect(ids(outlook.extract(document)!)).toEqual({ att: ['inline', 'att'], containers: [] });
  });

  it('Gmail: a ?view=attendees body link and shelf classes in the body are not attachments; the shelf chip still is', () => {
    document.body.innerHTML = `<h2 class="hP">Reminder</h2><div class="adn">
      <span class="gD" email="info@meetup.example" name="Meetup">Meetup</span>
      <div class="a3s"><a id="going" href="https://meetup.example/e/1?view=attendees">See who's going</a>
        <span class="hq" id="fakeshelf">x</span><div class="aQH" id="fakeshelf2"><span class="aZo" id="fakechip">y</span></div>
        <a id="fakeatt" href="https://mail.google.com/mail/u/0/?view=att&amp;attid=0.9">open.pdf</a>${INLINE}</div>
      <div class="hq" id="shelf"><span class="aZo" id="chip" download_url="application/pdf:agenda.pdf:https://x">agenda.pdf</span></div></div>`;
    expect(ids(gmail.extract(document)!)).toEqual({ att: ['inline', 'chip'], containers: ['shelf'] });
  });

  it('Gmail: only an exact view=att parameter marks a link outside the body as a file (not view=attendees or preview=att)', () => {
    document.body.innerHTML = `<div class="adn"><span class="gD" email="info@meetup.example" name="Meetup">Meetup</span>
      <div class="a3s">Hello</div>
      <div class="gE"><a id="who" href="https://meetup.example/e/1?view=attendees">Who</a>
        <a id="prev" href="https://meetup.example/e/1?preview=att&amp;x=1">Preview</a>
        <a id="file" href="https://mail.google.com/mail/u/0/?ui=2&amp;attid=0.1&amp;view=att&amp;disp=safe">a.pdf</a>
        <a id="file2" href="https://mail.google.com/mail/u/0/?attid=0.2&amp;view=att">b.pdf</a>
        <a id="file3" href="https://mail.google.com/mail/u/0/?view=att&amp;attid=0.3">c.pdf</a></div></div>`;
    expect(ids(gmail.extract(document)!).att).toEqual(['file', 'file2', 'file3']);
  });

  it('Yahoo: an attachment tile or list written into the body is not a native attachment', () => {
    document.body.innerHTML = `<div data-test-id="message-group-view"><div data-test-id="message-card">
      <span data-test-id="message-from" title="news@shop.example">Shop</span>
      <div data-test-id="message-view-body-content" id="body">Sale!
        <div data-test-id="attachment-list" id="fakelist"><div data-test-id="attachment-tile" id="faketile">Catalog</div></div>
        ${INLINE}</div>
      <div data-test-id="attachment-list" id="list"><div data-test-id="attachment-tile" id="tile">invoice.pdf</div></div></div></div>`;
    expect(ids(yahoo.extract(document)!)).toEqual({ att: ['inline', 'tile'], containers: ['list'] });
  });

  it('Proton: an attachment item or list written into the body is not a native attachment', () => {
    document.body.innerHTML = `<div data-testid="conversation-view"><article data-testid="message-view-0">
      <div data-testid="message-header:from" title="news@shop.example">Shop</div>
      <div data-testid="message-content:body" id="body">Sale!
        <div data-testid="attachment-list" id="fakelist"><button data-testid="attachment-item-0" id="fakeitem">Catalog</button></div>
        ${INLINE}</div>
      <div data-testid="attachment-list" id="list"><button data-testid="attachment-item-0" id="item">invoice.pdf</button></div>
      </article></div>`;
    expect(ids(proton.extract(document)!)).toEqual({ att: ['inline', 'item'], containers: ['list'] });
  });
});
