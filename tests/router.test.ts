/**
 * Router defensive-behavior tests.
 *
 * Focus: what happens when Gemini returns unexpected output or throws.
 * The real AI is never called — the Gemini mock is programmable per test.
 *
 * Design: handlers are mocked as spies so we assert the router's
 * dispatch decisions, not the handlers' own logic. Tests stay fast and
 * each case focuses on ONE router rule.
 *
 * Hoisting notes:
 *  - Spies (vi.fn) are created inside vi.hoisted(...) so they exist
 *    before vi.mock factories run.
 *  - The Supabase mock builder is imported normally; vi.mock factories
 *    run lazily (when the router first imports the mocked module), by
 *    which time the helpers import has already resolved.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AIResponse, Account } from '../src/ai/types';
import { buildMsg, buildSupabaseMock, fixtureAccount } from './helpers/mocks';

// ── Hoisted: spies and the mutable DB-rows config ────────────────────
//
// Handler spies are typed as (...args: unknown[]) => Promise<void> so
// that `.mock.calls[i][j]` is legal in assertions. Using a zero-arg
// signature (e.g. `vi.fn(async () => undefined)`) would make TS refuse
// indexed access into mock.calls under strict mode.

type AnyAsync = (...args: unknown[]) => Promise<void>;
// Type callGemini's mock with AIResponse as the resolved value so
// `mockResolvedValue({ action, payload })` type-checks without casts.
// Using `unknown` as the resolved type lets us also feed in malformed
// AI responses (missing fields, bogus action strings) to exercise the
// router's defensive branches.
type GeminiMock = (...args: unknown[]) => Promise<unknown>;

// Note: the `vi` imported above is usable inside vi.hoisted — Vitest's
// transform hoists the factory call above imports and ensures `vi` is
// resolvable there.
const mocks = vi.hoisted(() => ({
  sendWA: vi.fn<AnyAsync>(),
  callGemini: vi.fn<GeminiMock>(),
  handlers: {
    createTxn: vi.fn<AnyAsync>(),
    createMultiple: vi.fn<AnyAsync>(),
    editTxn: vi.fn<AnyAsync>(),
    deleteTxn: vi.fn<AnyAsync>(),
    confirmDelete: vi.fn<AnyAsync>(),
    getSummary: vi.fn<AnyAsync>(),
    getCategories: vi.fn<AnyAsync>(),
    addCategory: vi.fn<AnyAsync>(),
    chitchat: vi.fn<AnyAsync>(),
    setup: vi.fn<AnyAsync>(),
    searchTxn: vi.fn<AnyAsync>(),
  },
  // Mutable row config. The Supabase Proxy reads these fields at query
  // time, so tests can tweak e.g. `mocks.supabaseRows.pending` before
  // exercising a flow.
  supabaseRows: {
    account: null as Account | null,
    memberLangPref: null as string | null,
    pending: null as unknown,
    txnByReply: null as unknown,
    multiples: [] as unknown[],
  },
}));

// ── Module mocks ─────────────────────────────────────────────────────
//
// The mock factory captures `mocks.supabaseRows` by reference; the
// Proxy reads from that object at query time, so tests can mutate it
// between/within tests and the mock will see the changes.

vi.mock('../src/services/supabase', () => ({
  supabase: buildSupabaseMock(mocks.supabaseRows),
}));
vi.mock('../src/services/whatsapp', () => ({ sendWA: mocks.sendWA }));
vi.mock('../src/ai/gemini', () => ({ callGemini: mocks.callGemini }));
vi.mock('../src/handlers', () => mocks.handlers);

// Import AFTER mocks. Default account is set before any test runs.
import { routeMessage } from '../src/router';
mocks.supabaseRows.account = fixtureAccount;

// ── Shared setup ─────────────────────────────────────────────────────

function resetAllSpies() {
  mocks.sendWA.mockClear();
  mocks.callGemini.mockReset();
  Object.values(mocks.handlers).forEach((fn) => fn.mockClear());
}

beforeEach(() => {
  resetAllSpies();
  // Reset mutable rows between tests so one test's state doesn't leak.
  mocks.supabaseRows.account = fixtureAccount;
  mocks.supabaseRows.memberLangPref = null;
  mocks.supabaseRows.pending = null;
  mocks.supabaseRows.txnByReply = null;
  mocks.supabaseRows.multiples = [];
});

// ── Slash commands: bypass Gemini entirely ───────────────────────────

describe('slash commands', () => {
  it('/help sends help text without calling Gemini', async () => {
    await routeMessage(buildMsg({ text: '/help' }));
    expect(mocks.callGemini).not.toHaveBeenCalled();
    expect(mocks.sendWA).toHaveBeenCalledTimes(1);
  });

  it('/rekap routes to getSummary with this_month', async () => {
    await routeMessage(buildMsg({ text: '/rekap' }));
    expect(mocks.callGemini).not.toHaveBeenCalled();
    expect(mocks.handlers.getSummary).toHaveBeenCalledTimes(1);
    const aiArg = mocks.handlers.getSummary.mock.calls[0][0] as AIResponse;
    expect(aiArg.action).toBe('GET_SUMMARY');
    expect(aiArg.payload.period).toBe('this_month');
  });

  it('/summary (English alias) also routes to getSummary', async () => {
    await routeMessage(buildMsg({ text: '/summary' }));
    expect(mocks.handlers.getSummary).toHaveBeenCalledTimes(1);
  });

  it('/kategori routes to getCategories', async () => {
    await routeMessage(buildMsg({ text: '/kategori' }));
    expect(mocks.handlers.getCategories).toHaveBeenCalledTimes(1);
  });

  it('/cari routes to searchTxn with the query stripped of the command', async () => {
    await routeMessage(buildMsg({ text: '/cari bakso 50k' }));
    expect(mocks.handlers.searchTxn).toHaveBeenCalledTimes(1);
    const queryArg = mocks.handlers.searchTxn.mock.calls[0][0];
    expect(queryArg).toBe('bakso 50k');
  });

  it('/setup is handled before account lookup', async () => {
    // Even with no account, /setup should still dispatch
    mocks.supabaseRows.account = null;
    await routeMessage(buildMsg({ text: '/setup personal MyAccount' }));
    expect(mocks.handlers.setup).toHaveBeenCalledTimes(1);
  });
});

// ── Happy paths: AI dispatch ─────────────────────────────────────────

describe('AI dispatch — happy paths', () => {
  it('CREATE_TRANSACTION routes to createTxn', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'CREATE_TRANSACTION',
      payload: {
        amount: 50000,
        type: 'expense',
        category: 'Food',
        description: 'Lunch',
      },
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'lunch 50k' }));
    expect(mocks.handlers.createTxn).toHaveBeenCalledTimes(1);
    expect(mocks.handlers.chitchat).not.toHaveBeenCalled();
  });

  it('CREATE_MULTIPLE routes to createMultiple', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'CREATE_MULTIPLE',
      payload: {},
      transactions: [
        { amount: 10000, type: 'expense', description: 'Coffee' },
        { amount: 20000, type: 'expense', description: 'Taxi' },
      ],
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'coffee 10k, taxi 20k' }));
    expect(mocks.handlers.createMultiple).toHaveBeenCalledTimes(1);
  });

  it('GET_SUMMARY routes to getSummary', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'GET_SUMMARY',
      payload: { period: 'last_week' },
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'summary last week' }));
    expect(mocks.handlers.getSummary).toHaveBeenCalledTimes(1);
  });

  it('ADD_CATEGORY routes to addCategory', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'ADD_CATEGORY',
      payload: { category_name: 'Gadgets', category_type: 'expense' },
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'add category gadgets' }));
    expect(mocks.handlers.addCategory).toHaveBeenCalledTimes(1);
  });
});

// ── Defensive behavior: Gemini returns garbage ───────────────────────

describe('router is defensive against Gemini', () => {
  it('unknown action string falls through to chitchat', async () => {
    mocks.callGemini.mockResolvedValue({
      // At runtime this is what we're guarding against — a future Gemini
      // model adding a new action, or the model hallucinating a bogus one.
      action: 'NUKE_EVERYTHING',
      payload: {},
    } as unknown as AIResponse);
    await routeMessage(buildMsg({ text: 'random message' }));
    expect(mocks.handlers.chitchat).toHaveBeenCalledTimes(1);
    expect(mocks.handlers.createTxn).not.toHaveBeenCalled();
  });

  it('CHITCHAT action routes to chitchat (explicit)', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'CHITCHAT',
      payload: {},
      reply: 'Hello!',
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'hi' }));
    expect(mocks.handlers.chitchat).toHaveBeenCalledTimes(1);
  });

  it('UNKNOWN action routes to chitchat', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'UNKNOWN',
      payload: {},
    } as AIResponse);
    await routeMessage(buildMsg({ text: '???' }));
    expect(mocks.handlers.chitchat).toHaveBeenCalledTimes(1);
  });

  it('missing action field falls through to chitchat', async () => {
    mocks.callGemini.mockResolvedValue({ payload: {} } as AIResponse);
    await routeMessage(buildMsg({ text: 'hmm' }));
    expect(mocks.handlers.chitchat).toHaveBeenCalledTimes(1);
  });

  it('CREATE_TRANSACTION with empty payload still dispatches (handler validates)', async () => {
    mocks.callGemini.mockResolvedValue({
      action: 'CREATE_TRANSACTION',
      payload: {},
    } as AIResponse);
    await routeMessage(buildMsg({ text: 'pay something' }));
    // Router's job is to route; validation is the handler's. This test
    // documents that contract — if we later want the router to reject
    // empty payloads, this expectation will flip.
    expect(mocks.handlers.createTxn).toHaveBeenCalledTimes(1);
  });

  it('Gemini throwing lets the error propagate (caught by webhook top-level)', async () => {
    mocks.callGemini.mockRejectedValue(
      new Error('Gemini API error: 429 Too Many Requests'),
    );
    await expect(routeMessage(buildMsg({ text: 'anything' }))).rejects.toThrow(
      /Gemini API error/,
    );
    expect(mocks.handlers.chitchat).not.toHaveBeenCalled();
  });

  it('EDIT_TRANSACTION on a non-reply message falls through (not dispatched)', async () => {
    // The router switch has no case for EDIT_TRANSACTION on new messages,
    // so default → chitchat. Encodes the rule: editing requires a reply.
    mocks.callGemini.mockResolvedValue({
      action: 'EDIT_TRANSACTION',
      payload: { amount: 999 },
    } as AIResponse);
    await routeMessage(
      buildMsg({ text: 'change that to 999', repliedToId: null }),
    );
    expect(mocks.handlers.editTxn).not.toHaveBeenCalled();
    expect(mocks.handlers.chitchat).toHaveBeenCalledTimes(1);
  });
});
