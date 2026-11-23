import type { Verdict } from './features';
import type { ExtractedEmail } from './adapters/types';

/** ONNX inference, fully local (no network). TODO(T6): load bundled model.onnx, verify SHA-256, run onnxruntime-web (WASM). */
export async function scoreWithModel(_email: ExtractedEmail): Promise<Verdict | null> {
  return null; // null => caller falls back to the heuristic scorer
}
