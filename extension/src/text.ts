// Helpers for showing attacker-controlled text (filenames, addresses) inside the extension's own sentences.

// Bidirectional override/isolate/mark characters: an RLO in "invoice‮fdp.exe" reverses everything after it,
// both disguising the file type and garbling the rest of the warning sentence.
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const BIDI_TEST_RE = /[؜‎‏‪-‮⁦-⁩]/;

export const hasBidiControls = (s: string): boolean => BIDI_TEST_RE.test(s);

/** Replace bidi control characters with a visible U+FFFD so text cannot reorder the sentence around it. */
export const showable = (s: string): string => s.replace(BIDI_RE, '�');

/** Shorten long text for display while keeping its end (where a file's real extension is). */
export function ellipsizeMiddle(s: string, max = 160): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - (max - 1 - head))}`;
}
