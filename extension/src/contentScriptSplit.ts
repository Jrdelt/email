import { ICLOUD_FRAME_MATCHES, STANDARD_WEBMAIL_MATCHES, WEBMAIL_MATCHES } from './hosts';

interface ManifestContentScript {
  matches?: string[];
  all_frames?: boolean;
  [key: string]: unknown;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Split the single content.ts manifest entry by frame: standard webmail in the top frame only (it reaches same-origin
 * message iframes from there and returns at once in any subframe), iCloud's app and message frames (subframes) in all
 * frames, and the iCloud page itself not at all. The same content.js serves both entries, so nothing is duplicated.
 *
 * Returns the list unchanged when it is empty: `wxt dev` (MV3) registers content scripts at runtime and filtered builds
 * may omit them. Throws if the entry ever stops matching WEBMAIL_MATCHES, so the split cannot silently drift.
 */
export function splitContentScripts<T extends ManifestContentScript>(scripts: T[] | undefined): T[] | undefined {
  if (!scripts?.length) return scripts;
  const [cs] = scripts;
  if (scripts.length !== 1 || !cs || !sameSet(cs.matches ?? [], WEBMAIL_MATCHES)) {
    throw new Error('Expected exactly one content script matching WEBMAIL_MATCHES (src/hosts.ts) to split by frame.');
  }
  return [
    { ...cs, matches: [...STANDARD_WEBMAIL_MATCHES], all_frames: false },
    { ...cs, matches: [...ICLOUD_FRAME_MATCHES], all_frames: true },
  ];
}
