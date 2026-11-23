// Minimal key-value interface so logic is testable without a browser. browser.storage.local satisfies it.
export interface KV {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function memoryKV(): KV {
  const data: Record<string, unknown> = {};
  return {
    get: async (k) => (k in data ? { [k]: structuredClone(data[k]) } : {}),
    set: async (items) => { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
  };
}
