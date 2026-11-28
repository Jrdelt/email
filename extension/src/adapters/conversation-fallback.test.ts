// @vitest-environment happy-dom
// Outlook, Yahoo and Proton read the sender from the message wrapper around the body. When no per-message wrapper
// matches (a localized aria-label, a new layout), they fall back to the whole conversation, whose first sender
// belongs to only one of its messages. A sender found there is then marked pairingUncertain (never allowlist-trusted)
// when the conversation holds another body or more than one sender address; a single-message fallback stays certain.
import { describe, expect, it } from 'vitest';
import { outlook } from './outlook';
import { proton } from './proton';
import { yahoo } from './yahoo';
import type { ExtractedEmail } from './types';

const shape = (all: ExtractedEmail[]) => all.map((e) => ({ s: e.senderAddress, u: e.pairingUncertain === true }));

describe('conversation-level fallback scope: the sender cannot be paired for certain', () => {
  it('Outlook: two messages without a per-message wrapper (localized aria-label) are both uncertain', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div aria-label="E-Mail-Nachricht"><span class="OZZZK">Boss&lt;boss@corp.example&gt;</span>
        <div id="UniqueMessageBody_1">See you</div></div>
      <div aria-label="E-Mail-Nachricht"><span class="OZZZK">Mallory&lt;mallory@evil.example&gt;</span>
        <div id="UniqueMessageBody_2">Verify <a href="http://192.168.4.20/login">here</a></div></div></div>`;
    const all = outlook.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.pairingUncertain === true)).toBe(true);
  });

  it('Outlook: one expanded body next to a collapsed header from another sender is uncertain', () => {
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div><span class="OZZZK">Boss&lt;boss@corp.example&gt;</span><span>Lunch on Friday?</span></div>
      <div><span class="OZZZK">Mallory&lt;mallory@evil.example&gt;</span>
        <div id="UniqueMessageBody_2">Verify <a href="http://192.168.4.20/login">here</a></div></div></div>`;
    expect(outlook.extractAll!(document).map((e) => e.pairingUncertain)).toEqual([true]);
  });

  it('Outlook: a single message in a fallback scope, and messages in their own wrappers, stay certain', () => {
    document.body.innerHTML = `<div role="main"><span class="OZZZK">Boss&lt;boss@corp.example&gt;</span>
      <a title="boss@corp.example" href="mailto:boss@corp.example">Boss</a>
      <div id="UniqueMessageBody_1">See you</div></div>`;
    expect(shape(outlook.extractAll!(document))).toEqual([{ s: 'boss@corp.example', u: false }]);
    document.body.innerHTML = `<div data-app-section="ConversationContainer">
      <div aria-label="Email message"><span class="OZZZK">Boss&lt;boss@corp.example&gt;</span>
        <div aria-label="Message body">See you</div></div>
      <div aria-label="Email message"><span class="OZZZK">Mallory&lt;mallory@evil.example&gt;</span>
        <div aria-label="Message body">Verify</div></div></div>`;
    expect(shape(outlook.extractAll!(document))).toEqual([
      { s: 'boss@corp.example', u: false },
      { s: 'mallory@evil.example', u: false },
    ]);
  });

  it('Yahoo: two bodies in a message-group-view without message cards are both uncertain', () => {
    document.body.innerHTML = `<div data-test-id="message-group-view">
      <div><span data-test-id="message-from" title="boss@corp.example">Boss</span>
        <div data-test-id="message-view-body-content">See you</div></div>
      <div><span data-test-id="message-from" title="mallory@evil.example">Mallory</span>
        <div data-test-id="message-view-body-content">Verify <a href="http://192.168.4.20/login">here</a></div></div></div>`;
    const all = yahoo.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.pairingUncertain === true)).toBe(true);
  });

  it('Yahoo: a single message in the group view stays certain; one beside another sender is not', () => {
    const page = (extra: string) => `<div data-test-id="message-group-view">${extra}
      <div><span data-test-id="message-from" title="boss@corp.example">Boss</span>
        <div data-test-id="message-view-body-content">See you</div></div></div>`;
    document.body.innerHTML = page('');
    expect(shape(yahoo.extractAll!(document))).toEqual([{ s: 'boss@corp.example', u: false }]);
    document.body.innerHTML = page('<div><span data-test-id="message-from" title="carol@corp.example">Carol</span></div>');
    expect(yahoo.extractAll!(document).map((e) => e.pairingUncertain)).toEqual([true]);
  });

  it('Proton: two bodies in a conversation-view without message views are both uncertain', () => {
    document.body.innerHTML = `<div data-testid="conversation-view">
      <div><div data-testid="message-header:from" title="boss@corp.example">Boss</div>
        <div data-testid="message-content:body">See you</div></div>
      <div><div data-testid="message-header:from" title="mallory@evil.example">Mallory</div>
        <div data-testid="message-content:body">Verify <a href="http://192.168.4.20/login">here</a></div></div></div>`;
    const all = proton.extractAll!(document);
    expect(all).toHaveLength(2);
    expect(all.every((e) => e.pairingUncertain === true)).toBe(true);
  });

  it('Proton: a single message in the conversation view stays certain', () => {
    document.body.innerHTML = `<div data-testid="conversation-view">
      <div><div data-testid="message-header:from" title="boss@corp.example">Boss</div>
        <div data-testid="message-content:body">See you</div></div></div>`;
    expect(shape(proton.extractAll!(document))).toEqual([{ s: 'boss@corp.example', u: false }]);
  });
});
