import { expect, it } from 'vitest';
import { parseAmount, parseFinancialJson } from '../src/utils/financialValidation';

it.each(['9999999999999.991', '35.500000000000000001', '1e3'])('rejects original monetary token %s before float rounding', (token) => {
  const parsed = parseFinancialJson('{"amount":' + token + '}') as { amount: unknown };
  expect(parseAmount(parsed.amount)).toBeNull();
});
it('preserves valid decimal lexemes and unrelated numeric fields', () => {
  const parsed = parseFinancialJson('{"amount":35.50,"selection_index":2,"description":"amount 35.50"}') as { amount: unknown; selection_index: unknown; description: unknown };
  expect(parseAmount(parsed.amount)).toBe('35.50'); expect(parsed.selection_index).toBe(2); expect(parsed.description).toBe('amount 35.50');
});
it('preserves amounts inside batches before whole-batch validation', () => {
  const parsed = parseFinancialJson('{"transactions":[{"amount":10.50},{"amount":10.000000000000000001}]}') as { transactions: { amount: unknown }[] };
  expect(parseAmount(parsed.transactions[0].amount)).toBe('10.50'); expect(parseAmount(parsed.transactions[1].amount)).toBeNull();
});
