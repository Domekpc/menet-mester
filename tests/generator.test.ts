import { describe, expect, it } from 'vitest';
import { generate, type GeneratorContext } from '../server/generator';
import { BASE, type Destination, type GenerateRequest, type Route, type TripTemplate, type UnitRule } from '../shared/types';

const d = (id: number, name: string, extra: Partial<Destination> = {}): Destination =>
  ({ id, name, address: `${name} címe`, lat: 0, lon: 0, maxPerDay: null, minGapDays: null, ...extra });
const dests = [
  d(1, 'Telephely'), d(2, 'Pappas'), d(3, 'Posta'), d(4, 'Szerviz'), d(5, 'OTP'),
  d(6, 'SAB'), d(7, 'Aichegg'), d(8, 'Könyvelő', { minGapDays: 5 }),
];
// symmetric distances (km)
const km: Record<string, number> = {
  '1-2': 25.9, '1-3': 3.2, '1-4': 24.1, '1-5': 3.4, '1-6': 329, '1-7': 340, '1-8': 3.2,
  '2-3': 24.5, '2-4': 3, '2-5': 24.8, '2-6': 320, '2-7': 330, '2-8': 24.5,
  '3-4': 23, '3-5': 0.5, '3-6': 330, '3-7': 341, '3-8': 0.3,
  '4-5': 23, '4-6': 320, '4-7': 331, '4-8': 23,
  '5-6': 331, '5-7': 342, '5-8': 0.6,
  '6-7': 14, '6-8': 330, '7-8': 341,
};
const routes: Route[] = [
  { id: 10, name: 'Pappas', fromId: 1, toId: 2, distanceKm: 25.9 },
  { id: 11, name: 'Posta', fromId: 1, toId: 3, distanceKm: 3.2 },
  { id: 12, name: 'OTP', fromId: 1, toId: 5, distanceKm: 3.4 },
  { id: 13, name: 'SAB', fromId: 1, toId: 6, distanceKm: 329 },
  { id: 14, name: 'Könyvelő', fromId: 1, toId: 8, distanceKm: 3.2 },
  { id: 15, name: 'SAB → Aichegg', fromId: 6, toId: 7, distanceKm: 14 },
];
const week: TripTemplate = {
  id: 30, name: 'Deutschlandsbergi hét', startWeekdays: [1], minPerMonth: null, maxPerMonth: null, onlyDates: [], note: '',
  days: [{ stops: [BASE, 6], repeat: 1 }, { stops: [6, 7, 6], repeat: 3 }, { stops: [6, BASE], repeat: 1 }],
};
const metro: TripTemplate = {
  id: 31, name: 'Metro', startWeekdays: [], minPerMonth: null, maxPerMonth: null, onlyDates: [], note: '',
  days: [{ stops: [BASE, 2, BASE], repeat: 1 }],
};
const ctx: GeneratorContext = {
  destinations: new Map(dests.map((x) => [x.id, x])),
  routes: new Map(routes.map((r) => [r.id, r])),
  templates: new Map([week, metro].map((t) => [t.id, t])),
  legKm: (a, b) => km[`${Math.min(a, b)}-${Math.max(a, b)}`],
};

type RuleOpts = Partial<Omit<UnitRule, 'kind' | 'id'>>;
const rule = (id: number, o: RuleOpts = {}): UnitRule =>
  ({ kind: 'route', id, period: 'month', min: null, max: null, minGapDays: null, weekdays: [], onlyDates: [], ...o });
const tpl = (id: number, o: RuleOpts = {}): UnitRule => ({ ...rule(id, o), kind: 'template' });
const base: GenerateRequest = {
  companyId: 1, vehicleId: 1, driverId: 1, baseDestinationId: 1,
  startOdometer: 10000, endOdometer: 10600, fromMonth: '2024-04', toMonth: '2024-06',
  stops: [], checkpoints: [], rules: [rule(10), rule(11), rule(12)],
  locked: [], tourChance: 'sometimes', seed: 42,
};

const legs = (r: ReturnType<typeof generate>) => r.months.flatMap((m) => m.legs);
const odoAt = (r: ReturnType<typeof generate>, start: number, pred: (l: ReturnType<typeof legs>[number]) => boolean) => {
  let odo = start;
  for (const l of legs(r)) { odo += l.km; if (pred(l)) return odo; }
  return NaN;
};

describe('generate', () => {
  it('covers the odometer difference within a kilometre', () => {
    for (const seed of [1, 2, 3, 42]) {
      const r = generate({ ...base, seed }, ctx);
      expect(Math.abs(r.totalKm - 600)).toBeLessThan(1);
      expect(r.months[2].endOdometer).toBe(10600);
    }
  });

  it('starts every day where the previous one ended and ends the period at base', () => {
    for (const seed of [5, 6, 7]) {
      const r = generate({ ...base, seed, endOdometer: 13500, rules: [...base.rules, tpl(30, { max: 1 })] }, ctx);
      let where = 1;
      for (const day of r.days) {
        if (!day.stops.length) continue;
        expect(day.stops[0]).toBe(where);
        where = day.stops[day.stops.length - 1];
      }
      expect(where).toBe(1);
    }
  });

  it('never visits the same place twice a day by default', () => {
    for (const seed of [1, 2, 3]) {
      for (const day of generate({ ...base, seed, endOdometer: 10900, tourChance: 'often' }, ctx).days) {
        const arrivals = day.stops.slice(1).filter((id) => id !== 1);
        expect(new Set(arrivals).size).toBe(arrivals.length);
      }
    }
  });

  it('allows more visits a day when the daily rule says so', () => {
    const r = generate({ ...base, rules: [rule(11, { period: 'day', min: 2, max: 2 })], endOdometer: 10000 + 4 * 6.4 * 60 }, ctx);
    expect(r.days.some((d) => d.stops.filter((x) => x === 3).length === 2)).toBe(true);
  });

  it('keeps the minimum gap between two occurrences', () => {
    const r = generate({ ...base, rules: [rule(14, { min: 3, minGapDays: 5 })], endOdometer: 10040 }, ctx);
    const dates = r.days.filter((x) => x.stops.includes(8)).map((x) => new Date(x.date).getTime() / 864e5);
    for (let i = 1; i < dates.length; i++) expect(dates[i] - dates[i - 1]).toBeGreaterThan(5);
  });

  it('respects weekly min and max', () => {
    const r = generate({ ...base, rules: [rule(10, { period: 'week', max: 1 }), rule(11, { period: 'week', min: 1 }), rule(12)] }, ctx);
    const weeks = new Map<string, number>();
    for (const d of r.days) {
      if (!d.stops.includes(2)) continue;
      const day = new Date(d.date + 'T00:00:00Z');
      const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
      weeks.set(monday, (weeks.get(monday) ?? 0) + 1);
    }
    for (const n of weeks.values()) expect(n).toBeLessThanOrEqual(1);
    expect(r.days.filter((d) => d.stops.includes(3)).length).toBeGreaterThanOrEqual(12);
  });

  it('only uses the allowed weekdays', () => {
    const r = generate({ ...base, rules: [rule(10, { weekdays: [2, 4] }), rule(11, { weekdays: [2, 4] })], endOdometer: 10300 }, ctx);
    for (const d of r.days) expect([2, 4]).toContain(((new Date(d.date + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1);
  });

  it('ignores routes that do not start or end at the base', () => {
    const r = generate({ ...base, rules: [...base.rules, rule(15)] }, ctx);
    expect(r.days.some((d) => d.stops.includes(7))).toBe(false);
    expect(Math.abs(r.totalKm - 600)).toBeLessThan(1);
  });

  it('chains nearby places into one tour when tours are frequent', () => {
    const r = generate({ ...base, tourChance: 'often', seed: 3 }, ctx);
    expect(r.days.some((x) => x.stops.length > 3 && x.stops[0] === 1 && !x.stops.slice(1, -1).includes(1))).toBe(true);
  });

  it('never chains when tours are switched off', () => {
    const r = generate({ ...base, tourChance: 'never' }, ctx);
    for (const day of r.days.filter((x) => x.kind === 'free')) {
      const seq = day.stops;
      for (let i = 1; i < seq.length - 1; i += 2) expect(seq[i + 1]).toBe(1);
    }
  });

  it('puts a template exactly on its only-dates', () => {
    const r = generate({ ...base, endOdometer: 12000, rules: [...base.rules, tpl(30, { onlyDates: ['2024-05-06'] })] }, ctx);
    const span = r.days.filter((x) => x.date >= '2024-05-06' && x.date <= '2024-05-10');
    expect(span.map((x) => x.stops)).toEqual([[1, 6], [6, 7, 6], [6, 7, 6], [6, 7, 6], [6, 1]]);
    expect(r.days.filter((x) => x.ruleKey === 't:30').map((x) => x.date)).toEqual(['2024-05-06']);
    expect(Math.abs(r.totalKm - 2000)).toBeLessThan(1);
  });

  it('puts a route only on its only-dates', () => {
    const r = generate({ ...base, endOdometer: 10300, rules: [rule(11), rule(12), rule(10, { onlyDates: ['2024-05-03', '2024-06-14'] })] }, ctx);
    const pappas = r.days.filter((x) => x.stops.includes(2)).map((x) => x.date);
    expect(pappas).toEqual(['2024-05-03', '2024-06-14']);
  });

  it('places required stops and honours their odometer reading', () => {
    const r = generate({ ...base, stops: [{ date: '2024-05-15', destinationId: 4, odometer: 10300, label: 'Szerviz', source: 'test' }] }, ctx);
    expect(Math.abs(odoAt(r, 10000, (l) => l.date === '2024-05-15' && l.toId === 4) - 10300)).toBeLessThan(1);
    expect(legs(r).filter((l) => l.date === '2024-05-15').map((l) => l.toId)).toEqual([4, 1]);
  });

  it('respects monthly min and max', () => {
    const r = generate({ ...base, rules: [rule(10, { max: 3 }), rule(11, { min: 2 }), rule(12)] }, ctx);
    for (const m of r.months) {
      expect(m.legs.filter((l) => l.toId === 2).length).toBeLessThanOrEqual(3);
      expect(m.legs.filter((l) => l.toId === 3).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps locked days when regenerating', () => {
    const first = generate(base, ctx);
    const locked = first.days.filter((x) => x.month !== undefined && x.date.startsWith('2024-05')).slice(0, 3);
    const second = generate({ ...base, seed: 99, locked }, ctx);
    for (const l of locked) expect(second.days.find((x) => x.date === l.date)?.stops).toEqual(l.stops);
    const lockedUnits = new Set(locked.map((l) => l.unitId));
    expect(second.days.filter((x) => lockedUnits.has(x.unitId)).length).toBe(locked.length);
    expect(Math.abs(second.totalKm - 600)).toBeLessThan(1);
  });

  it('never drives on Sunday or public holidays when there is room on weekdays', () => {
    const dates = legs(generate(base, ctx)).map((l) => l.date);
    expect(dates).not.toContain('2024-05-01');
    expect(dates.every((x) => new Date(x + 'T00:00:00Z').getUTCDay() !== 0)).toBe(true);
  });

  it('is reproducible with the same seed', () => {
    expect(generate(base, ctx)).toEqual(generate(base, ctx));
  });
});
