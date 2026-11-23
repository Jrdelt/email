import type { Link } from '../features';

export interface ExtractedEmail {
  senderName: string; // display name as shown ('' if unknown)
  senderAddress: string; // address as shown, unvalidated ('' if unknown)
  body: string;
  links: Link[];
  container: HTMLElement; // element holding the message body (used for link locking)
}

/** One adapter per webmail provider. Selectors live here and nowhere else. */
export interface WebmailAdapter {
  name: string;
  matches(url: URL): boolean;
  /** Return the currently open email, or null if none is open. */
  extract(doc: Document): ExtractedEmail | null;
}
