const DECIMAL = /^\d+(?:\.\d+)?$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CENTS = 999999999999999n;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function parseAmount(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  if (!DECIMAL.test(text)) return null;
  const dot = text.indexOf('.');
  const whole = (dot < 0 ? text : text.slice(0, dot)).replace(/^0+(?=\d)/, '');
  const fraction = dot < 0 ? '' : text.slice(dot + 1).replace(/0+$/, '');
  if (whole.length > 13 || fraction.length > 2) return null;
  const padded = fraction.padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(padded);
  if (cents <= 0n || cents > MAX_CENTS) return null;
  return `${whole}.${padded}`;
}

export function isBusinessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DAY.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const lastDay = month === 2 ? (leap ? 29 : 28)
    : (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31);
  return day <= lastDay;
}

interface JsonSourceContext {
  source: string;
}

export function parseFinancialJson(text: string): unknown {
  return JSON.parse(text, (key: string, value: unknown, context?: JsonSourceContext) => {
    if (key === 'amount' && typeof value === 'number') {
      if (typeof context?.source !== 'string') throw new SyntaxError('Exact numeric amount source is unavailable');
      return context.source;
    }
    return value;
  });
}
