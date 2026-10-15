import { createClient, SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key)
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  client = createClient(url, key);
  return client;
}

/**
 * Cloudflare Workers only exposes configuration during request handling, so
 * the client cannot be built at module-eval time. This Proxy defers
 * construction to first property access while keeping the
 * `supabase.from(...)` call shape — and the test mocks — unchanged.
 */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(target, prop, receiver) {
    // Symbols and `then` are probed by test matchers, console formatting, and
    // promise resolution. Answering them from the empty target keeps those
    // probes from constructing a client (and throwing) as a side effect.
    if (typeof prop === 'symbol' || prop === 'then') {
      return Reflect.get(target, prop, receiver);
    }
    const c = getClient();
    const value = Reflect.get(c, prop);
    // Bind methods: an unbound `from` would lose its receiver.
    return typeof value === 'function' ? value.bind(c) : value;
  },
});
