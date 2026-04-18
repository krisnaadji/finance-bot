/**
 * Pure test helpers (no Vitest state at module scope).
 *
 * Exports only factory functions and fixtures. The actual vi.fn() spies
 * must be created inside each test file via `vi.hoisted(...)` so they
 * exist before vi.mock factories run. This avoids import-ordering
 * issues that show up as "cannot access X before initialization" errors.
 */

import type { Account, IncomingMessage } from '../../src/ai/types';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Row config for the Supabase mock. Intentionally loose (`unknown`) for
 * rows that tests rarely need to shape strictly — we just care about
 * "return this when that table is queried".
 */
export interface SupabaseRows {
  account?: Account | null;
  memberLangPref?: string | null;
  pending?: unknown;
  txnByReply?: unknown;
  multiples?: unknown[];
}

// ── Supabase: chainable mock ─────────────────────────────────────────

/**
 * Build a thenable / chainable Supabase mock.
 *
 * The real client returns the same builder from every chain method
 * (.from().select().eq().single()), and `await`ing it returns
 * { data, error }. We replicate that with a Proxy so the test doesn't
 * need to know which chain method was called — whatever the router
 * calls just works.
 *
 * The `rows` argument configures what each named query should return.
 * Keys are matched against the most recent `.from(table)` call.
 *
 * Returned as `unknown` so test files can cast it to whatever the real
 * module exports — we don't want to drag the Supabase client type into
 * the test helpers.
 */
export function buildSupabaseMock(rows: SupabaseRows = {}): unknown {
  const current: { table: string | null; multiplesQuery: boolean } = {
    table: null,
    multiplesQuery: false,
  };

  const resolveData = (): unknown => {
    switch (current.table) {
      case 'accounts':
        return rows.account ?? null;
      case 'members':
        return rows.memberLangPref != null
          ? { language_pref: rows.memberLangPref }
          : null;
      case 'pending_actions':
        return rows.pending ?? null;
      case 'transactions':
        return current.multiplesQuery
          ? (rows.multiples ?? [])
          : (rows.txnByReply ?? null);
      default:
        return null;
    }
  };

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop) {
      // Symbols (Symbol.toPrimitive, Symbol.iterator, etc.) — return
      // undefined so JS falls back to defaults instead of getting back
      // a function-that-returns-proxy which can cause weird behavior
      // during serialization or awaiting.
      if (typeof prop !== 'string') return undefined;

      if (prop === 'from') {
        return (table: string) => {
          current.table = table;
          current.multiplesQuery = false;
          return proxy;
        };
      }
      // `.single()` / `.maybeSingle()` terminates the chain with { data, error }.
      if (prop === 'single' || prop === 'maybeSingle') {
        return () => Promise.resolve({ data: resolveData(), error: null });
      }
      // Thenable: make the whole builder awaitable for queries that
      // don't end in .single() (e.g. .order(...) on a list query).
      if (prop === 'then') {
        return (
          onFulfilled?: (v: { data: unknown; error: null }) => unknown,
          onRejected?: (e: unknown) => unknown,
        ) =>
          Promise.resolve({ data: resolveData(), error: null }).then(
            onFulfilled,
            onRejected,
          );
      }
      // `.eq('wa_bot_message_id', ...)` flags this chain as the multi-txn lookup.
      if (prop === 'eq') {
        return (col: string) => {
          if (col === 'wa_bot_message_id') current.multiplesQuery = true;
          return proxy;
        };
      }
      // Fallback: any unrecognized chain method returns the proxy so
      // chains like .select().or().order() keep working.
      return () => proxy;
    },
  };

  const proxy: Record<string, unknown> = new Proxy({}, handler);
  return proxy;
}

// ── Fixtures ─────────────────────────────────────────────────────────

export const fixtureAccount: Account = {
  id: 'acc-uuid-1',
  name: 'Test Account',
  type: 'personal',
  wa_chat_id: '628123456789',
  language: 'id',
  owner_id: 'owner-uuid-1',
};

export function buildMsg(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    messageId: 'msg-id-1',
    chatId: '628123456789',
    text: 'lunch 50k',
    repliedToId: null,
    rawFrom: '628123456789',
    ...overrides,
  };
}
