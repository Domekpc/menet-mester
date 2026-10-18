import {
  BASE,
  type DayKind,
  type DayPlan,
  type Destination,
  type GenerateRequest,
  type GenerateResult,
  type MonthResult,
  type Route,
  type RulePeriod,
  type TripLeg,
  type TripTemplate,
  type UnitRule,
} from '../shared/types.js';
import { addDays, isDrivingDay, monthOf, monthRange, lastDayOfMonth, weekday } from '../shared/calendar.js';

export interface GeneratorContext {
  destinations: Map<number, Destination>;
  routes: Map<number, Route>;
  templates: Map<number, TripTemplate>;
  /** Distance in km between two destinations (known for every pair the generator may use). */
  legKm: (fromId: number, toId: number) => number;
}

const MAX_JOURNEYS_PER_DAY = 3; // separate base → … → base loops on one day
const UNIT = 10; // work in 0.1 km units to avoid float drift
const LONG_DAY_KM = 650;
const TOUR_P = { never: 0, rare: 0.15, sometimes: 0.35, often: 0.65 } as const;

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
  return dedupe([baseId, ...stops, baseId]);
}

const dedupe = (seq: number[]) => seq.filter((id, i) => i === 0 || id !== seq[i - 1]);

function permutations<T>(list: T[]): T[][] {
  if (list.length <= 1) return [list];
  return list.flatMap((x, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map((p) => [x, ...p]));
}

/** 1 = Monday … 7 = Sunday */
const isoWeekday = (date: string) => ((weekday(date) + 6) % 7) + 1;

/** Bucket a date falls into for a count rule: the day, the Monday of its week, or its month. */
export function bucketOf(date: string, period: RulePeriod) {
  if (period === 'day') return date;
  if (period === 'week') return addDays(date, 1 - isoWeekday(date));
  return monthOf(date);
}

interface Day {
  date: string;
  index: number;
  month: string;
  driving: boolean; // regular working day
  holiday: boolean; // public holiday on a weekday
  seq: number[]; // stops visited this day (empty = no driving)
  kind: DayKind | null; // null = nothing planned yet
  label: string;
  unitId: string;
  ruleKey?: string;
  locked?: boolean;
  segment: number;
}

interface Unit {
  key: string; // r:<id> / t:<id>
  label: string;
  rule: UnitRule;
  route?: Route;
  template?: TripTemplate;
}

export function generate(req: GenerateRequest, ctx: GeneratorContext): GenerateResult {
  const seed = req.seed ?? Math.floor(Math.random() * 1e9);
  const rnd = mulberry32(seed);
  const warnings: string[] = [];
  const base = req.baseDestinationId;
  const months = monthRange(req.fromMonth, req.toMonth);
  const firstDate = `${months[0]}-01`;
  const lastDate = lastDayOfMonth(months[months.length - 1]);
  const tourP = TOUR_P[req.tourChance ?? 'sometimes'] ?? 0.35;
  const dest = (id: number) => ctx.destinations.get(id);
  const name = (id: number) => dest(id)?.name ?? '?';
  const real = (id: number) => (id === BASE ? base : id);

  const km = (a: number, b: number) => (a === b ? 0 : ctx.legKm(a, b));
  const legUnits = (a: number, b: number) => Math.round(km(a, b) * UNIT);
  const seqUnits = (seq: number[]) => seq.slice(1).reduce((s, id, i) => s + legUnits(seq[i], id), 0);
  const pick = <T>(list: T[], weight: (t: T) => number = () => 1): T | undefined => {
    const w = list.map(weight);
    let r = rnd() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < list.length; i++) if ((r -= w[i]) <= 0 && w[i] > 0) return list[i];
    return list[list.length - 1];
  };

  // ---------- calendar ----------
  const days: Day[] = [];
  for (let d = firstDate, i = 0; d <= lastDate; d = addDays(d, 1), i++) {
    const driving = isDrivingDay(d);
    days.push({
      date: d, index: i, month: monthOf(d), driving, holiday: !driving && isoWeekday(d) <= 5,
      seq: [], kind: null, label: '', unitId: '', segment: 0,
    });
  }
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  let unitSeq = 0;
  // unique across runs, so days locked from an earlier result never share an id with new ones
  const newUnit = () => `${seed.toString(36)}-${++unitSeq}`;

  const occupy = (day: Day, seq: number[], kind: DayKind, label: string, unitId: string, ruleKey?: string) => {
    Object.assign(day, { seq: dedupe(seq), kind, label, unitId, ruleKey });
  };

  /** Day sequences of a template, BASE replaced by the real base. */
  const expandTemplate = (t: TripTemplate) =>
    t.days.flatMap((d) => Array.from({ length: Math.max(1, d.repeat || 1) }, () => d.stops.map(real)));

  const spanFree = (start: number, len: number) => {
    if (start < 0 || start + len > days.length) return false;
    for (let i = start; i < start + len; i++) if (days[i].kind) return false;
    return true;
  };

  // ---------- units the generator may use ----------
  const units: Unit[] = [];
  for (const rule of req.rules ?? []) {
    if (rule.kind === 'route') {
      const r = ctx.routes.get(rule.id);
      if (r && journeyStops(base, [r.fromId, r.toId]).length >= 3) units.push({ key: `r:${r.id}`, label: r.name, rule, route: r });
    } else {
      const t = ctx.templates.get(rule.id);
      if (t?.days.length) units.push({ key: `t:${t.id}`, label: t.name, rule, template: t });
    }
  }
  const visitsIn = (seq: number[]) => seq.filter((id) => id !== base);
  const routeVisits = (r: Route) => visitsIn(journeyStops(base, [r.fromId, r.toId]).slice(1, -1));
  const unitSeqs = (u: Unit) => (u.template ? expandTemplate(u.template) : [journeyStops(base, routeVisits(u.route!))]);
  const unitUnits = (u: Unit) => unitSeqs(u).reduce((s, q) => s + seqUnits(q), 0);

  // ---------- fixed days ----------
  interface Checkpoint { key: number; odometer: number; label: string }
  const checkpoints: Checkpoint[] = [];

  // 1. days the user locked in a previous result
  for (const l of req.locked ?? []) {
    const day = dayByDate.get(l.date);
    if (!day) continue;
    occupy(day, l.stops, l.kind, l.label, l.unitId, l.ruleKey);
    day.locked = true;
  }

  // 2. official data: service / inspection visits (with odometer readings)
  const stopsByDate = new Map<string, typeof req.stops>();
  for (const s of req.stops) {
    if (s.date < firstDate || s.date > lastDate) continue;
    stopsByDate.set(s.date, [...(stopsByDate.get(s.date) ?? []), s]);
  }
  for (const [date, stops] of stopsByDate) {
    const day = dayByDate.get(date)!;
    if (day.kind && !day.locked) continue;
    if (!day.locked) occupy(day, journeyStops(base, stops.map((s) => s.destinationId)), 'required', stops.map((s) => s.label).join(', '), newUnit());
    for (const s of stops) {
      const pos = day.seq.indexOf(s.destinationId);
      if (pos < 0) { warnings.push(`${date}: a rögzített nap nem tartalmazza ezt a kötelező helyet: ${name(s.destinationId)}.`); continue; }
      if (s.odometer != null) checkpoints.push({ key: day.index * 1000 + pos, odometer: s.odometer, label: `${s.label} (${date})` });
    }
  }

  // 3. routes and templates bound to given dates ("csak ezeken a napokon")
  for (const u of units) {
    for (const date of [...new Set(u.rule.onlyDates)].sort()) {
      if (date < firstDate || date > lastDate) continue;
      const start = dayByDate.get(date)!;
      if (start.locked && start.ruleKey === u.key) continue;
      const seqs = unitSeqs(u);
      if (!spanFree(start.index, seqs.length)) {
        warnings.push(`${date}: „${u.label}” nem fér be, mert ütközik egy másik bejegyzéssel.`);
        continue;
      }
      const unit = newUnit();
      seqs.forEach((seq, i) =>
        occupy(days[start.index + i], seq, u.template ? 'template' : 'plan', u.template ? u.label : 'Megadott nap', unit, i === 0 ? u.key : undefined));
    }
  }

  // ---------- odometer checkpoints → segments ----------
  for (const c of req.checkpoints) {
    const day = dayByDate.get(c.date);
    if (day) checkpoints.push({ key: day.index * 1000 + 999, odometer: c.odometer, label: `Km-állás ${c.date}` });
  }
  checkpoints.sort((a, b) => a.key - b.key);
  checkpoints.push({ key: days.length * 1000, odometer: req.endOdometer, label: 'Záró km-állás' });

  const fixedLegs: { key: number; units: number }[] = [];
  for (const d of days) {
    d.seq.slice(1).forEach((id, i) => fixedLegs.push({ key: d.index * 1000 + i + 1, units: legUnits(d.seq[i], id) }));
  }

  interface Segment { from: number; to: number; target: number; used: number; label: string }
  const segments: Segment[] = [];
  let prev = { key: -1, odometer: req.startOdometer };
  for (const cp of checkpoints) {
    const fixed = fixedLegs.filter((l) => l.key > prev.key && l.key <= cp.key).reduce((s, l) => s + l.units, 0);
    let target = (cp.odometer - prev.odometer) * UNIT - fixed;
    if (target < 0) {
      warnings.push(`${cp.label}: a megadott km-állás (${cp.odometer}) kevesebb, mint ami a rögzített utakból adódik — ellenőrizd az adatokat.`);
      target = 0;
    }
    segments.push({ from: prev.key, to: cp.key, target, used: 0, label: cp.label });
    prev = cp;
  }
  for (const day of days) {
    const key = day.index * 1000 + 500;
    day.segment = segments.findIndex((s) => key > s.from && key <= s.to);
  }

  // ---------- rule bookkeeping ----------
  const free = units.filter((u) => !u.rule.onlyDates.length); // units the generator places itself
  if (!units.length && !days.some((d) => d.kind)) warnings.push('Nincs kiválasztott út vagy utazás.');

  const occurrences = new Map<string, { start: number; end: number }[]>();
  const counts = new Map<string, number>(); // `${unitKey}|${bucket}`
  const record = (u: Unit, start: number, len: number) => {
    occurrences.set(u.key, [...(occurrences.get(u.key) ?? []), { start, end: start + len - 1 }]);
    const k = `${u.key}|${bucketOf(days[start].date, u.rule.period)}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const u of units) {
    for (const d of days) {
      if (d.ruleKey !== u.key) continue;
      let len = 1;
      while (d.index + len < days.length && days[d.index + len].unitId === d.unitId) len++;
      record(u, d.index, len);
    }
  }
  const countIn = (u: Unit, date: string) => counts.get(`${u.key}|${bucketOf(date, u.rule.period)}`) ?? 0;
  const capOk = (u: Unit, date: string) => u.rule.max == null || countIn(u, date) < u.rule.max;
  const gapOk = (u: Unit, start: number, len: number) => {
    const g = u.rule.minGapDays ?? 0;
    if (!g) return true;
    return (occurrences.get(u.key) ?? []).every((o) => start - o.end > g || o.start - (start + len - 1) > g);
  };
  /** May the unit start on this day? Its weekday rule, else working days (Saturday only as a fallback). */
  const startDayOk = (u: Unit, d: Day, allowSpare: boolean) => {
    if (d.holiday) return false;
    if (u.rule.weekdays.length) return u.rule.weekdays.includes(isoWeekday(d.date));
    return d.driving || (allowSpare && isoWeekday(d.date) === 6);
  };
  /** Once a day per place, unless the route's own rule allows more per day. */
  const perDayOk = (u: Unit, d: Day, visits: number[]) => {
    const limit = u.rule.period === 'day' && u.rule.max ? u.rule.max : 1;
    const arrivals = visitsIn(d.seq.slice(1));
    return visits.every((v) => arrivals.filter((x) => x === v).length + 1 <= limit);
  };

  // ---------- tours ----------
  const journeysOf = (seq: number[]) => {
    const out: number[][] = [];
    let cur: number[] = [];
    for (const id of seq.slice(1)) {
      if (id === base) { if (cur.length) out.push(cur); cur = []; } else cur.push(id);
    }
    return out;
  };
  const fromJourneys = (js: number[][]) => dedupe([base, ...js.flatMap((j) => [...j, base])]);
  const bestTour = (visits: number[]) => {
    let best = visits, bestUnits = Infinity;
    for (const p of permutations(visits)) {
      const u = seqUnits(journeyStops(base, p));
      if (u < bestUnits) { best = p; bestUnits = u; }
    }
    return { order: best, units: bestUnits };
  };
  /** Could the visits be chained onto an existing journey of the day with a real saving? */
  const mergeOption = (day: Day, visits: number[]) => {
    if (day.kind !== 'free' || visits.length + visitsIn(day.seq).length > 5) return null;
    let best: { index: number; order: number[]; ratio: number } | null = null;
    journeysOf(day.seq).forEach((j, index) => {
      const separate = seqUnits(journeyStops(base, j)) + seqUnits(journeyStops(base, visits));
      const tour = bestTour([...j, ...visits]);
      const ratio = tour.units / separate;
      if (ratio <= 0.8 && (!best || ratio < best.ratio)) best = { index, order: tour.order, ratio };
    });
    return best as { index: number; order: number[]; ratio: number } | null;
  };

  const setSeq = (day: Day, seq: number[]) => {
    const before = day.kind ? seqUnits(day.seq) : 0;
    day.seq = dedupe(seq);
    segments[day.segment].used += seqUnits(day.seq) - before;
  };

  // ---------- placing ----------
  type Scope = { seg?: number; inBucket?: (d: Day) => boolean };
  const inScope = (d: Day, scope: Scope) =>
    d.segment >= 0 && (scope.seg == null || d.segment === scope.seg) && (!scope.inBucket || scope.inBucket(d));

  /** Days a one-day route could go on. */
  const oneDayCandidates = (u: Unit, scope: Scope, allowSpare: boolean) => {
    const visits = routeVisits(u.route!);
    return days.filter((d) =>
      inScope(d, scope) && (d.kind === null || d.kind === 'free') && journeysOf(d.seq).length < MAX_JOURNEYS_PER_DAY &&
      startDayOk(u, d, allowSpare) && capOk(u, d.date) && gapOk(u, d.index, 1) && perDayOk(u, d, visits));
  };

  const placeOneDay = (u: Unit, scope: Scope, noMerge: boolean): boolean => {
    const visits = routeVisits(u.route!);
    for (const allowSpare of [false, true]) {
      const cand = oneDayCandidates(u, scope, allowSpare);
      if (!cand.length) continue;
      const merges = new Map(cand.map((d) => [d, noMerge ? null : mergeOption(d, visits)]));
      const day = pick(cand, (d) => {
        let w = d.kind ? 1 / (1 + journeysOf(d.seq).length * 6) : 1;
        if (merges.get(d)) w *= 1 + tourP * 12;
        if (!d.driving) w *= 0.3;
        // spread repeat visits: the same place on neighbouring days is less likely
        for (let k = 1; k <= 3; k++) {
          for (const n of [days[d.index - k], days[d.index + k]]) {
            if (n && visits.some((v) => n.seq.includes(v))) w *= 0.35 + k * 0.15;
          }
        }
        return w;
      })!;
      const merge = merges.get(day);
      const js = journeysOf(day.seq);
      if (merge && rnd() < 0.3 + tourP) js[merge.index] = merge.order;
      else js.push(visits);
      if (!day.kind) Object.assign(day, { kind: 'free', label: '', unitId: newUnit() });
      setSeq(day, fromJourneys(js));
      record(u, day.index, 1);
      return true;
    }
    return false;
  };

  /** A template: several consecutive days, all free. */
  const placeSpan = (u: Unit, scope: Scope): boolean => {
    const seqs = expandTemplate(u.template!);
    for (const allowSpare of [false, true]) {
      const starts = days.filter((d) => {
        if (!inScope(d, scope) || !spanFree(d.index, seqs.length)) return false;
        if (days.slice(d.index, d.index + seqs.length).some((x) => x.segment !== d.segment)) return false;
        return startDayOk(u, d, allowSpare) && capOk(u, d.date) && gapOk(u, d.index, seqs.length);
      });
      const start = pick(starts);
      if (!start) continue;
      const unit = newUnit();
      seqs.forEach((seq, i) => {
        const day = days[start.index + i];
        Object.assign(day, { kind: 'template', label: u.label, unitId: unit, ruleKey: i === 0 ? u.key : undefined, seq: [] });
        setSeq(day, seq);
      });
      record(u, start.index, seqs.length);
      return true;
    }
    return false;
  };

  const placeUnit = (u: Unit, scope: Scope, noMerge = false) => (u.template ? placeSpan(u, scope) : placeOneDay(u, scope, noMerge));

  // ---------- step 1: minimums per day / week / month ----------
  const PERIOD_TEXT = { day: 'napi', week: 'heti', month: 'havi' } as const;
  for (const u of free) {
    if (!u.rule.min) continue;
    const buckets = [...new Set(days.map((d) => bucketOf(d.date, u.rule.period)))];
    let missed = 0;
    for (const b of buckets) {
      const inBucket = (d: Day) => bucketOf(d.date, u.rule.period) === b;
      for (let k = countIn(u, days.find(inBucket)!.date); k < u.rule.min; k++) {
        if (!placeUnit(u, { inBucket })) { missed++; break; }
      }
    }
    if (missed) {
      warnings.push(`„${u.label}”: a ${PERIOD_TEXT[u.rule.period]} minimum (${u.rule.min}) ${missed} alkalommal nem fért bele — nincs elég szabad nap, vagy ütközik egy szabállyal.`);
    }
  }
  segments.forEach((s) => {
    if (s.used > s.target)
      warnings.push(`${s.label}: a minimumok miatt ${((s.used - s.target) / UNIT).toFixed(1)} km-rel több út került be, mint amennyit a km-óra enged.`);
  });

  // ---------- step 2: fill every segment up to its target ----------
  const simple = free.filter((u) => !u.template);
  const maxUnits = Math.max(0, ...simple.map(unitUnits));
  segments.forEach((seg, s) => {
    // 2a: random walk until the remainder is small
    const threshold = Math.max(maxUnits * 2, 60 * UNIT);
    const failed = new Set<string>();
    for (let guard = 0; guard < 20000; guard++) {
      const rest = seg.target - seg.used;
      if (rest <= threshold) break;
      const options = free.filter((u) => !failed.has(u.key) && unitUnits(u) <= rest);
      const u = pick(options, (x) => (x.template ? 0.6 : 1) / (1 + (occurrences.get(x.key) ?? []).length * 0.15));
      if (!u) break;
      if (!placeUnit(u, { seg: s })) failed.add(u.key);
    }

    // 2b: exact finish with a bounded 0/1 knapsack of one-day routes. Repeated a few times,
    // because the rules can make some picks impossible to place together.
    for (let round = 0; round < 4 && simple.length; round++) {
      const rest = seg.target - seg.used;
      if (rest < UNIT) break;
      const items: { u: Unit; n: number; units: number }[] = [];
      for (const u of simple) {
        const uu = unitUnits(u);
        let cap = Math.min(oneDayCandidates(u, { seg: s }, true).length, Math.ceil(rest / uu) + 1);
        for (let p = 1; cap > 0; p *= 2) {
          const n = Math.min(p, cap);
          items.push({ u, n, units: n * uu });
          cap -= n;
        }
      }
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      const limit = rest + maxUnits;
      const from = new Int32Array(limit + 1).fill(-1);
      from[0] = items.length;
      items.forEach((it, i) => {
        for (let v = limit; v >= it.units; v--) if (from[v] === -1 && from[v - it.units] !== -1) from[v] = i;
      });
      let best = 0;
      for (let v = 0; v <= limit; v++) if (from[v] !== -1 && Math.abs(v - rest) < Math.abs(best - rest)) best = v;
      if (best === 0) break;
      for (let v = best; v > 0; ) {
        const it = items[from[v]];
        for (let k = 0; k < it.n; k++) placeOneDay(it.u, { seg: s }, true);
        v -= it.units;
      }
    }

    const diff = (seg.used - seg.target) / UNIT;
    if (Math.abs(diff) >= 1) {
      warnings.push(
        `${seg.label}: a kiválasztott utakkal ${Math.abs(diff).toFixed(1)} km-rel ${diff < 0 ? 'kevesebb' : 'több'} jött ki, mint a km-óra szerinti futás. Adj hozzá több utat, vagy lazíts a szabályokon.`,
      );
    }
  });

  // ---------- realism check ----------
  let where = base;
  for (const d of days) {
    if (!d.seq.length) continue;
    if (d.seq[0] !== where) warnings.push(`${d.date}: a nap nem ott kezdődik, ahol az előző véget ért (${name(where)}) — nézd át az utazás-sablont.`);
    where = d.seq[d.seq.length - 1];
    const dayKm = seqUnits(d.seq) / UNIT;
    if (dayKm > LONG_DAY_KM) warnings.push(`${d.date}: ${dayKm.toFixed(0)} km egy nap alatt — ez sok lehet. Többnapos útra használj utazás-sablont.`);
  }
  const satUsed = days.filter((d) => d.kind === 'free' && isoWeekday(d.date) === 6).length;
  if (satUsed && free.every((u) => !u.rule.weekdays.includes(6))) warnings.push(`${satUsed} szombati napra is került út, mert a hétköznapok beteltek.`);
  if (where !== base) warnings.push(`Az időszak végén az autó nem a telephelyen áll (${name(where)}).`);
  for (const u of units) {
    if (u.rule.max != null && u.rule.min != null && u.rule.min > u.rule.max) warnings.push(`„${u.label}”: a minimum nagyobb a maximumnál.`);
  }

  // ---------- output ----------
  let odometer = req.startOdometer * UNIT;
  const result: MonthResult[] = months.map((m) => ({ month: m, startOdometer: 0, endOdometer: 0, totalKm: 0, legs: [] }));
  const plans: DayPlan[] = [];
  for (const day of days) {
    const mr = result[months.indexOf(day.month)];
    if (day.index === 0 || day.date.endsWith('-01')) mr.startOdometer = Math.round(odometer / UNIT);
    if (day.kind) {
      plans.push({ date: day.date, stops: day.seq, kind: day.kind, label: day.label, unitId: day.unitId, ruleKey: day.ruleKey, locked: day.locked });
    }
    day.seq.slice(1).forEach((id, i) => {
      const units = legUnits(day.seq[i], id);
      odometer += units;
      mr.legs.push({
        date: day.date,
        fromId: day.seq[i],
        toId: id,
        fromAddress: dest(day.seq[i])?.address ?? '',
        toAddress: dest(id)?.address ?? '',
        partner: name(id),
        km: units / UNIT,
        required: day.kind === 'required' || day.kind === 'plan',
        kind: day.kind!,
        label: day.label,
      } satisfies TripLeg);
      mr.totalKm = Math.round((mr.totalKm + units / UNIT) * 10) / 10;
    });
    mr.endOdometer = Math.round(odometer / UNIT);
  }

  const totalKm = Math.round(result.reduce((s, m) => s + m.totalKm, 0) * 10) / 10;
  return { months: result, days: plans, totalKm, targetKm: req.endOdometer - req.startOdometer, warnings, seed };
}
