const jakarta = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function businessDate(instant: Date): string {
  const parts = jakarta.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}

function civilInstant(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid civil date');
  const [year, month, date] = day.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, date);
  if (year < 1 || result.getUTCFullYear() !== year || result.getUTCMonth() !== month - 1 ||
      result.getUTCDate() !== date) throw new Error('Invalid civil date');
  return result;
}

function civilString(date: Date): string {
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999 || !Number.isFinite(date.getTime())) throw new Error('Civil date out of range');
  return `${String(year).padStart(4,'0')}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}

export function shiftCivilDay(day: string, delta: number): string {
  if (!Number.isSafeInteger(delta)) throw new Error('Invalid civil day offset');
  const date = civilInstant(day);
  date.setUTCDate(date.getUTCDate() + delta);
  return civilString(date);
}

export function calendarMonth(year: number, month: number): { from: string; to: string } {
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month)) throw new Error('Invalid calendar month');
  const first = new Date(0);
  first.setUTCFullYear(year, month - 1, 1);
  const from = civilString(first);
  first.setUTCMonth(first.getUTCMonth() + 1, 0);
  return { from, to: civilString(first) };
}

export function currentMonthRange(now = new Date()): { from: string; to: string } {
  const to = businessDate(now);
  return { from: to.slice(0,7) + '-01', to };
}
