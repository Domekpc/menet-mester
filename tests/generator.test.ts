import { describe, expect, it } from 'vitest';
import { generate, type GeneratorContext } from '../server/generator';
import type { Destination, GenerateRequest, Route } from '../shared/types';

const dests: Destination[] = [
  { id: 1, name: 'Telephely', address: 'Komló, Iskola út 41.', lat: 0, lon: 0 },
  { id: 2, name: 'Pappas', address: 'Pécs, Koksz u. 125.', lat: 0, lon: 0 },
  { id: 3, name: 'Posta', address: 'Komló, Városház tér 2.', lat: 0, lon: 0 },
  { id: 4, name: 'Szerviz', address: 'Pécs, Szerviz u. 1.', lat: 0, lon: 0 },
];
const km: Record<string, number> = { '1-2': 25.9, '1-3': 3.2, '1-4': 24.1, '2-3': 24.5 };
const routes: Route[] = [
  { id: 10, name: 'Pappas', fromId: 1, toId: 2, distanceKm: 25.9 },
  { id: 11, name: 'Posta', fromId: 1, toId: 3, distanceKm: 3.2 },
];
const ctx: GeneratorContext = {
  destinations: new Map(dests.map((d) => [d.id, d])),
  routes: new Map(routes.map((r) => [r.id, r])),
  legKm: (a, b) => km[`${Math.min(a, b)}-${Math.max(a, b)}`],
};

const base: GenerateRequest = {
  companyId: 1, vehicleId: 1, driverId: 1, baseDestinationId: 1,
  startOdometer: 10000, endOdometer: 10600, fromMonth: '2024-04', toMonth: '2024-06',
  stops: [], checkpoints: [], routes: [{ routeId: 10, minPerMonth: null, maxPerMonth: null }, { routeId: 11, minPerMonth: null, maxPerMonth: null }],
  seed: 42,
};

const legs = (r: ReturnType<typeof generate>) => r.months.flatMap((m) => m.legs);

describe('generate', () => {
  it('covers the odometer difference within a kilometre', () => {
    const r = generate(base, ctx);
    expect(Math.abs(r.totalKm - 600)).toBeLessThan(1);
    expect(r.months[2].endOdometer).toBe(10600);
  });

  it('always returns to base the same day', () => {
    const byDay = new Map<string, number[]>();
    for (const l of legs(generate(base, ctx))) byDay.set(l.date, [...(byDay.get(l.date) ?? []), l.fromId, l.toId]);
    for (const seq of byDay.values()) {
      expect(seq[0]).toBe(1);
      expect(seq[seq.length - 1]).toBe(1);
    }
  });

  it('never drives on Sunday or public holidays when there is room on weekdays', () => {
    const dates = legs(generate(base, ctx)).map((l) => l.date);
    expect(dates).not.toContain('2024-05-01');
    expect(dates.every((d) => new Date(d + 'T00:00:00Z').getUTCDay() !== 0)).toBe(true);
  });

  it('places required stops and honours their odometer reading', () => {
    const r = generate(
      { ...base, stops: [{ date: '2024-05-15', destinationId: 4, odometer: 10300, label: 'Szerviz', source: 'test' }] },
      ctx,
    );
    let odo = 10000;
    for (const l of legs(r)) {
      odo += l.km;
      if (l.date === '2024-05-15' && l.toId === 4) expect(Math.abs(odo - 10300)).toBeLessThan(1);
    }
    expect(legs(r).filter((l) => l.date === '2024-05-15').map((l) => l.toId)).toEqual([4, 1]);
  });

  it('respects monthly min and max', () => {
    const r = generate(
      { ...base, routes: [{ routeId: 10, minPerMonth: null, maxPerMonth: 3 }, { routeId: 11, minPerMonth: 2, maxPerMonth: null }] },
      ctx,
    );
    for (const m of r.months) {
      expect(m.legs.filter((l) => l.toId === 2).length).toBeLessThanOrEqual(3);
      expect(m.legs.filter((l) => l.toId === 3).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('is reproducible with the same seed', () => {
    expect(generate(base, ctx)).toEqual(generate(base, ctx));
  });
});
