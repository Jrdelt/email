import type { Link } from '../features';

export interface ExtractedEmail { sender: string; body: string; links: Link[] }

/** One adapter per webmail provider. Selectors live here and nowhere else. */
export interface WebmailAdapter {
  name: string;
  matches(url: URL): boolean;
  /** Return the currently open email, or null if none is open. */
  extract(doc: Document): ExtractedEmail | null;
}
