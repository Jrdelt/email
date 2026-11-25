// Helpers for showing attacker-controlled text (filenames, addresses) inside the extension's own sentences.

// Bidirectional controls. The embeddings/overrides/isolates (U+202A-202E, U+2066-2069) can reorder text: an RLO in
// "invoice\u202efdp.exe" reverses everything after it, disguising the file type and garbling the warning sentence.
// The marks (U+200E, U+200F, U+061C) cannot reorder Latin text and occur in ordinary Hebrew/Arabic filenames, so
// they are only neutralised for display.
const BIDI_RE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const REORDERING_RE = /[\u202a-\u202e\u2066-\u2069]/;

/** True when the text holds bidi embedding/override/isolate controls that can visually reorder it. */
export const hasBidiControls = (s: string): boolean => REORDERING_RE.test(s);

/** Replace bidi control characters with a visible U+FFFD so text cannot reorder the sentence around it. */
export const showable = (s: string): string => s.replace(BIDI_RE, '�');

/** Shorten long text for display while keeping its end (where a file's real extension is). */
export function ellipsizeMiddle(s: string, max = 160): string {
  if (s.length <= max) return s;
  let head = Math.ceil((max - 1) / 2);
  let tail = s.length - (max - 1 - head);
  // Never cut between the two halves of a surrogate pair (an emoji or astral look-alike letter).
  if (isLowSurrogate(s.charCodeAt(head))) head--;
  if (isLowSurrogate(s.charCodeAt(tail))) tail++;
  return `${s.slice(0, head)}…${s.slice(tail)}`;
}

const isLowSurrogate = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
