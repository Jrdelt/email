import type { Link } from '../features';

export interface AttachmentRef {
  name: string;
  element: HTMLElement;
}

export interface ExtractedEmail {
  senderName: string; // display name as shown ('' if unknown)
  senderAddress: string; // address as shown, unvalidated ('' if unknown)
  viaDomain?: string; // relay domain when shown by webmail (e.g. Gmail "via ...")
  unauthenticated?: boolean; // true when webmail flags sender verification failure
  body: string;
  links: Link[];
  /** More distinct links than can be checked: the email is treated as suspicious (fail closed). */
  linksTruncated?: boolean;
  attachments?: AttachmentRef[];
  attachmentContainers?: HTMLElement[];
  container: HTMLElement; // element holding the message body (used for link locking)
}

/** One adapter per webmail provider. Selectors live here and nowhere else. */
export interface WebmailAdapter {
  name: string;
  matches(url: URL): boolean;
  /** Return the currently open email, or null if none is open. */
  extract(doc: Document): ExtractedEmail | null;
  /** Return all currently expanded/visible emails in DOM order (top to bottom). */
  extractAll?(doc: Document): ExtractedEmail[];
  /**
   * Same-origin iframe documents that host (or will host) message bodies. The content script guards clicks in
   * them and rescans when they change, since mutations inside an iframe never reach the top-level observer.
   */
  frameDocs?(doc: Document): Document[];
}
