import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, download, fmtDate, fmtInt, fmtKm, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { PlaceSearch, type PlacePick } from '../components/PlaceSearch';
import { ResultView } from '../components/ResultView';
import { Field, Odometer, PageHead, Plate, useToast } from '../components/ui';
import { defaultFuelPrices, rememberFuelPrices } from '../fuel';
import { isDrivingDay, addDays, lastDayOfMonth, monthLabel, monthRange } from '../../shared/calendar';
import type {
  Company, Destination, Driver, GenerateRequest, GenerateResult, OdometerCheckpoint, RequiredStop, Route, RouteRule, Vehicle,
} from '../../shared/types';

const STEPS = ['Szereplők', 'Időszak és km', 'Kötelező helyek', 'Utak', 'Eredmény'];

const prevMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

interface Stop extends RequiredStop { key: string; enabled: boolean }

export function WizardPage() {
  const companies = useCollection<Company>('companies');
  const vehicles = useCollection<Vehicle>('vehicles');
  const drivers = useCollection<Driver>('drivers');
  const dests = useCollection<Destination>('destinations');
  const routes = useCollection<Route>('routes');
  const toast = useToast();
  const navigate = useNavigate();

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
  const [rules, setRules] = useState<Record<number, { on: boolean; min: string; max: string }>>({});
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [lastReq, setLastReq] = useState<GenerateRequest | null>(null);
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
      const on = Object.entries(rules).filter(([, r]) => r.on);
      if (!on.length && !stops.some((x) => x.enabled)) return 'Válassz ki legalább egy utat.';
      for (const [id, r] of on) {
        if (r.min && r.max && Number(r.min) > Number(r.max))
          return `„${routes.items.find((x) => x.id === Number(id))?.name}”: a minimum nem lehet nagyobb a maximumnál.`;
      }
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
    await runSteps(['Járműnapló átnézése', 'Szerviz- és vizsgaesemények szűrése az időszakra', 'Kötelező helyszínek összeállítása'], async () => {
      const res = await api<{ provider: string; ok: boolean; error?: string; stops: RequiredStop[] }[]>(
        `/api/integrations/stops?vehicleId=${vehicleId}&fromMonth=${fromMonth}&toMonth=${toMonth}`,
      );
      const manual = stops.filter((s) => s.source === 'Kézi elvárás');
      const fetched = res.flatMap((r) => r.stops.map((s, i) => ({ ...s, key: `${r.provider}-${s.date}-${i}`, enabled: true })));
      setStops([...fetched, ...manual].sort((a, b) => a.date.localeCompare(b.date)));
      const failed = res.filter((r) => !r.ok);
      if (failed.length) toast(`Nem elérhető forrás: ${failed.map((f) => f.provider).join(', ')}`, true);
      setFetchedFor(sig);
    });
  };

  const buildRequest = (seed?: number): GenerateRequest => ({
    companyId: companyId!, vehicleId: vehicleId!, driverId: driverId!, baseDestinationId: baseId!,
    startOdometer: Number(startOdo), endOdometer: Number(endOdo), fromMonth, toMonth,
    stops: stops.filter((s) => s.enabled).map(({ date, destinationId, odometer, label, source }) => ({ date, destinationId, odometer, label, source })),
    checkpoints,
    routes: Object.entries(rules).filter(([, r]) => r.on).map(([id, r]): RouteRule => ({
      routeId: Number(id), minPerMonth: r.min ? Number(r.min) : null, maxPerMonth: r.max ? Number(r.max) : null,
    })),
    seed,
  });

  const runGenerate = async (seed?: number) => {
    const req = buildRequest(seed);
    try {
      await runSteps(['Hiányzó távolságok kiszámítása a térképen', 'Munkanapok és ünnepnapok kijelölése', 'Kötelező helyszínek beillesztése', 'Utak elosztása a km-óra szerint', 'Hónapok összesítése'], async () => {
        const r = await api<GenerateResult>('/api/generate', { method: 'POST', json: req });
        setResult(r);
        setLastReq({ ...req, seed: r.seed });
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

  // ---------- render ----------
  const vehicle = vehicles.items.find((v) => v.id === vehicleId);

  return (
    <>
      <PageHead eyebrow={`${step + 1}. lépés / ${STEPS.length}`} title="Útnyilvántartás generálása"
        text="Lépésről lépésre: kiválasztod a szereplőket, megadod a km-órát és az időszakot, a kötelező helyeket és az utakat — a végén letölthető Excel készül." />

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
          <ul>
            {busy.map((b, i) => <li key={b} className={i < busyAt ? 'done' : i === busyAt ? 'now' : 'todo'}>{b}</li>)}
          </ul>
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
            <StopsStep stops={stops} setStops={setStops} checkpoints={checkpoints} setCheckpoints={setCheckpoints}
              destinations={dests.items} destById={destById} period={period} reloadDests={dests.reload}
              onRefetch={() => { setFetchedFor(''); setTimeout(() => fetchIntegrations(), 0); }} />
          )}

          {step === 3 && (
            <RoutesStep routes={routes.items} rules={rules} setRules={setRules} destById={destById} baseId={baseId!}
              targetKm={targetKm} months={months.length} workdays={workdays} />
          )}

          {step === 4 && result && lastReq && (
            <ResultView result={result} vehicle={vehicle} fuelPrices={fuel} onFuelPrice={(m, p) => setFuel({ ...fuel, [m]: p })} />
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
              <button className="btn" onClick={() => runGenerate()}><Icon name="refresh" />Új változat</button>
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
        {items.length === 0 && <a className="small muted" href="/torzsadatok">— még nincs felvéve, vegyél fel egyet a törzsadatoknál</a>}
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
function StopsStep({ stops, setStops, checkpoints, setCheckpoints, destinations, destById, period, reloadDests, onRefetch }: {
  stops: Stop[]; setStops: (s: Stop[]) => void;
  checkpoints: OdometerCheckpoint[]; setCheckpoints: (c: OdometerCheckpoint[]) => void;
  destinations: Destination[]; destById: Map<number, Destination>;
  period: { from: string; to: string }; reloadDests: () => Promise<void>; onRefetch: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'loc' | 'odo'>('none');
  const [date, setDate] = useState(period.from);
  const [odo, setOdo] = useState<number | ''>('');
  const [pick, setPick] = useState<PlacePick | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  type Row = { date: string; kind: 'stop' | 'cp'; stop?: Stop; cp?: OdometerCheckpoint };
  const rows: Row[] = [
    ...stops.map((s) => ({ date: s.date, kind: 'stop' as const, stop: s })),
    ...checkpoints.map((c) => ({ date: c.date, kind: 'cp' as const, cp: c })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const fetched = stops.filter((s) => s.source !== 'Kézi elvárás').length;

  const reset = () => { setMode('none'); setPick(null); setText(''); setOdo(''); setErr(''); };

  const add = async () => {
    setErr('');
    if (!date || date < period.from || date > period.to) return setErr('A dátum essen a kiválasztott időszakba.');
    if (mode === 'odo') {
      if (odo === '') return setErr('Add meg a km-állást.');
      setCheckpoints([...checkpoints.filter((c) => c.date !== date), { date, odometer: odo }]);
      return reset();
    }
    if (!pick) return setErr('Válassz helyszínt a listából.');
    let d: Destination;
    if (pick.kind === 'saved') d = pick.destination;
    else {
      d = await api<Destination>('/api/destinations', { method: 'POST', json: { name: pick.suggestion.primary, address: pick.suggestion.label, lat: pick.suggestion.lat, lon: pick.suggestion.lon } });
      await reloadDests();
    }
    setStops([...stops, { key: `m-${Date.now()}`, enabled: true, date, destinationId: d.id, odometer: odo === '' ? null : odo, label: `Tartózkodás: ${d.name}`, source: 'Kézi elvárás' }]
      .sort((a, b) => a.date.localeCompare(b.date)));
    reset();
  };

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', alignItems: 'start' }}>
      <div className="card card-pad stack">
        <div className="row">
          <h3 style={{ flex: 1 }}>Ahol az autónak lennie kellett</h3>
          <button className="btn btn-sm btn-ghost" onClick={onRefetch}><Icon name="refresh" />Újralekérés</button>
        </div>
        <div className={`note ${fetched ? '' : 'warn'}`}>
          <Icon name="info" />
          <span>{fetched
            ? `${fetched} eseményt találtunk a járműnaplóban erre az időszakra. Ezek a napok kötelezően bekerülnek, a rögzített km-állással együtt.`
            : 'A járműnaplóban nincs szerviz- vagy vizsgaesemény erre az időszakra. Ha volt, rögzítsd ott, vagy add hozzá itt elvárásként.'}</span>
        </div>

        {rows.length === 0 ? (
          <p className="muted small">Nincs kötelező helyszín vagy km-állás. Ez rendben van — ilyenkor csak a kezdő és záró km-állás köti a generálást.</p>
        ) : (
          <div className="timeline">
            {rows.map((r) => r.kind === 'stop' ? (
              <div key={r.stop!.key} className={`card tl-item loc`} style={{ opacity: r.stop!.enabled ? 1 : 0.5 }}>
                <span className="tl-date">{fmtDate(r.date)}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{destById.get(r.stop!.destinationId)?.name}</b> <span className="muted small">{destById.get(r.stop!.destinationId)?.address}</span>
                  <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                    <span className={`chip ${r.stop!.source === 'Kézi elvárás' ? '' : 'info'}`}>{r.stop!.label}</span>
                    {r.stop!.odometer != null && <span className="chip mono">{fmtInt(r.stop!.odometer)} km</span>}
                  </div>
                </div>
                {r.stop!.source === 'Kézi elvárás' ? (
                  <button className="btn btn-ghost btn-danger icon-btn" aria-label="Eltávolítás" onClick={() => setStops(stops.filter((s) => s.key !== r.stop!.key))}><Icon name="trash" /></button>
                ) : (
                  <label className="row small" title="Kihagyás a generálásból"><input type="checkbox" className="check" checked={r.stop!.enabled}
                    onChange={(e) => setStops(stops.map((s) => (s.key === r.stop!.key ? { ...s, enabled: e.target.checked } : s)))} />beépít</label>
                )}
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
        <h3>Saját elvárás hozzáadása</h3>
        <p className="muted small">Opcionális. Ha tudod, hogy egy napon hol volt az autó, vagy mennyit mutatott az óra, rögzítsd — a generált nyilvántartás ehhez igazodik.</p>
        <div className="row">
          <button className={`btn ${mode === 'loc' ? 'btn-primary' : ''}`} style={{ flex: 1 }} onClick={() => setMode('loc')}><Icon name="pin" />Tartózkodási hely</button>
          <button className={`btn ${mode === 'odo' ? 'btn-primary' : ''}`} style={{ flex: 1 }} onClick={() => setMode('odo')}><Icon name="gauge" />Km-állás</button>
        </div>
        {mode !== 'none' && (
          <>
            <Field label="Dátum"><input type="date" className="input" value={date} min={period.from} max={period.to} onChange={(e) => setDate(e.target.value)} /></Field>
            {mode === 'loc' && (
              <Field label="Hol volt az autó?">
                <PlaceSearch saved={destinations} text={text} onText={(t) => { setText(t); setPick(null); }}
                  onPick={(p) => { setPick(p); setText(p.kind === 'saved' ? p.destination.name : p.suggestion.label); }} />
              </Field>
            )}
            <Field label={mode === 'odo' ? 'Km-állás a nap végén' : 'Km-állás érkezéskor (ha ismert)'}><Odometer value={odo} onChange={setOdo} /></Field>
            {err && <span className="error-text">{err}</span>}
            <div className="row"><button className="btn btn-ghost" onClick={reset}>Mégse</button><div className="spacer" /><button className="btn btn-primary" onClick={add}><Icon name="plus" />Hozzáadás</button></div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- step 4: routes ----------
function RoutesStep({ routes, rules, setRules, destById, baseId, targetKm, months, workdays }: {
  routes: Route[]; rules: Record<number, { on: boolean; min: string; max: string }>;
  setRules: (r: Record<number, { on: boolean; min: string; max: string }>) => void;
  destById: Map<number, Destination>; baseId: number; targetKm: number; months: number; workdays: number;
}) {
  const set = (id: number, patch: Partial<{ on: boolean; min: string; max: string }>) => setRules({ ...rules, [id]: { ...rules[id], ...patch } });
  // rough round-trip length: saved distance twice when the route touches the base
  const roundTrip = (r: Route) => (r.fromId === baseId || r.toId === baseId ? r.distanceKm * 2 : null);
  const on = routes.filter((r) => rules[r.id]?.on);
  const avgTrip = on.length ? on.reduce((s, r) => s + (roundTrip(r) ?? r.distanceKm * 3), 0) / on.length : 0;
  const tripsNeeded = avgTrip ? targetKm / avgTrip : 0;
  const perDay = workdays ? tripsNeeded / workdays : 0;
  const allOn = routes.length > 0 && on.length === routes.length;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', alignItems: 'start' }}>
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
              <span className="kpi-km" style={{ textAlign: 'right' }}>{rt != null ? `${fmtKm(rt)} km` : <span className="chip">+ ráhordás</span>}</span>
              <div className="limits">
                <input className="input mono" placeholder="–" inputMode="numeric" disabled={!rule.on} value={rule.min} aria-label="Minimum havonta"
                  onChange={(e) => set(r.id, { min: e.target.value.replace(/\D/g, '') })} />
                <span className="muted">–</span>
                <input className="input mono" placeholder="∞" inputMode="numeric" disabled={!rule.on} value={rule.max} aria-label="Maximum havonta"
                  onChange={(e) => set(r.id, { max: e.target.value.replace(/\D/g, '') })} />
                <span className="muted small">alk.</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="card card-pad stack sticky">
        <h3>Becslés</h3>
        <SummaryLine k="Lefedendő" v={`${fmtInt(targetKm)} km`} />
        <SummaryLine k="Átlagos oda-vissza út" v={avgTrip ? `${fmtKm(avgTrip)} km` : '—'} />
        <SummaryLine k="Kb. ennyi út kell" v={tripsNeeded ? `${fmtInt(tripsNeeded)} db (${fmtInt(tripsNeeded / Math.max(months, 1))} / hó)` : '—'} />
        <SummaryLine k="Munkanaponként" v={perDay ? `${fmtKm(perDay)} út` : '—'} />
        {perDay > 2.5 && (
          <div className="note warn"><Icon name="alert" /><span>Ez naponta sok út. Vegyél fel hosszabb utakat is, különben a nyilvántartás nem lesz életszerű (szombatokra is kerülhet út).</span></div>
        )}
        {perDay > 0 && perDay < 0.05 && (
          <div className="note"><Icon name="info" /><span>Kevés km jut erre az időszakra — a generátor csak néhány napra tesz utat.</span></div>
        )}
        <p className="muted small">Minden út a telephelyről indul és aznap oda is tér vissza. A min/max üresen hagyható: ilyenkor a generátor szabadon osztja el.</p>
      </div>
    </div>
  );
}

function SummaryLine({ k, v }: { k: string; v: string }) {
  return <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">{k}</span><b className="mono">{v}</b></div>;
}
