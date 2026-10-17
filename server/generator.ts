import type {
  Destination,
  GenerateRequest,
  GenerateResult,
  MonthResult,
  Route,
  TripLeg,
} from '../shared/types.js';
import { addDays, isDrivingDay, isSaturday, monthOf, monthRange, lastDayOfMonth } from '../shared/calendar.js';

export interface GeneratorContext {
  destinations: Map<number, Destination>;
  routes: Map<number, Route>;
  /** Distance in km between two destinations (must be known for every leg the generator may use). */
  legKm: (fromId: number, toId: number) => number;
}

const MAX_JOURNEYS_PER_DAY = 3;
const UNIT = 10; // work in 0.1 km units to avoid float drift

/** Small deterministic PRNG so a seed reproduces the same record. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sequence of stops for a journey that starts and ends at the base. */
export function journeyStops(baseId: number, stops: number[]): number[] {
  const seq = [baseId, ...stops, baseId];
  return seq.filter((id, i) => i === 0 || id !== seq[i - 1]);
}

interface Template {
  routeId: number;
  stops: number[];
  units: number;
  min: number;
  max: number | null;
}

interface Day {
  date: string;
  index: number;
  month: string;
  driving: boolean; // regular working day
  spare: boolean; // Saturday, used only when the working days are full
  fixed: boolean; // a required stop happens this day
  journeys: number[][]; // stop sequences
  segment: number;
}

export function generate(req: GenerateRequest, ctx: GeneratorContext): GenerateResult {
  const seed = req.seed ?? Math.floor(Math.random() * 1e9);
  const rnd = mulberry32(seed);
  const warnings: string[] = [];
  const base = req.baseDestinationId;
  const months = monthRange(req.fromMonth, req.toMonth);
  const firstDate = `${months[0]}-01`;
  const lastDate = lastDayOfMonth(months[months.length - 1]);

  const legUnits = (a: number, b: number) => Math.round(ctx.legKm(a, b) * UNIT);
  const seqUnits = (seq: number[]) => seq.slice(1).reduce((s, id, i) => s + legUnits(seq[i], id), 0);

  // ---- calendar ----
  const days: Day[] = [];
  for (let d = firstDate, i = 0; d <= lastDate; d = addDays(d, 1), i++) {
    days.push({
      date: d,
      index: i,
      month: monthOf(d),
      driving: isDrivingDay(d),
      spare: isSaturday(d),
      fixed: false,
      journeys: [],
      segment: 0,
    });
  }
  const dayByDate = new Map(days.map((d) => [d.date, d]));

  // ---- required stops (fixed journeys) ----
  // key = dayIndex*1000 + position; used to order legs and checkpoints on one time axis.
  interface Checkpoint { key: number; odometer: number; label: string }
  const checkpoints: Checkpoint[] = [];
  const fixedLegKeys: { key: number; units: number }[] = [];

  const stopsByDate = new Map<string, typeof req.stops>();
  for (const s of req.stops) {
    if (s.date < firstDate || s.date > lastDate) continue;
    stopsByDate.set(s.date, [...(stopsByDate.get(s.date) ?? []), s]);
  }
  for (const [date, stops] of stopsByDate) {
    const day = dayByDate.get(date)!;
    day.fixed = true;
    const seq = journeyStops(base, stops.map((s) => s.destinationId));
    day.journeys.push(seq);
    seq.slice(1).forEach((id, i) => {
      const key = day.index * 1000 + i + 1;
      fixedLegKeys.push({ key, units: legUnits(seq[i], id) });
      const stop = stops.find((s) => s.destinationId === id && s.odometer != null);
      if (stop && i < seq.length - 2) {
        checkpoints.push({ key, odometer: stop.odometer!, label: `${stop.label} (${date})` });
      }
    });
  }
  for (const c of req.checkpoints) {
    const day = dayByDate.get(c.date);
    if (!day) continue;
    checkpoints.push({ key: day.index * 1000 + 999, odometer: c.odometer, label: `Km-állás ${c.date}` });
  }
  checkpoints.sort((a, b) => a.key - b.key);
  checkpoints.push({ key: days.length * 1000, odometer: req.endOdometer, label: 'Záró km-állás' });

  // ---- segments between checkpoints ----
  interface Segment { from: number; to: number; target: number; used: number; label: string }
  const segments: Segment[] = [];
  let prev = { key: -1, odometer: req.startOdometer };
  for (const cp of checkpoints) {
    const fixed = fixedLegKeys.filter((l) => l.key > prev.key && l.key <= cp.key).reduce((s, l) => s + l.units, 0);
    let target = (cp.odometer - prev.odometer) * UNIT - fixed;
    if (target < 0) {
      warnings.push(
        `${cp.label}: a megadott km-állás (${cp.odometer}) kevesebb, mint ami a kötelező utakból adódik — ellenőrizd az adatokat.`,
      );
      target = 0;
    }
    segments.push({ from: prev.key, to: cp.key, target, used: 0, label: cp.label });
    prev = cp;
  }
  for (const day of days) {
    const key = day.index * 1000 + 500;
    day.segment = segments.findIndex((s) => key > s.from && key <= s.to);
  }

  // ---- journey templates from the selected routes ----
  const templates: Template[] = [];
  for (const rule of req.routes) {
    const r = ctx.routes.get(rule.routeId);
    if (!r) continue;
    const seq = journeyStops(base, [r.fromId, r.toId]);
    if (seq.length < 2) continue;
    templates.push({
      routeId: r.id,
      stops: seq,
      units: seqUnits(seq),
      min: Math.max(0, rule.minPerMonth ?? 0),
      max: rule.maxPerMonth ?? null,
    });
  }
  if (!templates.length) warnings.push('Nincs kiválasztott út, csak a kötelező utak kerültek a nyilvántartásba.');

  const counts = new Map<string, number>(); // `${template}|${month}`
  const countKey = (t: number, m: string) => `${t}|${m}`;
  const capLeft = (t: number, m: string) => {
    const max = templates[t].max;
    return max == null ? Infinity : max - (counts.get(countKey(t, m)) ?? 0);
  };

  const freeDays = (seg: number | null, month: string, allowSpare: boolean) =>
    days.filter(
      (d) =>
        !d.fixed &&
        d.month === month &&
        (seg == null || d.segment === seg) &&
        (d.driving || (allowSpare && d.spare)) &&
        d.journeys.length < MAX_JOURNEYS_PER_DAY,
    );

  /** Place one journey on a day, preferring empty days and avoiding repeats of the same trip. */
  const place = (t: number, month: string, seg: number | null): boolean => {
    const stops = templates[t].stops;
    for (const allowSpare of [false, true]) {
      const cand = freeDays(seg, month, allowSpare);
      if (!cand.length) continue;
      const weights = cand.map((d) => {
        let w = 1 / (1 + d.journeys.length * 6);
        if (d.journeys.some((j) => j.join() === stops.join())) w *= 0.05;
        if (!d.driving) w *= 0.3;
        return w;
      });
      let pick = rnd() * weights.reduce((a, b) => a + b, 0);
      let i = 0;
      while (pick > weights[i] && i < cand.length - 1) pick -= weights[i++];
      const day = cand[i];
      day.journeys.push(stops);
      segments[day.segment].used += templates[t].units;
      counts.set(countKey(t, month), (counts.get(countKey(t, month)) ?? 0) + 1);
      return true;
    }
    return false;
  };

  // ---- step 1: monthly minimums ----
  for (const month of months) {
    templates.forEach((tpl, t) => {
      for (let k = 0; k < tpl.min; k++) {
        if (!place(t, month, null)) {
          warnings.push(`${month}: nincs elég szabad munkanap a minimum ${tpl.min} alkalomhoz.`);
          break;
        }
      }
    });
  }
  segments.forEach((s) => {
    if (s.used > s.target)
      warnings.push(
        `${s.label}: a havi minimumok miatt ${((s.used - s.target) / UNIT).toFixed(1)} km-rel több út került be, mint amennyit a km-óra enged.`,
      );
  });

  // ---- step 2: fill each segment up to its target ----
  const maxUnits = Math.max(0, ...templates.map((t) => t.units));
  segments.forEach((seg, s) => {
    const segMonths = months.filter((m) => days.some((d) => d.segment === s && d.month === m && !d.fixed));
    const slots = (m: string) =>
      freeDays(s, m, true).reduce((n, d) => n + MAX_JOURNEYS_PER_DAY - d.journeys.length, 0);

    // 2a: random walk until the remainder is small
    const threshold = Math.max(maxUnits * 3, 50 * UNIT);
    for (let guard = 0; guard < 100000; guard++) {
      const rest = seg.target - seg.used;
      if (rest <= threshold) break;
      const options: { t: number; m: string; w: number }[] = [];
      for (const m of segMonths) {
        const free = freeDays(s, m, false).length;
        const sl = slots(m);
        if (!sl) continue;
        templates.forEach((tpl, t) => {
          if (tpl.units > rest || capLeft(t, m) <= 0) return;
          // favour months that are still empty and trips that are used less
          const used = counts.get(countKey(t, m)) ?? 0;
          options.push({ t, m, w: (free + 1) / (1 + used) });
        });
      }
      if (!options.length) break;
      let pick = rnd() * options.reduce((a, o) => a + o.w, 0);
      let o = options[0];
      for (const opt of options) {
        if ((pick -= opt.w) <= 0) { o = opt; break; }
      }
      if (!place(o.t, o.m, s)) break;
    }

    // 2b: exact finish with a bounded 0/1 knapsack over the remainder
    const rest = seg.target - seg.used;
    if (rest > 0 && templates.length) {
      const items: { t: number; m: string; n: number; units: number }[] = [];
      for (const m of segMonths) {
        const sl = slots(m);
        templates.forEach((tpl, t) => {
          let cap = Math.min(capLeft(t, m), sl, Math.ceil(rest / tpl.units) + 1);
          for (let p = 1; cap > 0; p *= 2) {
            const n = Math.min(p, cap);
            items.push({ t, m, n, units: n * tpl.units });
            cap -= n;
          }
        });
      }
      // shuffle so that equal-length alternatives vary between seeds
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      const limit = rest + maxUnits;
      const from = new Int32Array(limit + 1).fill(-1);
      from[0] = items.length; // sentinel
      items.forEach((it, i) => {
        for (let v = limit; v >= it.units; v--) {
          if (from[v] === -1 && from[v - it.units] !== -1) from[v] = i;
        }
      });
      let best = -1;
      for (let v = 0; v <= limit; v++) {
        if (from[v] === -1) continue;
        if (best === -1 || Math.abs(v - rest) < Math.abs(best - rest)) best = v;
      }
      for (let v = best; v > 0; ) {
        const it = items[from[v]];
        for (let k = 0; k < it.n; k++) place(it.t, it.m, s);
        v -= it.units;
      }
    }

    const diff = (seg.used - seg.target) / UNIT;
    if (Math.abs(diff) >= 1) {
      warnings.push(
        `${seg.label}: a kiválasztott utakkal ${Math.abs(diff).toFixed(1)} km-rel ${diff < 0 ? 'kevesebb' : 'több'} jött ki, mint a km-óra szerinti futás. Adj hozzá több utat vagy lazíts a havi maximumokon.`,
      );
    }
  });

  // ---- monthly maximum sanity check (minimum may exceed max if misconfigured) ----
  templates.forEach((tpl, t) => {
    if (tpl.max != null && tpl.min > tpl.max) {
      const r = ctx.routes.get(tpl.routeId);
      warnings.push(`„${r?.name}”: a havi minimum nagyobb a maximumnál.`);
    }
  });

  // ---- build the legs ----
  const dest = (id: number) => ctx.destinations.get(id)!;
  let odometer = req.startOdometer * UNIT;
  const result: MonthResult[] = months.map((m) => ({ month: m, startOdometer: 0, endOdometer: 0, totalKm: 0, legs: [] }));
  for (const day of days) {
    const mr = result[months.indexOf(day.month)];
    if (day.index === 0 || day.date.endsWith('-01')) mr.startOdometer = Math.round(odometer / UNIT);
    for (const seq of day.journeys) {
      seq.slice(1).forEach((id, i) => {
        const units = legUnits(seq[i], id);
        odometer += units;
        const leg: TripLeg = {
          date: day.date,
          fromId: seq[i],
          toId: id,
          fromAddress: dest(seq[i]).address,
          toAddress: dest(id).address,
          partner: dest(id).name,
          km: units / UNIT,
          required: day.fixed,
        };
        mr.legs.push(leg);
        mr.totalKm = Math.round((mr.totalKm + leg.km) * 10) / 10;
      });
    }
    mr.endOdometer = Math.round(odometer / UNIT);
  }

  const totalKm = Math.round(result.reduce((s, m) => s + m.totalKm, 0) * 10) / 10;
  return { months: result, totalKm, targetKm: req.endOdometer - req.startOdometer, warnings, seed };
}
