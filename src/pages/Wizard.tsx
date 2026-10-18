import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, download, fmtDate, fmtInt, fmtKm, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { RuleEditor, normalizeRule, ruleSummary, toUnitRule, type RuleState } from '../components/RuleEditor';
import { ResultView } from '../components/ResultView';
import { Field, Odometer, PageHead, Plate, useToast } from '../components/ui';
import { defaultFuelPrices, rememberFuelPrices } from '../fuel';
import { dayText, templateLength } from './Templates';
import { isDrivingDay, addDays, lastDayOfMonth, monthLabel, monthRange } from '../../shared/calendar';
import type {
  Company, DayPlan, Destination, Driver, GenerateRequest, GenerateResult, OdometerCheckpoint, RequiredStop, Route,
  TourChance, TripTemplate, Vehicle,
} from '../../shared/types';

const STEPS = ['Szereplők', 'Időszak és km', 'Kötelező helyek', 'Utak és utazások', 'Eredmény'];
const PREFS = 'menet-mester:generator-prefs';


const prevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// rules are remembered per route ("r:<id>") and template ("t:<id>") for the next generation
interface Prefs { unitRules: Record<string, RuleState>; tourChance: TourChance }
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
  const [fetchedFor, setFetchedFor] = useState('');
  const [rules, setRules] = useState<Record<string, RuleState>>(prefs.unitRules ?? {});
  const [tourChance, setTourChance] = useState<TourChance>(prefs.tourChance ?? 'sometimes');
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
  // every route is used by default, templates only when switched on
  useEffect(() => {
    setRules((r) => {
      const next = { ...r };
      for (const rt of routes.items) next[`r:${rt.id}`] = normalizeRule(next[`r:${rt.id}`], true);
      for (const t of templates.items) next[`t:${t.id}`] = normalizeRule(next[`t:${t.id}`], false);
      return next;
    });
  }, [routes.items, templates.items]);
  useEffect(() => savePrefs({ unitRules: rules, tourChance }), [rules, tourChance]);

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
      const on = activeRules();
      if (!on.length && !stops.some((x) => x.enabled)) return 'Válassz ki legalább egy utat vagy utazást.';
      for (const r of on) if (r.min != null && r.max != null && r.min > r.max) return 'Valamelyik sorban a minimum nagyobb a maximumnál.';
      return '';
    }
    return '';
  };

  function activeRules() {
    return [
      ...routes.items.filter((r) => rules[`r:${r.id}`]?.on).map((r) => toUnitRule('route', r.id, rules[`r:${r.id}`])),
      ...templates.items.filter((t) => rules[`t:${t.id}`]?.on).map((t) => toUnitRule('template', t.id, rules[`t:${t.id}`])),
    ];
  }

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
    await runSteps(['Járműnapló átnézése', 'Szerviz- és vizsgaesemények szűrése az időszakra', 'Kötelező helyek összeállítása'], async () => {
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
    rules: activeRules(),
    locked,
    tourChance,
    seed,
  });

  const runGenerate = async (keepLocked = false) => {
    const locked = keepLocked && result ? result.days.filter((d) => lockedUnits.has(d.unitId)) : [];
    const req = buildRequest(undefined, locked);
    try {
      await runSteps(['Távolságok kiszámítása a térképen', 'Munkanapok és ünnepnapok kijelölése', 'Megadott napok beillesztése', 'Utak és utazások elosztása', 'Életszerűség ellenőrzése'], async () => {
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
        text="Lépésről lépésre: szereplők, km-óra és időszak, kötelező helyek, majd az utak és a szabályaik — a végén ellenőrizheted, rögzítheted és letöltheted." />

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
            <RequiredStep period={period} stops={stops} setStops={setStops} checkpoints={checkpoints} setCheckpoints={setCheckpoints}
              destById={destById} onRefetch={() => { setFetchedFor(''); setTimeout(() => fetchIntegrations(), 0); }} />
          )}

          {step === 3 && (
            <RoutesStep routes={routes.items} templates={templates.items} rules={rules} setRules={setRules} period={period}
              destById={destById} baseId={baseId!} targetKm={targetKm} months={months.length} workdays={workdays}
              tourChance={tourChance} setTourChance={setTourChance} />
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

// ---------- step 3: required places ----------
function RequiredStep({ period, stops, setStops, checkpoints, setCheckpoints, destById, onRefetch }: {
  period: { from: string; to: string };
  stops: Stop[]; setStops: (s: Stop[]) => void;
  checkpoints: OdometerCheckpoint[]; setCheckpoints: (c: OdometerCheckpoint[]) => void;
  destById: Map<number, Destination>; onRefetch: () => void;
}) {
  const [date, setDate] = useState(period.from);
  const [odo, setOdo] = useState<number | ''>('');
  const [err, setErr] = useState('');
  const rows: { date: string; stop?: Stop; cp?: OdometerCheckpoint }[] = [
    ...stops.map((s) => ({ date: s.date, stop: s })),
    ...checkpoints.map((c) => ({ date: c.date, cp: c })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const add = () => {
    setErr('');
    if (!date || date < period.from || date > period.to) return setErr('A dátum essen a kiválasztott időszakba.');
    if (odo === '') return setErr('Add meg a km-állást.');
    setCheckpoints([...checkpoints.filter((c) => c.date !== date), { date, odometer: odo }]);
    setOdo('');
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="card card-pad stack">
        <div className="row">
          <h3 style={{ flex: 1 }}>Ahol az autónak lennie kellett</h3>
          <button className="btn btn-sm btn-ghost" onClick={onRefetch}><Icon name="refresh" />Újralekérés</button>
        </div>
        <div className={`note ${stops.length ? '' : 'warn'}`}>
          <Icon name="info" />
          <span>{stops.length
            ? `${stops.length} eseményt találtunk a járműnaplóban erre az időszakra. Ezek a napok kötelezően bekerülnek, a rögzített km-állással együtt.`
            : 'A járműnaplóban nincs szerviz- vagy vizsgaesemény erre az időszakra. Ha volt, rögzítsd a Járműnaplóban.'}</span>
        </div>
        {rows.length === 0 ? (
          <p className="muted small">Nincs kötelező hely vagy km-állás — ilyenkor csak a kezdő és záró km-állás köti a generálást. Ha egy út csak bizonyos napokon történhetett, azt a következő lépésben, az útnál add meg.</p>
        ) : (
          <div className="timeline">
            {rows.map((r) => r.stop ? (
              <div key={r.stop.key} className="card tl-item loc" style={{ opacity: r.stop.enabled ? 1 : 0.5 }}>
                <span className="tl-date">{fmtDate(r.date)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{destById.get(r.stop.destinationId)?.name}</b> <span className="muted small">{destById.get(r.stop.destinationId)?.address}</span>
                  <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                    <span className="chip info">{r.stop.label}</span>
                    {r.stop.odometer != null && <span className="chip mono">{fmtInt(r.stop.odometer)} km</span>}
                  </div>
                </div>
                <label className="row small" title="Kihagyás a generálásból"><input type="checkbox" className="check" checked={r.stop.enabled}
                  onChange={(e) => setStops(stops.map((s) => (s.key === r.stop!.key ? { ...s, enabled: e.target.checked } : s)))} />beépít</label>
              </div>
            ) : (
              <div key={`cp-${r.date}`} className="card tl-item odo-cp">
                <span className="tl-date">{fmtDate(r.date)}</span>
                <div style={{ flex: 1 }}><b>Km-óra a nap végén</b> <span className="chip info mono" style={{ marginLeft: 6 }}>{fmtInt(r.cp!.odometer)} km</span></div>
                <button className="btn btn-ghost btn-danger icon-btn" aria-label="Eltávolítás" onClick={() => setCheckpoints(checkpoints.filter((c) => c !== r.cp))}><Icon name="trash" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-pad stack sticky">
        <h3>Ismert km-állás hozzáadása</h3>
        <p className="muted small">Opcionális. Ha tudod, mennyit mutatott az óra egy adott napon (pl. tankolási bizonylat), a generált nyilvántartás ehhez igazodik.</p>
        <Field label="Dátum"><input type="date" className="input" value={date} min={period.from} max={period.to} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Km-állás a nap végén"><Odometer value={odo} onChange={setOdo} /></Field>
        {err && <span className="error-text">{err}</span>}
        <button className="btn btn-primary" style={{ alignSelf: 'flex-end' }} onClick={add}><Icon name="plus" />Hozzáadás</button>
      </div>
    </div>
  );
}

// ---------- step 4: routes, templates and their rules ----------
const TOUR_OPTIONS: { v: TourChance; label: string }[] = [
  { v: 'never', label: 'Soha' }, { v: 'rare', label: 'Ritkán' }, { v: 'sometimes', label: 'Néha' }, { v: 'often', label: 'Gyakran' },
];

function RoutesStep({
  routes, templates, rules, setRules, period, destById, baseId, targetKm, months, workdays, tourChance, setTourChance,
}: {
  routes: Route[]; templates: TripTemplate[];
  rules: Record<string, RuleState>; setRules: (r: Record<string, RuleState>) => void;
  period: { from: string; to: string };
  destById: Map<number, Destination>; baseId: number; targetKm: number; months: number; workdays: number;
  tourChance: TourChance; setTourChance: (t: TourChance) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const rule = (key: string) => rules[key] ?? normalizeRule(undefined, false);
  const set = (key: string, r: RuleState) => setRules({ ...rules, [key]: r });
  const roundTrip = (r: Route) => (r.fromId === baseId || r.toId === baseId ? r.distanceKm * 2 : null);
  const onRoutes = routes.filter((r) => rule(`r:${r.id}`).on);
  const avgTrip = onRoutes.length ? onRoutes.reduce((s, r) => s + (roundTrip(r) ?? r.distanceKm * 3), 0) / onRoutes.length : 0;
  const tripsNeeded = avgTrip ? targetKm / avgTrip : 0;
  const perDay = workdays ? tripsNeeded / workdays : 0;

  const row = (key: string, title: React.ReactNode, sub: string, size: React.ReactNode) => {
    const r = rule(key);
    const summary = ruleSummary(r);
    return (
      <div key={key} className={`unit-row ${r.on ? '' : 'off'} ${open === key ? 'open' : ''}`}>
        <div className="unit-head">
          <input type="checkbox" className="check" checked={r.on} onChange={(e) => set(key, { ...r, on: e.target.checked })} aria-label="Használja a generátor" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="route-line">{title}</div>
            <div className="muted small">{sub}</div>
            {summary.length > 0 && <div className="row wrap" style={{ gap: 6, marginTop: 6 }}>{summary.map((x) => <span key={x} className="chip info">{x}</span>)}</div>}
          </div>
          <span className="kpi-km" style={{ textAlign: 'right', minWidth: 90 }}>{size}</span>
          <button type="button" className={`btn btn-sm ${open === key ? 'btn-primary' : ''}`} onClick={() => setOpen(open === key ? null : key)}>
            <Icon name="edit" />Szabályok{summary.length ? ` (${summary.length})` : ''}
          </button>
        </div>
        {open === key && <RuleEditor value={r} onChange={(x) => set(key, x)} period={period} />}
      </div>
    );
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="stack">
        <div className="card">
          <div className="list-head">
            <h3>Utak</h3>
            <span className="muted small">Egynapos utak a telephelyről és vissza.</span>
            <div className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setRules({ ...rules, ...Object.fromEntries(routes.map((r) => [`r:${r.id}`, { ...rule(`r:${r.id}`), on: onRoutes.length !== routes.length }])) })}>
              {onRoutes.length === routes.length ? 'Egyik sem' : 'Mind'}
            </button>
          </div>
          {routes.length === 0 && <p className="muted" style={{ padding: 20 }}>Nincs még út. Vegyél fel utakat az „Utak és úticélok” oldalon.</p>}
          {routes.map((r) => {
            const rt = roundTrip(r);
            return row(`r:${r.id}`,
              <><b>{destById.get(r.fromId)?.name}</b><span className="arrow">→</span><b>{destById.get(r.toId)?.name}</b></>,
              destById.get(r.toId)?.address ?? '',
              rt != null ? `${fmtKm(rt)} km` : <span className="chip" title="Nem a telephelyről indul: a generátor hozzáteszi az odajutást és a hazautat">+ oda- és hazaút</span>);
          })}
        </div>

        <div className="card">
          <div className="list-head">
            <h3>Utazás-sablonok</h3>
            <span className="muted small">Többnapos vagy több helyet érintő utazások.</span>
            <div className="spacer" />
            <Link to="/sablonok" className="btn btn-sm btn-ghost">Kezelés</Link>
          </div>
          {templates.length === 0 && <p className="muted" style={{ padding: 20 }}>Nincs utazás-sablon. <Link to="/sablonok">Vegyél fel egyet</Link>, ha van többnapos vagy több helyet érintő utad.</p>}
          {templates.map((t) => row(`t:${t.id}`, <b>{t.name}</b>, t.days.map((d) => dayText(d, destById)).join(' · '), `${templateLength(t)} nap`))}
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
          <p className="muted small">Egy helyre naponta legfeljebb egyszer megy, hacsak az út szabálya („naponta”) mást nem mond. Többnapos utat utazás-sablonnal adhatsz meg.</p>
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
