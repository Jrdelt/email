import { describe, expect, it } from 'vitest';
import { splitContentScripts } from './contentScriptSplit';
import { ICLOUD_FRAME_MATCHES, ICLOUD_SHELL_MATCHES, STANDARD_WEBMAIL_MATCHES, WEBMAIL_MATCHES } from './hosts';

describe('content-script manifest split', () => {
  it('runs standard webmail in the top frame only and iCloud mail frames in all frames, from one file', () => {
    const out = splitContentScripts([{ matches: [...WEBMAIL_MATCHES].reverse(), all_frames: true, js: ['content-scripts/content.js'] }])!;
    expect(out).toEqual([
      { matches: STANDARD_WEBMAIL_MATCHES, all_frames: false, js: ['content-scripts/content.js'] },
      { matches: ICLOUD_FRAME_MATCHES, all_frames: true, js: ['content-scripts/content.js'] },
    ]);
    // The iCloud page itself never gets the script, but stays a host permission (WEBMAIL_MATCHES).
    expect(out.flatMap((cs) => cs.matches)).not.toContain(ICLOUD_SHELL_MATCHES[0]);
  });

  it('leaves dev-mode manifests (no content scripts) alone and refuses an entry that drifted', () => {
    expect(splitContentScripts(undefined)).toBeUndefined();
    expect(splitContentScripts([])).toEqual([]);
    expect(() => splitContentScripts([{ matches: ['https://mail.google.com/*'] }])).toThrow(/WEBMAIL_MATCHES/);
  });
});
