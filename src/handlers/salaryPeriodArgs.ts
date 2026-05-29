export type SalaryPeriodTarget = {
  month?: number;
  year?: number;
};

export type SalaryPeriodParseResult =
  | ({ ok: true } & SalaryPeriodTarget)
  | {
      ok: false;
      reason: 'invalid_month' | 'invalid_year' | 'too_many_args';
    };

const MONTHS: Record<string, number> = {
  '1': 1,
  '01': 1,
  jan: 1,
  januari: 1,
  january: 1,
  '2': 2,
  '02': 2,
  feb: 2,
  februari: 2,
  february: 2,
  '3': 3,
  '03': 3,
  mar: 3,
  maret: 3,
  march: 3,
  '4': 4,
  '04': 4,
  apr: 4,
  april: 4,
  '5': 5,
  '05': 5,
  mei: 5,
  may: 5,
  '6': 6,
  '06': 6,
  jun: 6,
  juni: 6,
  june: 6,
  '7': 7,
  '07': 7,
  jul: 7,
  juli: 7,
  july: 7,
  '8': 8,
  '08': 8,
  agu: 8,
  ags: 8,
  agustus: 8,
  aug: 8,
  august: 8,
  '9': 9,
  '09': 9,
  sep: 9,
  september: 9,
  '10': 10,
  okt: 10,
  oktober: 10,
  oct: 10,
  october: 10,
  '11': 11,
  nov: 11,
  november: 11,
  '12': 12,
  des: 12,
  desember: 12,
  dec: 12,
  december: 12,
};

function parseYear(raw: string): number | null {
  if (!/^\d{2}$|^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return raw.length === 2 ? 2000 + year : year;
}

export function parseSalaryPeriodArgs(input: string): SalaryPeriodParseResult {
  const parts = input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return { ok: true };
  if (parts.length > 2) return { ok: false, reason: 'too_many_args' };

  const month = MONTHS[parts[0]];
  if (!month) return { ok: false, reason: 'invalid_month' };

  if (parts.length === 1) {
    return { ok: true, month, year: new Date().getFullYear() };
  }

  const year = parseYear(parts[1]);
  if (!year) return { ok: false, reason: 'invalid_year' };

  return { ok: true, month, year };
}
