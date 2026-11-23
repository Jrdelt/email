import type { Verdict } from './features';
import type { ExtractedEmail } from './adapters/types';

/** JSON-model scoring, fully local (no network, no ML runtime). TODO(T6): load bundled model.json, verify SHA-256, score in plain TS. */
export async function scoreWithModel(_email: ExtractedEmail): Promise<Verdict | null> {
  return null; // null => caller falls back to the heuristic scorer
}
