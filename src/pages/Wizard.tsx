import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, download, fmtDate, fmtInt, fmtKm, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { MonthGrid } from '../components/MonthGrid';
import { PlaceSearch } from '../components/PlaceSearch';
import { ResultView } from '../components/ResultView';
import { Field, Modal, Odometer, PageHead, Plate, useToast } from '../components/ui';
import { defaultFuelPrices, rememberFuelPrices } from '../fuel';
import { dayLabels, dayText, frequencyText, templateLength } from './Templates';
import { isDrivingDay, addDays, lastDayOfMonth, monthLabel, monthRange } from '../../shared/calendar';
import type {
  Company, DayPlan, Destination, Driver, GenerateRequest, GenerateResult, OdometerCheckpoint, PlanEntry, RequiredStop, Route,
  RouteRule, TemplateRule, TourChance, TripTemplate, Vehicle,
} from '../../shared/types';

const STEPS = ['Szereplők', 'Időszak és km', 'Naptár', 'Utak és utazások', 'Eredmény'];
const PREFS = 'menet-mester:generator-prefs';

type Rule = { on: boolean; min: string; max: string };

const prevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

interface Prefs { routes: Record<number, Rule>; templates: Record<number, Rule>; tourChance: TourChance; farOn: boolean; farKm: number }
function loadPrefs(): Partial<Prefs> {
  try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}'); } catch { return {}; }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS, JSON.stringify(p)); } catch { /* not critical */ }
}

interface Stop extends RequiredStop { key: string; enabled: boolean }

export function WizardPage() {
  const companies = useCollection<Company>('companies');
  const vehicles = useCollection<Vehicle>('vehicles');
  const drivers = useCollection<Driver>('drivers');
  const dests = useCollection<Destination>('destinations');
  const routes = useCollection<Route>('routes');
  const templates = useCollection<TripTemplate>('templates');
  const toast = useToast();
  const navigate = useNavigate();
  const prefs = useMemo(loadPrefs, []);

  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  const [driverId, setDriverId] = useState<number | null>(null);
  const [fromMonth, setFromMonth] = useState(prevMonth());
  const [toMonth, setToMonth] = useState(prevMonth());
  const [startOdo, setStartOdo] = useState<number | ''>('');
  const [endOdo, setEndOdo] = useState<number | ''>('');
  const [baseId, setBaseId] = useState<number | null>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [checkpoints, setCheckpoints] = useState<OdometerCheckpoint[]>([]);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [fetchedFor, setFetchedFor] = useState('');
  const [rules, setRules] = useState<Record<number, Rule>>(prefs.routes ?? {});
  const [tplRules, setTplRules] = useState<Record<number, Rule>>(prefs.templates ?? {});
  const [tourChance, setTourChance] = useState<TourChance>(prefs.tourChance ?? 'sometimes');
  const [farOn, setFarOn] = useState(prefs.farOn ?? true);
  const [farKm, setFarKm] = useState(prefs.farKm ?? 200);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [lastReq, setLastReq] = useState<GenerateRequest | null>(null);
  const [lockedUnits, setLockedUnits] = useState<Set<string>>(new Set());
  const [fuel, setFuel] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState<string[] | null>(null);
  const [busyAt, setBusyAt] = useState(0);
  const [error, setError] = useState('');

  // sensible defaults once data is loaded
  useEffect(() => { if (companyId == null && companies.items[0]) setCompanyId(companies.items[0].id); }, [companies.items, companyId]);
  useEffect(() => { if (vehicleId == null && vehicles.items[0]) setVehicleId(vehicles.items[0].id); }, [vehicles.items, vehicleId]);
  useEffect(() => { if (driverId == null && drivers.items[0]) setDriverId(drivers.items[0].id); }, [drivers.items, driverId]);
  useEffect(() => {
    const c = companies.items.find((x) => x.id === companyId);
    if (c?.homeDestinationId) setBaseId(c.homeDestinationId);
  }, [companyId, companies.items]);
  useEffect(() => {
    setRules((r) => {
      const next = { ...r };
      for (const rt of routes.items) if (!next[rt.id]) next[rt.id] = { on: true, min: '', max: '' };
      return next;
    });
  }, [routes.items]);
  useEffect(() => {
    setTplRules((r) => {
      const next = { ...r };
      for (const t of templates.items) {
        if (!next[t.id]) next[t.id] = { on: true, min: t.minPerMonth != null ? String(t.minPerMonth) : '', max: t.maxPerMonth != null ? String(t.maxPerMonth) : '' };
      }
      return next;
    });
  }, [templates.items]);
  useEffect(() => savePrefs({ routes: rules, templates: tplRules, tourChance, farOn, farKm }), [rules, tplRules, tourChance, farOn, farKm]);

  const months = useMemo(() => (fromMonth && toMonth && fromMonth <= toMonth ? monthRange(fromMonth, toMonth) : []), [fromMonth, toMonth]);
  const period = { from: `${fromMonth}-01`, to: toMonth ? lastDayOfMonth(toMonth) : '' };
  const workdays = useMemo(() => {
    if (!months.length) return 0;
    let n = 0;
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) if (isDrivingDay(d)) n++;
    return n;
  }, [months]); // eslint-disable-line react-hooks/exhaustive-deps
  const targetKm = startOdo !== '' && endOdo !== '' ? endOdo - startOdo : 0;
  const destById = useMemo(() => new Map(dests.items.map((d) => [d.id, d])), [dests.items]);
  const tplById = useMemo(() => new Map(templates.items.map((t) => [t.id, t])), [templates.items]);

  // ---------- validation per step ----------
  const stepError = (s: number): string => {
    if (s === 0) return !companyId || !vehicleId || !driverId ? 'Válassz céget, járművet és sofőrt.' : '';
    if (s === 1) {
      if (!months.length) return 'A kezdő hónap nem lehet a záró hónap után.';
      if (months.length > 24) return 'Legfeljebb 24 hónap generálható egyszerre.';
      if (startOdo === '' || endOdo === '') return 'Add meg a kezdő és a záró km-állást.';
      if (endOdo <= startOdo) return 'A záró km-állásnak nagyobbnak kell lennie a kezdőnél.';
      if (!baseId) return 'Válaszd ki a telephelyet, ahonnan az utak indulnak.';
      return '';
    }
    if (s === 2) {
      const marks = [
        ...stops.filter((x) => x.enabled && x.odometer != null).map((x) => ({ date: x.date, odo: x.odometer!, what: x.label })),
        ...checkpoints.map((c) => ({ date: c.date, odo: c.odometer, what: 'km-állás' })),
        ...plan.flatMap((e) => (e.type === 'visit' && e.odometer != null ? [{ date: e.date, odo: e.odometer, what: 'látogatás' }] : [])),
      ].sort((a, b) => a.date.localeCompare(b.date));
      let prev = Number(startOdo);
      for (const m of marks) {
        if (m.odo < prev || m.odo > Number(endOdo))
          return `${fmtDate(m.date)} (${m.what}): a ${fmtInt(m.odo)} km nem fér bele a ${fmtInt(prev)} – ${fmtInt(Number(endOdo))} km tartományba.`;
        prev = m.odo;
      }
      return '';
    }
    if (s === 3) {
      const on = [...Object.entries(rules), ...Object.entries(tplRules)].filter(([, r]) => r.on);
      if (!on.length && !plan.length && !stops.some((x) => x.enabled)) return 'Válassz ki legalább egy utat vagy utazást.';
      for (const [, r] of on) if (r.min && r.max && Number(r.min) > Number(r.max)) return 'Valamelyik sorban a minimum nagyobb a maximumnál.';
      return '';
    }
    return '';
  };

  const runSteps = async (labels: string[], work: () => Promise<void>) => {
    setBusy(labels); setBusyAt(0); setError('');
    const tick = setInterval(() => setBusyAt((i) => Math.min(i + 1, labels.length - 1)), 650);
    const minShow = new Promise((r) => setTimeout(r, 1300)); // let the steps be readable
    try {
      await Promise.all([work(), minShow]);
    } finally {
      clearInterval(tick);
      setBusy(null);
    }
  };

  const fetchIntegrations = async () => {
    const sig = `${vehicleId}|${fromMonth}|${toMonth}`;
    if (sig === fetchedFor) return;
    await runSteps(['Járműnapló átnézése', 'Szerviz- és vizsgaesemények szűrése az időszakra', 'Naptár előkészítése'], async () => {
      const res = await api<{ provider: string; ok: boolean; error?: string; stops: RequiredStop[] }[]>(
        `/api/integrations/stops?vehicleId=${vehicleId}&fromMonth=${fromMonth}&toMonth=${toMonth}`,
      );
      setStops(res.flatMap((r) => r.stops.map((s, i) => ({ ...s, key: `${r.provider}-${s.date}-${i}`, enabled: true }))));
      const failed = res.filter((r) => !r.ok);
      if (failed.length) toast(`Nem elérhető forrás: ${failed.map((f) => f.provider).join(', ')}`, true);
      setFetchedFor(sig);
    });
  };

  const buildRequest = (seed?: number, locked: DayPlan[] = []): GenerateRequest => ({
    companyId: companyId!, vehicleId: vehicleId!, driverId: driverId!, baseDestinationId: baseId!,
    startOdometer: Number(startOdo), endOdometer: Number(endOdo), fromMonth, toMonth,
    stops: stops.filter((s) => s.enabled).map(({ date, destinationId, odometer, label, source }) => ({ date, destinationId, odometer, label, source })),
    checkpoints,
    plan: plan.filter((e) => e.date >= period.from && e.date <= period.to),
    routes: Object.entries(rules).filter(([id, r]) => r.on && routes.items.some((x) => x.id === Number(id))).map(([id, r]): RouteRule => ({
      routeId: Number(id), minPerMonth: r.min ? Number(r.min) : null, maxPerMonth: r.max ? Number(r.max) : null,
    })),
    templates: Object.entries(tplRules).filter(([id, r]) => r.on && tplById.has(Number(id))).map(([id, r]): TemplateRule => ({
      templateId: Number(id), minPerMonth: r.min ? Number(r.min) : null, maxPerMonth: r.max ? Number(r.max) : null,
    })),
    locked,
    tourChance,
    farKm: farOn ? farKm : null,
    seed,
  });

  const runGenerate = async (keepLocked = false) => {
    const locked = keepLocked && result ? result.days.filter((d) => lockedUnits.has(d.unitId)) : [];
    const req = buildRequest(undefined, locked);
    try {
      await runSteps(['Távolságok kiszámítása a térképen', 'Munkanapok és ünnepnapok kijelölése', 'Naptár bejegyzéseinek beillesztése', 'Utak és utazások elosztása', 'Életszerűség ellenőrzése'], async () => {
        const r = await api<GenerateResult>('/api/generate', { method: 'POST', json: req });
        setResult(r);
        setLastReq({ ...req, seed: r.seed });
        if (!keepLocked) setLockedUnits(new Set());
        setFuel((f) => ({ ...defaultFuelPrices(r.months.map((m) => m.month)), ...f }));
      });
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };

  const go = async (to: number) => {
    if (to > step) {
      for (let s = step; s < to; s++) {
        const err = stepError(s);
        if (err) { setError(err); setStep(s); return; }
      }
    }
    setError('');
    if (to === 2) await fetchIntegrations().catch((e) => setError((e as Error).message));
    if (to === 4 && !(await runGenerate())) return;
    setStep(to);
    setReached((r) => Math.max(r, to));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const vehicle = vehicles.items.find((v) => v.id === vehicleId);

  return (
    <>
      <PageHead eyebrow={`${step + 1}. lépés / ${STEPS.length}`} title="Útnyilvántartás generálása"
        text="Lépésről lépésre: szereplők, km-óra és időszak, amit biztosan tudsz a naptárba, majd az utak — a végén ellenőrizheted, rögzítheted és letöltheted." />

      <div className="road" aria-label="Lépések">
        {STEPS.map((s, i) => (
          <div key={s} className={`road-step ${i < step || (i <= reached && i !== step) ? 'done' : ''} ${i === step ? 'now' : ''}`}
            onClick={() => i <= reached && i !== step && !busy && go(i)}>
            <div className="km">{i + 1}</div>
            <div className="lbl">{s}</div>
            {i < STEPS.length - 1 && <div className="line" />}
          </div>
        ))}
      </div>

      {busy ? (
        <div className="card loading-road">
          <div className="track"><span className="car">🚗</span></div>
          <h2>Dolgozunk rajta…</h2>
          <ul>{busy.map((b, i) => <li key={b} className={i < busyAt ? 'done' : i === busyAt ? 'now' : 'todo'}>{b}</li>)}</ul>
        </div>
      ) : (
        <>
          {step === 0 && (
            <div>
              <PickSection n="A" title="Cég" items={companies.items} selected={companyId} onSelect={setCompanyId}
                render={(c) => <><b>{c.name}</b><small>{c.address}</small><small>Adószám: {c.taxNumber}</small></>} />
              <PickSection n="B" title="Jármű" items={vehicles.items} selected={vehicleId} onSelect={setVehicleId}
                render={(v) => <><Plate value={v.plate} /><b style={{ marginTop: 6 }}>{v.model}</b><small>{v.category} · {v.fuel} · {String(v.consumption).replace('.', ',')} L/100km</small></>} />
              <PickSection n="C" title="Sofőr" items={drivers.items} selected={driverId} onSelect={setDriverId}
                render={(d) => <><b>{d.name}</b><small>{d.address}</small><small>Adóazonosító: {d.taxNumber}</small></>} />
            </div>
          )}

          {step === 1 && (
            <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' }}>
              <div className="card card-pad stack" style={{ gap: 22 }}>
                <div>
                  <div className="section-title"><span className="n">1</span><h3>Időszak</h3></div>
                  <div className="grid cols-2">
                    <Field label="Első hónap"><input type="month" className="input" value={fromMonth} onChange={(e) => { setFromMonth(e.target.value); if (e.target.value > toMonth) setToMonth(e.target.value); }} /></Field>
                    <Field label="Utolsó hónap"><input type="month" className="input" value={toMonth} min={fromMonth} onChange={(e) => setToMonth(e.target.value)} /></Field>
                  </div>
                </div>
                <div>
                  <div className="section-title"><span className="n">2</span><h3>Kilométeróra</h3></div>
                  <div className="grid cols-2">
                    <Field label={`Kezdő állás (${fromMonth ? monthLabel(fromMonth) : ''} eleje)`}><Odometer value={startOdo} onChange={setStartOdo} autoFocus /></Field>
                    <Field label={`Záró állás (${toMonth ? monthLabel(toMonth) : ''} vége)`}><Odometer value={endOdo} onChange={setEndOdo} /></Field>
                  </div>
                </div>
                <div>
                  <div className="section-title"><span className="n">3</span><h3>Telephely</h3></div>
                  <Field label="Innen indulnak és ide térnek vissza az utak" hint="Alapértelmezés: a cégnél beállított telephely">
                    <select className="input" value={baseId ?? ''} onChange={(e) => setBaseId(e.target.value ? Number(e.target.value) : null)}>
                      <option value="">— válassz —</option>
                      {dests.items.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.address}</option>)}
                    </select>
                  </Field>
                </div>
              </div>
              <div className="card card-pad stack sticky" style={{ background: 'var(--asphalt)', color: '#fff', borderColor: 'var(--asphalt)' }}>
                <div className="eyebrow" style={{ color: '#9a9ca5' }}>Összefoglaló</div>
                <SummaryRow k="Hónapok" v={months.length ? `${months.length} hónap` : '—'} />
                <SummaryRow k="Munkanapok" v={workdays ? `${workdays} nap` : '—'} />
                <SummaryRow k="Lefedendő" v={targetKm > 0 ? `${fmtInt(targetKm)} km` : '—'} big />
                <SummaryRow k="Átlag / hónap" v={targetKm > 0 && months.length ? `${fmtInt(targetKm / months.length)} km` : '—'} />
                <SummaryRow k="Átlag / munkanap" v={targetKm > 0 && workdays ? `${fmtKm(targetKm / workdays)} km` : '—'} />
              </div>
            </div>
          )}

          {step === 2 && (
            <PlannerStep months={months} period={period} stops={stops} setStops={setStops}
              checkpoints={checkpoints} setCheckpoints={setCheckpoints} plan={plan} setPlan={setPlan}
              templates={templates.items} tplById={tplById} destinations={dests.items} destById={destById} reloadDests={dests.reload}
              onRefetch={() => { setFetchedFor(''); setTimeout(() => fetchIntegrations(), 0); }} />
          )}

          {step === 3 && (
            <RoutesStep routes={routes.items} rules={rules} setRules={setRules} templates={templates.items} tplRules={tplRules} setTplRules={setTplRules}
              destById={destById} baseId={baseId!} targetKm={targetKm} months={months.length} workdays={workdays}
              tourChance={tourChance} setTourChance={setTourChance} farOn={farOn} setFarOn={setFarOn} farKm={farKm} setFarKm={setFarKm} />
          )}

          {step === 4 && result && lastReq && (
            <ResultView result={result} vehicle={vehicle} destById={destById} fuelPrices={fuel}
              onFuelPrice={(m, p) => setFuel({ ...fuel, [m]: p })}
              lockedUnits={lockedUnits}
              onToggleLock={(unit) => setLockedUnits((s) => { const n = new Set(s); if (n.has(unit)) n.delete(unit); else n.add(unit); return n; })} />
          )}
        </>
      )}

      {!busy && (
        <div className="wizard-foot">
          {step > 0 && <button className="btn" onClick={() => go(step - 1)}><Icon name="arrowLeft" />Vissza</button>}
          {error && <span className="note err" style={{ padding: '8px 12px' }}><Icon name="alert" />{error}</span>}
          <div className="spacer" />
          {step < 3 && <button className="btn btn-primary" onClick={() => go(step + 1)}>Tovább<Icon name="arrowRight" /></button>}
          {step === 3 && <button className="btn btn-sign" onClick={() => go(4)}><Icon name="sparkles" />Generálás</button>}
          {step === 4 && result && lastReq && (
            <>
              <button className="btn" onClick={() => runGenerate(true)} title={lockedUnits.size ? 'A rögzített napok maradnak, a többi újra lesz sorsolva' : undefined}>
                <Icon name="refresh" />Új változat{lockedUnits.size ? ` (${result.days.filter((d) => lockedUnits.has(d.unitId)).length} nap rögzítve)` : ''}
              </button>
              <button className="btn" onClick={async () => {
                const title = `${vehicle?.plate ?? ''} · ${monthLabel(fromMonth)}${fromMonth !== toMonth ? ' – ' + monthLabel(toMonth) : ''}`;
                const { id } = await api<{ id: number }>('/api/reports', { method: 'POST', json: { title, request: lastReq, result, fuelPrices: fuel } });
                rememberFuelPrices(fuel);
                toast('Nyilvántartás elmentve');
                navigate(`/nyilvantartasok/${id}`);
              }}><Icon name="save" />Mentés</button>
              <button className="btn btn-sign" onClick={async () => {
                rememberFuelPrices(fuel);
                await download('/api/export', { request: lastReq, result, fuelPrices: fuel }, 'utnyilvantartas.xlsx').catch((e) => toast(e.message, true));
              }}><Icon name="download" />Excel letöltése</button>
            </>
          )}
        </div>
      )}
    </>
  );
}

function SummaryRow({ k, v, big }: { k: string; v: string; big?: boolean }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', borderBottom: '1px dashed #2a3b63', paddingBottom: 10 }}>
      <span style={{ color: '#9a9ca5' }}>{k}</span>
      <span className="mono" style={{ fontSize: big ? 26 : 16, fontWeight: 700, color: big ? 'var(--brand-2)' : '#fff' }}>{v}</span>
    </div>
  );
}

function PickSection<T extends { id: number }>({ n, title, items, selected, onSelect, render }: {
  n: string; title: string; items: T[]; selected: number | null; onSelect: (id: number) => void; render: (t: T) => React.ReactNode;
}) {
  return (
    <>
      <div className="section-title"><span className="n">{n}</span><h3>{title}</h3>
        {items.length === 0 && <Link className="small muted" to="/torzsadatok">— még nincs felvéve, vegyél fel egyet a törzsadatoknál</Link>}
      </div>
      <div className="pick-grid">
        {items.map((it) => (
          <button key={it.id} className={`pick ${it.id === selected ? 'on' : ''}`} onClick={() => onSelect(it.id)}>{render(it)}</button>
        ))}
      </div>
    </>
  );
}

// ---------- step 3: planner calendar ----------
type CellItem =
  | { kind: 'stop'; stop: Stop }
  | { kind: 'cp'; cp: OdometerCheckpoint }
  | { kind: 'visit'; entry: Extract<PlanEntry, { type: 'visit' }> }
  | { kind: 'tpl'; entry: Extract<PlanEntry, { type: 'template' }>; dayIndex: number; length: number };

function PlannerStep({
  months, period, stops, setStops, checkpoints, setCheckpoints, plan, setPlan, templates, tplById, destinations, destById, reloadDests, onRefetch,
}: {
  months: string[]; period: { from: string; to: string };
  stops: Stop[]; setStops: (s: Stop[]) => void;
  checkpoints: OdometerCheckpoint[]; setCheckpoints: (c: OdometerCheckpoint[]) => void;
  plan: PlanEntry[]; setPlan: (p: PlanEntry[]) => void;
  templates: TripTemplate[]; tplById: Map<number, TripTemplate>;
  destinations: Destination[]; destById: Map<number, Destination>; reloadDests: () => Promise<void>; onRefetch: () => void;
}) {
  const [mi, setMi] = useState(0);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const month = months[Math.min(mi, months.length - 1)];

  // what is on each date (templates spread over their days)
  const byDate = useMemo(() => {
    const map = new Map<string, CellItem[]>();
    const add = (d: string, it: CellItem) => map.set(d, [...(map.get(d) ?? []), it]);
    stops.forEach((s) => add(s.date, { kind: 'stop', stop: s }));
    checkpoints.forEach((c) => add(c.date, { kind: 'cp', cp: c }));
    for (const e of plan) {
      if (e.type === 'visit') add(e.date, { kind: 'visit', entry: e });
      else {
        const t = tplById.get(e.templateId);
        const len = t ? templateLength(t) : 1;
        for (let i = 0; i < len; i++) add(addDays(e.date, i), { kind: 'tpl', entry: e, dayIndex: i, length: len });
      }
    }
    return map;
  }, [stops, checkpoints, plan, tplById]);

  const conflicts = [...byDate.entries()].filter(([, items]) => items.filter((i) => i.kind !== 'cp' && (i.kind !== 'stop' || i.stop.enabled)).length > 1).map(([d]) => d).sort();
  const datedTemplates = templates.filter((t) => t.onlyDates.some((d) => d >= period.from && d <= period.to));

  const addTemplate = (date: string, templateId: number) =>
    setPlan([...plan, { id: `p${Date.now()}`, date, type: 'template', templateId }]);

  const cellText = (it: CellItem) => {
    if (it.kind === 'stop') return it.stop.label.split(':')[0] + ' · ' + (destById.get(it.stop.destinationId)?.name ?? '');
    if (it.kind === 'cp') return `${fmtInt(it.cp.odometer)} km`;
    if (it.kind === 'visit') return it.entry.destinationIds.map((id) => destById.get(id)?.name).join(', ');
    const t = tplById.get(it.entry.templateId);
    return it.dayIndex === 0 ? t?.name ?? 'Sablon' : `↳ ${t?.name ?? ''}`;
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px', alignItems: 'start' }}>
      <div className="card card-pad stack">
        <div className="row">
          <button className="btn btn-ghost icon-btn" disabled={mi === 0} onClick={() => setMi(mi - 1)} aria-label="Előző hónap"><Icon name="arrowLeft" /></button>
          <h3 style={{ minWidth: 170, textAlign: 'center' }}>{monthLabel(month)}</h3>
          <button className="btn btn-ghost icon-btn" disabled={mi >= months.length - 1} onClick={() => setMi(mi + 1)} aria-label="Következő hónap"><Icon name="arrowRight" /></button>
          <div className="spacer" />
          <span className="muted small">Kattints egy napra, vagy húzz rá egy sablont.</span>
        </div>
        <MonthGrid month={month}
          onCellClick={(d) => setOpenDay(d)}
          onDropOn={(d, data) => { const id = Number(data.replace('tpl:', '')); if (data.startsWith('tpl:') && id) addTemplate(d, id); }}
          cellClass={(d) => (conflicts.includes(d) ? 'conflict' : '')}
          cell={(d) => (
            <div className="mgrid-items">
              {(byDate.get(d) ?? []).map((it, i) => (
                <span key={i} title={cellText(it)} className={`citem ${it.kind} ${it.kind === 'stop' && !it.stop.enabled ? 'off' : ''} ${it.kind === 'tpl' && it.dayIndex > 0 ? 'cont' : ''}`}>
                  {cellText(it)}
                </span>
              ))}
            </div>
          )} />
        <div className="row wrap small" style={{ gap: 14 }}>
          <span className="legend"><i className="citem stop" />járműnapló</span>
          <span className="legend"><i className="citem visit" />megadott látogatás</span>
          <span className="legend"><i className="citem tpl" />utazás-sablon</span>
          <span className="legend"><i className="citem cp" />km-állás</span>
          <span className="legend"><i className="lg-off" />hétvége / ünnep</span>
        </div>
        {conflicts.length > 0 && (
          <div className="note warn"><Icon name="alert" /><span>Ütközés ezeken a napokon: {conflicts.map(fmtDate).join(', ')}. A generátor a járműnapló eseményeit tartja meg, a többit kihagyja.</span></div>
        )}
      </div>

      <div className="stack sticky">
        <div className="card card-pad stack" style={{ gap: 10 }}>
          <div className="row"><h3 style={{ flex: 1 }}>Utazás-sablonok</h3><Link to="/sablonok" className="btn btn-sm btn-ghost">Kezelés</Link></div>
          {templates.length === 0 && <p className="muted small">Még nincs sablon. Az „Utazás-sablonok” oldalon tudsz felvenni, pl. egy hétfőtől péntekig tartó utat.</p>}
          {templates.map((t) => (
            <div key={t.id} className="drag-tpl" draggable onDragStart={(e) => { e.dataTransfer.setData('text/plain', `tpl:${t.id}`); e.dataTransfer.effectAllowed = 'copy'; }}
              title="Húzd rá a naptárban arra a napra, amikor indult">
              <Icon name="calendar" size={16} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{t.name}</b>
                <div className="muted small">{templateLength(t)} nap · {frequencyText(t)}</div>
              </div>
              <span className="muted">⋮⋮</span>
            </div>
          ))}
          {datedTemplates.length > 0 && (
            <p className="small muted">{datedTemplates.map((t) => t.name).join(', ')}: a megadott dátumokon magától bekerül.</p>
          )}
        </div>
        <div className="card card-pad stack" style={{ gap: 8 }}>
          <div className="row"><h3 style={{ flex: 1 }}>Járműnapló</h3><button className="btn btn-sm btn-ghost" onClick={onRefetch}><Icon name="refresh" />Újra</button></div>
          {stops.length === 0 ? (
            <p className="muted small">Erre az időszakra nincs szerviz- vagy vizsgaesemény.</p>
          ) : stops.map((s) => (
            <label key={s.key} className="row small" style={{ gap: 8 }}>
              <input type="checkbox" className="check" checked={s.enabled} onChange={(e) => setStops(stops.map((x) => (x.key === s.key ? { ...x, enabled: e.target.checked } : x)))} />
              <span className="mono">{fmtDate(s.date)}</span><span style={{ flex: 1 }}>{s.label}</span>
            </label>
          ))}
        </div>
      </div>

      {openDay && (
        <DayModal date={openDay} items={byDate.get(openDay) ?? []} templates={templates} tplById={tplById} destinations={destinations} destById={destById}
          reloadDests={reloadDests} onClose={() => setOpenDay(null)}
          onAddVisit={(ids, odo) => setPlan([...plan, { id: `p${Date.now()}`, date: openDay, type: 'visit', destinationIds: ids, odometer: odo }])}
          onAddTemplate={(id) => addTemplate(openDay, id)}
          onAddCheckpoint={(odo) => setCheckpoints([...checkpoints.filter((c) => c.date !== openDay), { date: openDay, odometer: odo }])}
          onRemove={(it) => {
            if (it.kind === 'cp') setCheckpoints(checkpoints.filter((c) => c !== it.cp));
            if (it.kind === 'visit' || it.kind === 'tpl') setPlan(plan.filter((e) => e.id !== it.entry.id));
            if (it.kind === 'stop') setStops(stops.map((x) => (x.key === it.stop.key ? { ...x, enabled: !x.enabled } : x)));
          }} />
      )}
    </div>
  );
}

function DayModal({ date, items, templates, tplById, destinations, destById, reloadDests, onClose, onAddVisit, onAddTemplate, onAddCheckpoint, onRemove }: {
  date: string; items: CellItem[]; templates: TripTemplate[]; tplById: Map<number, TripTemplate>;
  destinations: Destination[]; destById: Map<number, Destination>; reloadDests: () => Promise<void>;
  onClose: () => void; onAddVisit: (ids: number[], odo: number | null) => void; onAddTemplate: (id: number) => void;
  onAddCheckpoint: (odo: number) => void; onRemove: (it: CellItem) => void;
}) {
  const [mode, setMode] = useState<'visit' | 'tpl' | 'cp'>('visit');
  const [ids, setIds] = useState<number[]>([]);
  const [text, setText] = useState('');
  const [odo, setOdo] = useState<number | ''>('');
  const [tplId, setTplId] = useState<number | ''>(templates[0]?.id ?? '');
  const weekdayName = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'][new Date(`${date}T00:00:00Z`).getUTCDay()];
  const tpl = tplId ? tplById.get(tplId) : undefined;

  const add = () => {
    if (mode === 'visit') { if (!ids.length) return; onAddVisit(ids, odo === '' ? null : odo); }
    if (mode === 'tpl') { if (!tplId) return; onAddTemplate(tplId); }
    if (mode === 'cp') { if (odo === '') return; onAddCheckpoint(odo); }
    onClose();
  };

  return (
    <Modal title={`${fmtDate(date)} · ${weekdayName}`} subtitle="Mi történt ezen a napon? Amit itt megadsz, az pontosan így kerül a nyilvántartásba." onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Bezárás</button><button className="btn btn-primary" onClick={add}><Icon name="plus" />Hozzáadás</button></>}>
      {items.length > 0 && (
        <div className="stack" style={{ gap: 6 }}>
          {items.map((it, i) => (
            <div key={i} className="row small" style={{ gap: 8, padding: '8px 10px', background: 'var(--paper)', borderRadius: 10 }}>
              <span className={`citem ${it.kind}`} style={{ flex: 'none' }} />
              <span style={{ flex: 1 }}>
                {it.kind === 'stop' && <>{it.stop.label} — {destById.get(it.stop.destinationId)?.name}{it.stop.odometer != null && <> · <b className="mono">{fmtInt(it.stop.odometer)} km</b></>}</>}
                {it.kind === 'cp' && <>Km-óra a nap végén: <b className="mono">{fmtInt(it.cp.odometer)} km</b></>}
                {it.kind === 'visit' && <>Látogatás: {it.entry.destinationIds.map((id) => destById.get(id)?.name).join(' → ')}{it.entry.odometer != null && <> · <b className="mono">{fmtInt(it.entry.odometer)} km</b></>}</>}
                {it.kind === 'tpl' && <>{tplById.get(it.entry.templateId)?.name} — {it.dayIndex + 1}/{it.length}. nap</>}
              </span>
              <button className="btn btn-sm btn-ghost btn-danger" onClick={() => onRemove(it)}>{it.kind === 'stop' ? (it.stop.enabled ? 'Kihagy' : 'Visszavesz') : 'Törlés'}</button>
            </div>
          ))}
        </div>
      )}
      <div className="tabs">
        <button className={mode === 'visit' ? 'on' : ''} onClick={() => setMode('visit')}>Itt jártam</button>
        <button className={mode === 'tpl' ? 'on' : ''} onClick={() => setMode('tpl')}>Utazás indul</button>
        <button className={mode === 'cp' ? 'on' : ''} onClick={() => setMode('cp')}>Km-állás</button>
      </div>
      {mode === 'visit' && (
        <>
          <Field label="Hely(ek), ahol aznap jártál" hint="Több helyet is megadhatsz — ebben a sorrendben járja be, majd hazamegy.">
            <PlaceSearch saved={destinations} text={text} onText={setText} autoFocus
              onPick={async (p) => {
                const id = p.kind === 'saved' ? p.destination.id : (await api<Destination>('/api/destinations', {
                  method: 'POST', json: { name: p.suggestion.primary, address: p.suggestion.label, lat: p.suggestion.lat, lon: p.suggestion.lon },
                })).id;
                if (p.kind === 'address') await reloadDests();
                setIds([...ids, id]); setText('');
              }} />
          </Field>
          {ids.length > 0 && (
            <div className="tpl-chain">
              <span className="chip info">Telephely</span>
              {ids.map((id, i) => (
                <span key={i} className="row" style={{ gap: 6 }}><span className="muted">→</span>
                  <span className="chip">{destById.get(id)?.name}<button className="chip-x" onClick={() => setIds(ids.filter((_, j) => j !== i))}>×</button></span>
                </span>
              ))}
              <span className="muted">→</span><span className="chip info">Telephely</span>
            </div>
          )}
          <Field label="Km-állás érkezéskor (ha tudod)"><Odometer value={odo} onChange={setOdo} /></Field>
        </>
      )}
      {mode === 'tpl' && (
        templates.length === 0 ? <p className="muted">Még nincs utazás-sablon. <Link to="/sablonok">Vegyél fel egyet</Link>.</p> : (
          <>
            <Field label="Melyik utazás indul ezen a napon?">
              <select className="input" value={tplId} onChange={(e) => setTplId(Number(e.target.value))}>
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({templateLength(t)} nap)</option>)}
              </select>
            </Field>
            {tpl && (
              <div className="tpl-days">
                {tpl.days.map((d, i) => <div key={i} className="tpl-day"><span className="mono small">{fmtDate(addDays(date, tpl.days.slice(0, i).reduce((s, x) => s + x.repeat, 0)))}</span><span>{dayLabels(tpl.days)[i]}: {dayText(d, destById)}</span></div>)}
              </div>
            )}
          </>
        )
      )}
      {mode === 'cp' && <Field label="Km-óra állása a nap végén"><Odometer value={odo} onChange={setOdo} autoFocus /></Field>}
    </Modal>
  );
}

// ---------- step 4: routes, templates and realism ----------
const TOUR_OPTIONS: { v: TourChance; label: string }[] = [
  { v: 'never', label: 'Soha' }, { v: 'rare', label: 'Ritkán' }, { v: 'sometimes', label: 'Néha' }, { v: 'often', label: 'Gyakran' },
];

function RoutesStep({
  routes, rules, setRules, templates, tplRules, setTplRules, destById, baseId, targetKm, months, workdays,
  tourChance, setTourChance, farOn, setFarOn, farKm, setFarKm,
}: {
  routes: Route[]; rules: Record<number, Rule>; setRules: (r: Record<number, Rule>) => void;
  templates: TripTemplate[]; tplRules: Record<number, Rule>; setTplRules: (r: Record<number, Rule>) => void;
  destById: Map<number, Destination>; baseId: number; targetKm: number; months: number; workdays: number;
  tourChance: TourChance; setTourChance: (t: TourChance) => void; farOn: boolean; setFarOn: (b: boolean) => void; farKm: number; setFarKm: (n: number) => void;
}) {
  const set = (id: number, patch: Partial<Rule>) => setRules({ ...rules, [id]: { ...rules[id], ...patch } });
  const setT = (id: number, patch: Partial<Rule>) => setTplRules({ ...tplRules, [id]: { ...tplRules[id], ...patch } });
  const roundTrip = (r: Route) => (r.fromId === baseId || r.toId === baseId ? r.distanceKm * 2 : null);
  const on = routes.filter((r) => rules[r.id]?.on);
  const avgTrip = on.length ? on.reduce((s, r) => s + (roundTrip(r) ?? r.distanceKm * 3), 0) / on.length : 0;
  const tripsNeeded = avgTrip ? targetKm / avgTrip : 0;
  const perDay = workdays ? tripsNeeded / workdays : 0;
  const allOn = routes.length > 0 && on.length === routes.length;

  const limits = (rule: Rule, change: (p: Partial<Rule>) => void) => (
    <div className="limits">
      <input className="input mono" placeholder="–" inputMode="numeric" disabled={!rule.on} value={rule.min} aria-label="Minimum havonta" onChange={(e) => change({ min: e.target.value.replace(/\D/g, '') })} />
      <span className="muted">–</span>
      <input className="input mono" placeholder="∞" inputMode="numeric" disabled={!rule.on} value={rule.max} aria-label="Maximum havonta" onChange={(e) => change({ max: e.target.value.replace(/\D/g, '') })} />
      <span className="muted small">alk.</span>
    </div>
  );

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="route-row" style={{ background: 'var(--paper-2)', borderRadius: '14px 14px 0 0', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)', fontWeight: 600 }}>
            <input type="checkbox" className="check" checked={allOn} onChange={(e) => setRules(Object.fromEntries(routes.map((r) => [r.id, { ...rules[r.id], on: e.target.checked }])))} />
            <span>Út</span><span style={{ textAlign: 'right' }}>Oda-vissza</span><span>Havonta min – max</span>
          </div>
          {routes.length === 0 && <p className="muted" style={{ padding: 20 }}>Nincs még út az útkészletben. Vegyél fel utakat az „Utak és úticélok” oldalon.</p>}
          {routes.map((r) => {
            const rule = rules[r.id] ?? { on: false, min: '', max: '' };
            const rt = roundTrip(r);
            return (
              <div key={r.id} className={`route-row ${rule.on ? '' : 'off'}`}>
                <input type="checkbox" className="check" checked={rule.on} onChange={(e) => set(r.id, { on: e.target.checked })} aria-label={r.name} />
                <div style={{ minWidth: 0 }}>
                  <div className="route-line"><b>{destById.get(r.fromId)?.name}</b><span className="arrow">→</span><b>{destById.get(r.toId)?.name}</b></div>
                  <small className="muted">{destById.get(r.toId)?.address}</small>
                </div>
                <span className="kpi-km" style={{ textAlign: 'right' }}>
                  {rt != null ? `${fmtKm(rt)} km` : <span className="chip" title="Nem a telephelyről indul: a generátor hozzáteszi az odajutást és a hazautat">+ oda- és hazaút</span>}
                </span>
                {limits(rule, (p) => set(r.id, p))}
              </div>
            );
          })}
        </div>

        <div className="card">
          <div className="route-row" style={{ background: 'var(--paper-2)', borderRadius: '14px 14px 0 0', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-3)', fontWeight: 600 }}>
            <span /><span>Utazás-sablon</span><span style={{ textAlign: 'right' }}>Hossz</span><span>Havonta min – max</span>
          </div>
          {templates.length === 0 && <p className="muted" style={{ padding: 20 }}>Nincs utazás-sablon. <Link to="/sablonok">Vegyél fel egyet</Link>, ha van szokásos, többnapos vagy több helyet érintő utad.</p>}
          {templates.map((t) => {
            const rule = tplRules[t.id] ?? { on: false, min: '', max: '' };
            return (
              <div key={t.id} className={`route-row ${rule.on ? '' : 'off'}`}>
                <input type="checkbox" className="check" checked={rule.on} onChange={(e) => setT(t.id, { on: e.target.checked })} aria-label={t.name} />
                <div style={{ minWidth: 0 }}>
                  <b>{t.name}</b>
                  <div className="muted small">{t.days.map((d) => dayText(d, destById)).join(' · ')}</div>
                </div>
                <span className="kpi-km" style={{ textAlign: 'right' }}>{templateLength(t)} nap</span>
                {t.onlyDates.length ? <span className="chip sign">csak {t.onlyDates.length} megadott napon</span> : limits(rule, (p) => setT(t.id, p))}
              </div>
            );
          })}
        </div>
      </div>

      <div className="stack sticky">
        <div className="card card-pad stack">
          <h3>Életszerűség</h3>
          <Field label="Körút: több hely egy kör alatt" hint="Csak egymáshoz közeli helyeket fűz össze, véletlenszerűen.">
            <div className="tabs">
              {TOUR_OPTIONS.map((o) => <button key={o.v} type="button" className={tourChance === o.v ? 'on' : ''} onClick={() => setTourChance(o.v)}>{o.label}</button>)}
            </div>
          </Field>
          <label className="row small" style={{ gap: 10 }}>
            <input type="checkbox" className="check" checked={farOn} onChange={(e) => setFarOn(e.target.checked)} />
            <span style={{ flex: 1 }}>Messzi útnál az autó ott is maradhat éjszakára (1–2 éj)</span>
          </label>
          {farOn && (
            <Field label="Ennél messzebb (egy irányba)">
              <div className="input-suffix"><input className="input mono" inputMode="numeric" value={farKm} onChange={(e) => setFarKm(Number(e.target.value.replace(/\D/g, '')) || 0)} /><em>km</em></div>
            </Field>
          )}
          <p className="muted small">Egy helyre naponta legfeljebb egyszer megy (az úticélnál módosítható), és tartja a „két látogatás között legalább” szabályt.</p>
        </div>
        <div className="card card-pad stack">
          <h3>Becslés</h3>
          <SummaryLine k="Lefedendő" v={`${fmtInt(targetKm)} km`} />
          <SummaryLine k="Átlagos oda-vissza út" v={avgTrip ? `${fmtKm(avgTrip)} km` : '—'} />
          <SummaryLine k="Kb. ennyi út kell" v={tripsNeeded ? `${fmtInt(tripsNeeded)} db (${fmtInt(tripsNeeded / Math.max(months, 1))} / hó)` : '—'} />
          <SummaryLine k="Munkanaponként" v={perDay ? `${fmtKm(perDay)} út` : '—'} />
          {perDay > 2.5 && <div className="note warn"><Icon name="alert" /><span>Ez naponta sok út. Vegyél fel hosszabb utakat vagy sablonokat, különben a nyilvántartás nem lesz életszerű.</span></div>}
        </div>
      </div>
    </div>
  );
}

function SummaryLine({ k, v }: { k: string; v: string }) {
  return <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">{k}</span><b className="mono">{v}</b></div>;
}
