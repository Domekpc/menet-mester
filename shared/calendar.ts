// Date helpers working on plain YYYY-MM-DD strings (UTC based, no timezone surprises).

export const MONTH_NAMES = [
  'Január', 'Február', 'Március', 'Április', 'Május', 'Június',
  'Július', 'Augusztus', 'Szeptember', 'Október', 'November', 'December',
];

const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export const addDays = (s: string, n: number) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmt(d);
};

export const monthOf = (s: string) => s.slice(0, 7);

export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return fmt(new Date(Date.UTC(y, m, 0)));
}

export const monthLabel = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${y} ${MONTH_NAMES[m - 1]}`;
};

function easter(year: number): string {
  // Anonymous Gregorian algorithm
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const holidayCache = new Map<number, Set<string>>();

/** Hungarian public holidays (munkaszüneti napok) plus Christmas Eve. */
export function holidays(year: number): Set<string> {
  if (!holidayCache.has(year)) {
    const e = easter(year);
    const fixed = ['01-01', '03-15', '05-01', '08-20', '10-23', '11-01', '12-24', '12-25', '12-26'];
    holidayCache.set(
      year,
      new Set([...fixed.map((d) => `${year}-${d}`), addDays(e, -2), addDays(e, 1), addDays(e, 50)]),
    );
  }
  return holidayCache.get(year)!;
}

export const weekday = (s: string) => toDate(s).getUTCDay(); // 0 = Sunday
export const isSaturday = (s: string) => weekday(s) === 6;
export const isDrivingDay = (s: string) => {
  const w = weekday(s);
  return w !== 0 && w !== 6 && !holidays(Number(s.slice(0, 4))).has(s);
};
