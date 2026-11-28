// @vitest-environment happy-dom
// A conversation whose messages are rendered with different markup (a lower-priority body selector, or one message
// in a same-origin iframe and another inline) must have every message scanned and locked: before, only the first
// selector (or source) with content was used and the others were silently dropped (fail open).
import { describe, expect, it } from 'vitest';
import { outlook } from './outlook';
import { proton } from './proton';
import type { ExtractedEmail } from './types';
import { yahoo } from './yahoo';

const IP = 'http://192.168.4.20/login';
const PHISH = `Verify your account <a href="${IP}">here</a>`;
const hrefs = (all: ExtractedEmail[]) => all.map((e) => e.links.map((l) => l.href));
const frameWith = (id: string, html: string) => {
  const frame = document.getElementById(id) as HTMLIFrameElement;
  const fdoc = document.implementation.createHTMLDocument('');
  fdoc.body.innerHTML = html;
  Object.defineProperty(frame, 'contentDocument', { value: fdoc, configurable: true });
  return fdoc;
};

describe('every message of a mixed-markup conversation is extracted', () => {
  it('Outlook: a body matched only by a lower-priority selector is kept next to the primary one', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div aria-label="Email message"><span class="OZZZK">Bob&lt;bob@corp.example&gt;</span>
        <div aria-label="Message body" id="a">See you</div></div>
      <div aria-label="Email message"><span class="OZZZK">X&lt;x@evil.example&gt;</span>
        <div id="UniqueMessageBody_2">${PHISH}</div></div></div>`;
    const all = outlook.extractAll!(document);
    expect(all.map((e) => e.senderAddress)).toEqual(['bob@corp.example', 'x@evil.example']);
    expect(hrefs(all)).toEqual([[], [IP]]);
    expect(outlook.extract(document)!.senderAddress).toBe('x@evil.example'); // still the last message
  });

  it('Outlook: an attachment-only message is kept when another selector holds the text', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div aria-label="Email message"><span class="OZZZK">X&lt;x@evil.example&gt;</span>
        <div aria-label="Message body" id="a"></div>
        <div role="listitem" aria-label="Attached file invoice.html" id="att"><button>invoice.html</button></div></div>
      <div aria-label="Email message"><span class="OZZZK">Bob&lt;bob@corp.example&gt;</span>
        <div id="UniqueMessageBody_2">See you</div></div></div>`;
    const all = outlook.extractAll!(document);
    expect(all.map((e) => [e.container.id, e.attachments?.map((a) => a.element.id) ?? []])).toEqual([
      ['a', ['att']],
      ['UniqueMessageBody_2', []],
    ]);
  });

  it('Yahoo: an inline body and a same-origin iframe body are both kept, in thread order', () => {
    document.body.innerHTML = `<div data-test-id="message-group-view">
      <div data-test-id="message-card"><span data-test-id="message-from" title="bob@corp.example">Bob</span>
        <div data-test-id="message-view-body-content">See you</div></div>
      <div data-test-id="message-card"><span data-test-id="message-from" title="x@evil.example">X</span>
        <div data-test-id="message-view-body"><iframe id="f"></iframe></div></div></div>`;
    frameWith('f', PHISH);
    const all = yahoo.extractAll!(document);
    expect(all.map((e) => e.senderAddress)).toEqual(['bob@corp.example', 'x@evil.example']);
    expect(hrefs(all)).toEqual([[], [IP]]);
  });

  it('Proton: a content-iframe body and a direct body are both kept, in thread order', () => {
    document.body.innerHTML = `<div data-testid="conversation-view">
      <article data-testid="message-view-0"><div data-testid="message-header:from" title="x@evil.example">X</div>
        <div data-testid="message-content:body">${PHISH}</div></article>
      <article data-testid="message-view-1"><div data-testid="message-header:from" title="bob@corp.example">Bob</div>
        <iframe data-testid="content-iframe" id="f"></iframe></article></div>`;
    frameWith('f', 'See you');
    const all = proton.extractAll!(document);
    expect(all.map((e) => e.senderAddress)).toEqual(['x@evil.example', 'bob@corp.example']);
    expect(hrefs(all)).toEqual([[IP], []]);
  });

  it('adds no message for an empty wrapper around a body frame, or an empty helper frame beside real bodies', () => {
    document.body.innerHTML = `<div data-test-id="message-group-view"><div data-test-id="message-card">
      <span data-test-id="message-from" title="x@evil.example">X</span>
      <div data-test-id="message-view-body"><div class="msg-body"><iframe id="f"></iframe></div></div></div></div>`;
    const fdoc = frameWith('f', PHISH);
    expect(yahoo.extractAll!(document).map((e) => e.container)).toEqual([fdoc.body]);

    document.body.innerHTML = `<div data-test-id="message-group-view"><div data-test-id="message-card">
      <span data-test-id="message-from" title="x@evil.example">X</span>
      <div data-test-id="message-view-body-content" id="b">${PHISH}</div>
      <iframe title="Message print helper" id="f"></iframe></div></div>`;
    frameWith('f', '');
    expect(yahoo.extractAll!(document).map((e) => e.container.id)).toEqual(['b']);
  });
});
