import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ categoryError: null as null | { code: string } }));
vi.mock('../src/services/supabase', () => ({ supabase: { from: () => {
  const builder: { select: () => unknown; eq: () => unknown; order: () => Promise<unknown> } = {
    select: () => builder, eq: () => builder,
    order: async () => ({ data: [], error: state.categoryError }),
  }; return builder;
} } }));
import { callAI } from '../src/ai';
import { InvalidAICommand } from '../src/ai/validation';
import { fixtureAccount } from './helpers/mocks';
beforeEach(() => { state.categoryError = null; vi.stubEnv('AI_API_KEY', 'disposable-test-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['groq', 'gemini'])('%s validates and normalizes provider JSON', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  const content = JSON.stringify({ action: 'CREATE_TRANSACTION', payload: { amount: 35, type: 'Pengeluaran', date: '2026-10-12' } });
  const fetchMock = vi.fn(async () => Response.json(provider === 'groq'
    ? { choices: [{ message: { content } }] }
    : { candidates: [{ content: { parts: [{ text: content }] } }] }));
  vi.stubGlobal('fetch', fetchMock);
  expect((await callAI('lunch 35', fixtureAccount, 'en')).payload).toMatchObject({ amount: '35.00', type: 'expense' });
});
it.each(['groq', 'gemini'])('%s does not trust malformed or incomplete JSON', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  for (const content of ['{', '{"action":"CREATE_TRANSACTION","payload":{}}']) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(provider === 'groq'
      ? { choices: [{ message: { content } }] }
      : { candidates: [{ content: { parts: [{ text: content }] } }] })));
    await expect(callAI('bad input', fixtureAccount, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
  }
});
it('category outage never fabricates an empty prompt catalog', async () => {
  state.categoryError = { code: '08006' }; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
  await expect(callAI('lunch', fixtureAccount, 'en')).rejects.toThrow('AI category lookup unavailable');
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['groq', 'gemini'])('%s rejects excess precision in the original numeric token', async (provider) => {
  vi.stubEnv('AI_PROVIDER', provider);
  const content = '{"action":"CREATE_TRANSACTION","payload":{"amount":9999999999999.991,"type":"expense","date":"2026-10-12"}}';
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(provider === 'groq'
    ? { choices: [{ message: { content } }] }
    : { candidates: [{ content: { parts: [{ text: content }] } }] })));
  await expect(callAI('bad precision', fixtureAccount, 'en')).rejects.toBeInstanceOf(InvalidAICommand);
});
