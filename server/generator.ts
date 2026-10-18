import {
  BASE,
  type DayKind,
  type DayPlan,
  type Destination,
  type GenerateRequest,
  type GenerateResult,
  type MonthResult,
  type Route,
  type TripLeg,
  type TripTemplate,
} from '../shared/types.js';
import { addDays, isDrivingDay, isSaturday, monthOf, monthRange, lastDayOfMonth, weekday } from '../shared/calendar.js';

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
const NEAR_KM = 45; // local trips during a stay away
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

interface Day {
  date: string;
  index: number;
  month: string;
  driving: boolean; // regular working day
  spare: boolean; // Saturday, used only when the working days are full
  seq: number[]; // stops visited this day (empty = no driving)
  kind: DayKind | null; // null = nothing planned yet
  fixed: boolean; // given by the user / data or part of a multi-day unit: never modified by filling
  label: string;
  unitId: string;
  ruleKey?: string;
  locked?: boolean;
  segment: number;
}

interface Unit {
  key: string; // r:<id> / t:<id>
  label: string;
  min: number;
  max: number | null;
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
    days.push({
      date: d, index: i, month: monthOf(d), driving: isDrivingDay(d), spare: isSaturday(d),
      seq: [], kind: null, fixed: false, label: '', unitId: '', segment: 0,
    });
  }
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  let unitSeq = 0;
  // unique across runs, so days locked from an earlier result never share an id with new ones
  const newUnit = () => `${seed.toString(36)}-${++unitSeq}`;

  const occupy = (day: Day, seq: number[], kind: DayKind, label: string, unitId: string, ruleKey?: string) => {
    Object.assign(day, { seq: dedupe(seq), kind, label, unitId, ruleKey, fixed: true });
  };

  /** Day sequences of a template, BASE replaced by the real base. */
  const expandTemplate = (t: TripTemplate) =>
    t.days.flatMap((d) => Array.from({ length: Math.max(1, d.repeat || 1) }, () => d.stops.map(real)));

  const spanFree = (start: number, len: number) => {
    if (start < 0 || start + len > days.length) return false;
    for (let i = start; i < start + len; i++) if (days[i].kind) return false;
    return true;
  };

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

  // 3. what the user put on the planner calendar
  const placeTemplateAt = (t: TripTemplate, date: string, kind: DayKind, why: string) => {
    const start = dayByDate.get(date);
    const seqs = expandTemplate(t);
    if (!start) return false;
    if (!spanFree(start.index, seqs.length)) {
      warnings.push(`${date}: a(z) „${t.name}” utazás nem fér be, mert ütközik egy másik bejegyzéssel (${why}).`);
      return false;
    }
    const unit = newUnit();
    seqs.forEach((seq, i) => occupy(days[start.index + i], seq, kind, t.name, unit, i === 0 ? `t:${t.id}` : undefined));
    return true;
  };

  for (const e of req.plan ?? []) {
    if (e.date < firstDate || e.date > lastDate) continue;
    if (e.type === 'template') {
      const t = ctx.templates.get(e.templateId);
      if (t) placeTemplateAt(t, e.date, 'plan', 'naptár');
      continue;
    }
    const day = dayByDate.get(e.date)!;
    if (day.kind) {
      warnings.push(`${e.date}: a megadott látogatás ütközik egy másik bejegyzéssel, ezért kimaradt.`);
      continue;
    }
    occupy(day, journeyStops(base, e.destinationIds), 'plan', 'Megadott nap', newUnit());
    if (e.odometer != null && day.seq.length > 2) {
      checkpoints.push({ key: day.index * 1000 + day.seq.length - 2, odometer: e.odometer, label: `Km-állás ${e.date}` });
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

  // ---------- units the generator may use ----------
  const units: Unit[] = [];
  for (const rule of req.routes) {
    const r = ctx.routes.get(rule.routeId);
    if (!r || journeyStops(base, [r.fromId, r.toId]).length < 3) continue;
    units.push({
      key: `r:${r.id}`, label: r.name, route: r,
      min: Math.max(0, rule.minPerMonth ?? 0), max: rule.maxPerMonth ?? null,
    });
  }
  for (const rule of req.templates ?? []) {
    const t = ctx.templates.get(rule.templateId);
    if (!t || !t.days.length) continue;
    units.push({
      key: `t:${t.id}`, label: t.name, template: t,
      min: Math.max(0, rule.minPerMonth ?? 0), max: rule.maxPerMonth ?? null,
    });
  }
  if (!units.length && !days.some((d) => d.kind)) warnings.push('Nincs kiválasztott út vagy utazás.');

  const counts = new Map<string, number>(); // `${unitKey}|${month}`
  for (const d of days) if (d.ruleKey) counts.set(`${d.ruleKey}|${d.month}`, (counts.get(`${d.ruleKey}|${d.month}`) ?? 0) + 1);
  const capLeft = (u: Unit, m: string) => (u.max == null ? Infinity : u.max - (counts.get(`${u.key}|${m}`) ?? 0));
  const count = (u: Unit, m: string) => counts.set(`${u.key}|${m}`, (counts.get(`${u.key}|${m}`) ?? 0) + 1);

  // ---------- destination rules ----------
  const visitsIn = (seq: number[]) => seq.filter((id) => id !== base);
  const maxPerDay = (id: number) => dest(id)?.maxPerDay ?? 1;
  const minGap = (id: number) => dest(id)?.minGapDays ?? 0;

  /**
   * May these arrivals be added to the given days (inside one unit)? Arrivals are the stops the car
   * drives to, so staying somewhere (X → Y → X) counts X once.
   */
  const rulesOk = (span: { day: Day; arrivals: number[]; replace?: boolean }[], perDay = true) => {
    const inSpan = new Set(span.map((s) => s.day.index));
    for (const { day, arrivals, replace } of span) {
      const all = [...(replace ? [] : visitsIn(day.seq.slice(1))), ...visitsIn(arrivals)];
      for (const id of new Set(visitsIn(arrivals))) {
        if (perDay && all.filter((x) => x === id).length > maxPerDay(id)) return false;
        const gap = minGap(id);
        for (let i = Math.max(0, day.index - gap); i <= Math.min(days.length - 1, day.index + gap) && gap > 0; i++) {
          if (inSpan.has(i)) continue;
          if (days[i].seq.includes(id)) return false;
        }
      }
    }
    return true;
  };

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

  /** A one-day journey for a route: base → from → to → base. */
  const routeVisits = (r: Route) => visitsIn(journeyStops(base, [r.fromId, r.toId]).slice(1, -1));

  const placeOneDay = (u: Unit, visits: number[], month: string, seg: number | null, noMerge: boolean): boolean => {
    for (const allowSpare of [false, true]) {
      const cand = days.filter(
        (d) => d.month === month && (seg == null || d.segment === seg) && d.segment >= 0 &&
          (d.kind === null || d.kind === 'free') &&
          (d.driving || (allowSpare && d.spare)) &&
          journeysOf(d.seq).length < MAX_JOURNEYS_PER_DAY,
      ).filter((d) => rulesOk([{ day: d, arrivals: visits }]));
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
      count(u, month);
      return true;
    }
    return false;
  };

  /** Several consecutive days (template or a far trip with nights away). */
  const placeSpan = (u: Unit, seqs: number[][], kind: DayKind, label: string, month: string, seg: number | null, weekdays: number[]) => {
    // a user-designed template may visit a place several times a day on purpose
    const perDay = kind !== 'template';
    const starts = days.filter((d) => {
      if (d.month !== month || !spanFree(d.index, seqs.length)) return false;
      const span = days.slice(d.index, d.index + seqs.length);
      if (span.some((x) => x.segment < 0 || x.segment !== (seg ?? d.segment))) return false;
      if (weekdays.length ? !weekdays.includes(((weekday(d.date) + 6) % 7) + 1) : !d.driving) return false;
      const last = span[span.length - 1];
      if (seqs[seqs.length - 1].length && !(last.driving || last.spare)) return false;
      return rulesOk(span.map((x, i) => ({ day: x, arrivals: seqs[i].slice(1), replace: true })), perDay);
    });
    const start = pick(starts);
    if (!start) return false;
    const unit = newUnit();
    seqs.forEach((seq, i) => {
      const day = days[start.index + i];
      Object.assign(day, { kind, label, unitId: unit, ruleKey: i === 0 ? u.key : undefined, fixed: true, seq: [] });
      setSeq(day, seq);
    });
    count(u, month);
    return true;
  };

  /** Far route: sometimes stay there for 1–2 nights, with local trips in between. */
  const farPlan = (r: Route): number[][] | null => {
    const visits = routeVisits(r);
    if (req.farKm == null || !visits.length) return null;
    const oneWay = km(base, visits[0]);
    if (oneWay < req.farKm) return null;
    const pStay = oneWay * 2 > LONG_DAY_KM ? 1 : Math.min(0.9, 0.5 + (oneWay - req.farKm) / (req.farKm * 2));
    if (rnd() > pStay) return null;
    const there = visits[visits.length - 1];
    const near = [...ctx.destinations.keys()].filter((id) => {
      if (id === base || id === there) return false;
      try { return km(there, id) <= NEAR_KM; } catch { return false; }
    });
    const middle = rnd() < 0.6 ? 1 : 2;
    const seqs: number[][] = [[base, ...visits]];
    for (let i = 0; i < middle; i++) {
      const n = near.length && rnd() < 0.6 ? pick(near)! : null;
      seqs.push(n ? [there, n, there] : []);
    }
    seqs.push([there, base]);
    return seqs;
  };

  /** Place one occurrence of a unit; returns false when it does not fit anywhere. */
  const placeUnit = (u: Unit, month: string, seg: number | null, noMerge = false): boolean => {
    if (u.template) {
      return placeSpan(u, expandTemplate(u.template), 'template', u.template.name, month, seg, u.template.startWeekdays);
    }
    const far = noMerge ? null : farPlan(u.route!);
    if (far && placeSpan(u, far, 'trip', `Többnapos út: ${name(routeVisits(u.route!).slice(-1)[0])}`, month, seg, [])) return true;
    return placeOneDay(u, routeVisits(u.route!), month, seg, noMerge);
  };

  const unitUnits = (u: Unit) =>
    u.template ? expandTemplate(u.template).reduce((s, q) => s + seqUnits(q), 0) : seqUnits(journeyStops(base, routeVisits(u.route!)));

  // ---------- step 1: monthly minimums ----------
  for (const month of months) {
    for (const u of units) {
      for (let k = counts.get(`${u.key}|${month}`) ?? 0; k < u.min; k++) {
        if (!placeUnit(u, month, null)) {
          warnings.push(`${month}: a(z) „${u.label}” havi minimuma (${u.min}) nem fért bele — nincs elég szabad nap vagy ütközik egy szabállyal.`);
          break;
        }
      }
    }
  }
  segments.forEach((s) => {
    if (s.used > s.target)
      warnings.push(`${s.label}: a havi minimumok miatt ${((s.used - s.target) / UNIT).toFixed(1)} km-rel több út került be, mint amennyit a km-óra enged.`);
  });

  // ---------- step 2: fill every segment up to its target ----------
  const isFar = (u: Unit) => !!u.route && req.farKm != null && km(base, routeVisits(u.route)[0]) >= req.farKm;
  const oneDayUnits = (u: Unit) => !u.template && !isFar(u);
  const maxUnits = Math.max(0, ...units.filter(oneDayUnits).map(unitUnits));
  segments.forEach((seg, s) => {
    const segMonths = months.filter((m) => days.some((d) => d.segment === s && d.month === m && !d.kind));

    // 2a: random walk until the remainder is small
    const threshold = Math.max(maxUnits * 2, 60 * UNIT);
    const failed = new Set<string>();
    for (let guard = 0; guard < 20000; guard++) {
      const rest = seg.target - seg.used;
      if (rest <= threshold) break;
      const options: { u: Unit; m: string }[] = [];
      for (const m of segMonths) {
        for (const u of units) {
          if (failed.has(`${u.key}|${m}`) || unitUnits(u) > rest || capLeft(u, m) <= 0) continue;
          options.push({ u, m });
        }
      }
      const o = pick(options, ({ u, m }) => {
        const free = days.filter((d) => d.segment === s && d.month === m && !d.kind && d.driving).length;
        return ((free + 1) / (1 + (counts.get(`${u.key}|${m}`) ?? 0))) * (u.template ? 0.6 : 1);
      });
      if (!o) break;
      if (!placeUnit(o.u, o.m, s)) failed.add(`${o.u.key}|${o.m}`);
    }

    // 2b: exact finish with a bounded 0/1 knapsack of plain one-day trips. Repeated a few times,
    // because the rules (once a day, minimum gap) can make some picks impossible to place.
    const simple = units.filter(oneDayUnits);
    for (let round = 0; round < 4 && simple.length; round++) {
      const rest = seg.target - seg.used;
      if (Math.abs(rest) < UNIT) break;
      if (rest <= 0) break;
      const items: { u: Unit; m: string; n: number; units: number }[] = [];
      for (const m of segMonths) {
        for (const u of simple) {
          const visits = routeVisits(u.route!);
          const slots = days.filter((d) => d.segment === s && d.month === m && (d.kind === null || d.kind === 'free') &&
            (d.driving || d.spare) && journeysOf(d.seq).length < MAX_JOURNEYS_PER_DAY && rulesOk([{ day: d, arrivals: visits }])).length;
          const uu = unitUnits(u);
          let cap = Math.min(capLeft(u, m), slots, Math.ceil(rest / uu) + 1);
          for (let p = 1; cap > 0; p *= 2) {
            const n = Math.min(p, cap);
            items.push({ u, m, n, units: n * uu });
            cap -= n;
          }
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
        for (let k = 0; k < it.n; k++) placeOneDay(it.u, routeVisits(it.u.route!), it.m, s, true);
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
    if (dayKm > LONG_DAY_KM) warnings.push(`${d.date}: ${dayKm.toFixed(0)} km egy nap alatt — ez sok lehet.`);
    if (!d.driving && !d.spare && d.kind === 'free') warnings.push(`${d.date}: vasárnapra vagy ünnepnapra került út.`);
    const arrivals = d.seq.slice(1);
    for (const id of new Set(visitsIn(arrivals))) {
      const n = arrivals.filter((x) => x === id).length;
      if (n > maxPerDay(id) && d.kind !== 'free') warnings.push(`${d.date}: ${name(id)} ${n}× szerepel egy napon.`);
    }
  }
  const spareUsed = days.filter((d) => d.kind === 'free' && !d.driving).length;
  if (spareUsed) warnings.push(`${spareUsed} szombati napra is került út, mert a hétköznapok beteltek.`);
  if (where !== base) warnings.push(`Az időszak végén az autó nem a telephelyen áll (${name(where)}).`);
  for (const u of units) {
    if (u.max != null && u.min > u.max) warnings.push(`„${u.label}”: a havi minimum nagyobb a maximumnál.`);
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
