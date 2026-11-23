import type { WebmailAdapter } from './types';

// TODO(T7): implement against saved HTML fixtures.
// Note: Proton renders the message body inside a sandboxed iframe. Extraction may need
// all_frames / match_about_blank on the content script; investigate before implementing.
export const proton: WebmailAdapter = {
  name: 'proton',
  matches: (url) => url.hostname === 'mail.proton.me',
  extract: () => null,
};
