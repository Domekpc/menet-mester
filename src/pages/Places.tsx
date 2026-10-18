import { useEffect, useMemo, useState } from 'react';
import { api, fmtKm, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { PlaceSearch, type PlacePick } from '../components/PlaceSearch';
import { RouteMap } from '../components/RouteMap';
import { Empty, Field, Modal, PageHead, useConfirm, useToast } from '../components/ui';
import { BASE, type Company, type Destination, type Route, type RouteCalc, type TripTemplate } from '../../shared/types';

export function PlacesPage() {
  const dests = useCollection<Destination>('destinations');
  const routes = useCollection<Route>('routes');
  const companies = useCollection<Company>('companies');
  // a route always starts or ends at a telephely; anything else is a trip template
  const homeIds = useMemo(() => new Set(companies.items.map((c) => c.homeDestinationId).filter((x): x is number => x != null)), [companies.items]);
  const touchesHome = (r: Route) => homeIds.has(r.fromId) || homeIds.has(r.toId);
  const [tab, setTab] = useState<'routes' | 'places'>('routes');
  const [selRoute, setSelRoute] = useState<number | null>(null);
  const [selPlace, setSelPlace] = useState<number | null>(null);
  const [routeForm, setRouteForm] = useState<Partial<Route> | null>(null);
  const [placeForm, setPlaceForm] = useState<Partial<Destination> | null>(null);
  const [calc, setCalc] = useState<RouteCalc | null>(null);
  const [q, setQ] = useState('');
  const confirm = useConfirm();
  const toast = useToast();

  const byId = useMemo(() => new Map(dests.items.map((d) => [d.id, d])), [dests.items]);
  const route = routes.items.find((r) => r.id === selRoute);

  useEffect(() => {
    setCalc(null);
    if (!route) return;
    api<RouteCalc>(`/api/geo/route-between?from=${route.fromId}&to=${route.toId}`).then(setCalc).catch(() => setCalc(null));
  }, [route?.id, route?.fromId, route?.toId]); // eslint-disable-line react-hooks/exhaustive-deps

  const mapPoints = useMemo(() => {
    if (tab === 'routes' && route) {
      return [byId.get(route.fromId), byId.get(route.toId)]
        .filter((d): d is Destination => !!d && d.lat != null)
        .map((d) => ({ lat: d.lat!, lon: d.lon!, label: d.name }));
    }
    const list = tab === 'places' && selPlace ? dests.items.filter((d) => d.id === selPlace) : dests.items;
    return list.filter((d) => d.lat != null).map((d) => ({ lat: d.lat!, lon: d.lon!, label: d.name }));
  }, [tab, route, selPlace, dests.items, byId]);

  const match = (s: string) => s.toLowerCase().includes(q.toLowerCase());
  const shownRoutes = routes.items.filter((r) => match(`${r.name} ${byId.get(r.fromId)?.address} ${byId.get(r.toId)?.address}`));
  const shownPlaces = dests.items.filter((d) => match(`${d.name} ${d.address}`));

  return (
    <>
      <PageHead eyebrow="Útkészlet" title="Utak és úticélok"
        text="Az úticél egy hely (partner, bank, posta…), az út két úticél közti szakasz a távolsággal. A generátor ezekből rakja össze a hónapokat, a visszautat magától hozzáteszi."
        actions={<>
          <button className="btn" onClick={() => setPlaceForm({})}><Icon name="pin" />Új úticél</button>
          <button className="btn btn-primary" onClick={() => setRouteForm({})}><Icon name="route" />Új út</button>
        </>} />

      <div className="split">
        <div className="card">
          <div className="row" style={{ padding: 14, borderBottom: '1px solid var(--line)' }}>
            <div className="tabs">
              <button className={tab === 'routes' ? 'on' : ''} onClick={() => setTab('routes')}>Utak<span className="count">{routes.items.length}</span></button>
              <button className={tab === 'places' ? 'on' : ''} onClick={() => setTab('places')}>Úticélok<span className="count">{dests.items.length}</span></button>
            </div>
            <div className="spacer" />
            <input className="input" style={{ maxWidth: 200, padding: '8px 12px' }} placeholder="Szűrés…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>

          {tab === 'routes' && (shownRoutes.length === 0 ? (
            <Empty icon="route" title="Nincs még út" text="Adj meg két címet, a távolságot kiszámoljuk."
              action={<button className="btn btn-primary" onClick={() => setRouteForm({})}><Icon name="plus" />Új út</button>} />
          ) : shownRoutes.map((r) => (
            <div key={r.id} className={`item ${r.id === selRoute ? 'sel' : ''}`} onClick={() => setSelRoute(r.id)}>
              <div className="dot"><Icon name="route" /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="route-line"><b>{byId.get(r.fromId)?.name}</b><span className="arrow">→</span><b>{byId.get(r.toId)?.name}</b></div>
                <small className="muted">{r.name}</small>
              </div>
              {homeIds.size > 0 && !touchesHome(r) && (
                <button className="btn btn-sm" title="Telephely nélküli út nem használható — utazás-sablonként igen"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await confirm('Sablonná alakítás', `A(z) „${r.name}” nem a telephelyről indul, ezért útként nem használható. Utazás-sablon lesz belőle (Telephely → ${byId.get(r.fromId)?.name} → ${byId.get(r.toId)?.name} → Telephely), az út pedig törlődik. A sablont utána bővítheted, pl. több napra.`, 'Sablonná alakítás'))) return;
                    await api<TripTemplate>('/api/templates', { method: 'POST', json: {
                      name: r.name, startWeekdays: [], minPerMonth: null, maxPerMonth: null, onlyDates: [], note: '',
                      days: [{ stops: [BASE, r.fromId, r.toId, BASE], repeat: 1 }],
                    } });
                    await routes.remove(r.id);
                    toast('Sablon létrehozva az Utazás-sablonok között');
                  }}><Icon name="calendar" />Sablonná alakítás</button>
              )}
              <span className="kpi-km">{fmtKm(r.distanceKm)} km</span>
              <div className="actions">
                <button className="btn btn-ghost icon-btn" aria-label="Szerkesztés" onClick={(e) => { e.stopPropagation(); setRouteForm(r); }}><Icon name="edit" /></button>
                <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={async (e) => {
                  e.stopPropagation();
                  if (!(await confirm('Út törlése', `Biztosan törlöd: ${r.name}?`))) return;
                  await routes.remove(r.id); toast('Út törölve');
                }}><Icon name="trash" /></button>
              </div>
            </div>
          )))}

          {tab === 'places' && (shownPlaces.length === 0 ? (
            <Empty icon="pin" title="Nincs még úticél" text="Kezdd el gépelni a címet, és válassz a találatokból."
              action={<button className="btn btn-primary" onClick={() => setPlaceForm({})}><Icon name="plus" />Új úticél</button>} />
          ) : shownPlaces.map((d) => {
            const used = routes.items.filter((r) => r.fromId === d.id || r.toId === d.id).length;
            return (
              <div key={d.id} className={`item ${d.id === selPlace ? 'sel' : ''}`} onClick={() => setSelPlace(d.id)}>
                <div className="dot"><Icon name="pin" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <b>{d.name}</b>
                  <div className="muted small">{d.address}</div>
                </div>
                {used > 0 && <span className="chip">{used} út</span>}
                {d.lat == null && <span className="chip sign" title="Első használatkor megkeressük a térképen">nincs térképen</span>}
                <div className="actions">
                  <button className="btn btn-ghost icon-btn" aria-label="Szerkesztés" onClick={(e) => { e.stopPropagation(); setPlaceForm(d); }}><Icon name="edit" /></button>
                  <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={async (e) => {
                    e.stopPropagation();
                    if (!(await confirm('Úticél törlése', used ? `A(z) ${d.name} ${used} útban szerepel — ezek az utak is törlődnek.` : `Biztosan törlöd: ${d.name}?`))) return;
                    await dests.remove(d.id); await routes.reload(); toast('Úticél törölve');
                  }}><Icon name="trash" /></button>
                </div>
              </div>
            );
          }))}
        </div>

        <div className="card card-pad sticky stack">
          {tab === 'routes' && route ? (
            <div className="row">
              <div style={{ flex: 1 }}>
                <h3>{route.name}</h3>
                <p className="muted small">{byId.get(route.fromId)?.address} → {byId.get(route.toId)?.address}</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="kpi-km" style={{ fontSize: 22 }}>{fmtKm(route.distanceKm)} km</div>
                {calc && <small className="muted">térkép szerint {fmtKm(calc.distanceKm)} km · ~{calc.durationMin} perc</small>}
              </div>
            </div>
          ) : (
            <p className="muted small">{tab === 'routes' ? 'Válassz egy utat a listából a térképes megjelenítéshez.' : 'Az úticélok a térképen.'}</p>
          )}
          <RouteMap points={mapPoints} line={tab === 'routes' ? calc?.geometry : undefined} height={460} />
        </div>
      </div>

      {routeForm && (
        <RouteForm initial={routeForm} destinations={dests.items} homeIds={homeIds} onClose={() => setRouteForm(null)}
          onSaved={async (r) => { await dests.reload(); await routes.reload(); setRouteForm(null); setTab('routes'); setSelRoute(r.id); toast('Út mentve'); }} />
      )}
      {placeForm && (
        <PlaceForm initial={placeForm} onClose={() => setPlaceForm(null)}
          onSave={async (d) => {
            if (placeForm.id) await dests.update(placeForm.id, d); else await dests.create(d);
            setPlaceForm(null); toast('Úticél mentve');
          }} />
      )}
    </>
  );
}

// ---------- place form ----------
function PlaceForm({ initial, onClose, onSave }: { initial: Partial<Destination>; onClose: () => void; onSave: (d: Omit<Destination, 'id'>) => Promise<void> }) {
  const [name, setName] = useState(initial.name ?? '');
  const [address, setAddress] = useState(initial.address ?? '');
  const [coords, setCoords] = useState<{ lat: number; lon: number } | null>(initial.lat != null ? { lat: initial.lat!, lon: initial.lon! } : null);
  const [tried, setTried] = useState(false);
  const points = useMemo(() => (coords ? [{ ...coords, label: name }] : []), [coords, name]);

  const submit = async () => {
    setTried(true);
    if (!name.trim() || !address.trim()) return;
    await onSave({
      name: name.trim(), address: address.trim(), lat: coords?.lat ?? null, lon: coords?.lon ?? null,
      maxPerDay: initial.maxPerDay ?? null, minGapDays: initial.minGapDays ?? null,
    });
  };

  return (
    <Modal title={initial.id ? 'Úticél szerkesztése' : 'Új úticél'} subtitle="A név kerül a nyilvántartás „Partner” oszlopába." onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Mégse</button><button className="btn btn-primary" onClick={submit}>Mentés</button></>}>
      <Field label="Cím" hint="Gépelés közben listázzuk a térkép találatait" error={tried && !address.trim() ? 'Add meg a címet' : undefined}>
        <PlaceSearch text={address} autoFocus={!initial.id} invalid={tried && !address.trim()}
          onText={(t) => { setAddress(t); setCoords(null); }}
          onPick={(p) => {
            if (p.kind !== 'address') return;
            setAddress(p.suggestion.label);
            setCoords({ lat: p.suggestion.lat, lon: p.suggestion.lon });
            if (!name.trim() && p.suggestion.primary !== p.suggestion.label) setName(p.suggestion.primary);
          }} />
      </Field>
      <Field label="Név / partner" error={tried && !name.trim() ? 'Adj nevet az úticélnak' : undefined}>
        <input className={`input ${tried && !name.trim() ? 'invalid' : ''}`} value={name} placeholder="pl. OTP Bank, Könyvelő iroda" onChange={(e) => setName(e.target.value)} />
      </Field>
      {coords ? <RouteMap points={points} height={220} /> : address && <p className="muted small">Válassz a listából, hogy a hely a térképre kerüljön (enélkül is menthető).</p>}
    </Modal>
  );
}

// ---------- route form ----------
type End = { saved?: Destination; newName?: string; text: string; lat?: number; lon?: number; address?: string };

const endFrom = (d?: Destination): End => (d ? { saved: d, text: d.name, lat: d.lat ?? undefined, lon: d.lon ?? undefined } : { text: '' });

function RouteForm({ initial, destinations, homeIds, onClose, onSaved }: {
  initial: Partial<Route>; destinations: Destination[]; homeIds: Set<number>; onClose: () => void; onSaved: (r: Route) => Promise<void>;
}) {
  const find = (id?: number) => destinations.find((d) => d.id === id);
  const [from, setFrom] = useState<End>(() => endFrom(find(initial.fromId ?? (initial.id ? undefined : [...homeIds][0]))));
  const [to, setTo] = useState<End>(() => endFrom(find(initial.toId)));
  const [km, setKm] = useState<string>(initial.distanceKm != null ? String(initial.distanceKm).replace('.', ',') : '');
  const [kmTouched, setKmTouched] = useState(!!initial.id);
  const [name, setName] = useState(initial.name ?? '');
  const [nameTouched, setNameTouched] = useState(!!initial.id);
  const [calc, setCalc] = useState<RouteCalc | null>(null);
  const [calcState, setCalcState] = useState<'idle' | 'busy' | 'error'>('idle');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const label = (e: End) => e.saved?.name ?? e.newName ?? '';
  const ready = (e: End) => !!e.saved || (e.lat != null && !!e.address);

  useEffect(() => {
    if (!nameTouched && label(from) && label(to)) setName(`${label(from)} → ${label(to)}`);
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  // calculate shortest route whenever both ends are known
  useEffect(() => {
    setCalc(null);
    if (!ready(from) || !ready(to)) return;
    setCalcState('busy');
    const req = from.saved && to.saved && (from.lat == null || to.lat == null)
      ? api<RouteCalc>(`/api/geo/route-between?from=${from.saved.id}&to=${to.saved.id}`)
      : from.lat != null && to.lat != null
        ? api<RouteCalc>('/api/geo/route', { method: 'POST', json: { from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon } } })
        : Promise.reject(new Error('Nincs koordináta'));
    let alive = true;
    req.then((c) => {
      if (!alive) return;
      setCalc(c); setCalcState('idle');
      if (!kmTouched) setKm(String(c.distanceKm).replace('.', ','));
    }).catch(() => alive && setCalcState('error'));
    return () => { alive = false; };
  }, [from.saved?.id, from.lat, to.saved?.id, to.lat]); // eslint-disable-line react-hooks/exhaustive-deps

  const points = useMemo(() => [from, to].filter((e) => e.lat != null).map((e) => ({ lat: e.lat!, lon: e.lon!, label: label(e) })), [from, to]);

  const pick = (set: (e: End) => void) => (p: PlacePick) => {
    if (p.kind === 'saved') set(endFrom(p.destination));
    else set({ text: p.suggestion.label, newName: p.suggestion.primary, address: p.suggestion.label, lat: p.suggestion.lat, lon: p.suggestion.lon });
  };

  const save = async () => {
    setError('');
    const dist = Number(km.replace(',', '.'));
    if (!ready(from) || !ready(to)) return setError('Válaszd ki mindkét végpontot a listából.');
    if (!(dist > 0)) return setError('Adj meg érvényes távolságot.');
    if (!label(from).trim() || !label(to).trim()) return setError('Nevezd el az új úticélokat.');
    if (homeIds.size && !homeIds.has(from.saved?.id ?? -1) && !homeIds.has(to.saved?.id ?? -1)) {
      return setError('Az út egyik végpontja a telephely legyen. Telephely nélküli utat utazás-sablonként vegyél fel.');
    }
    setSaving(true);
    try {
      const ensure = async (e: End) => e.saved?.id ?? (await api<Destination>('/api/destinations', {
        method: 'POST', json: { name: e.newName!.trim(), address: e.address, lat: e.lat, lon: e.lon },
      })).id;
      const fromId = await ensure(from);
      const toId = await ensure(to);
      if (fromId === toId) { setSaving(false); return setError('A kezdő- és a végpont nem lehet ugyanaz.'); }
      const body = { name: name.trim() || `${label(from)} → ${label(to)}`, fromId, toId, distanceKm: dist };
      const r = initial.id
        ? await api<Route>(`/api/routes/${initial.id}`, { method: 'PUT', json: body })
        : await api<Route>('/api/routes', { method: 'POST', json: body });
      await onSaved(r);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  const endInput = (title: string, e: End, set: (e: End) => void, autoFocus?: boolean) => (
    <div className="stack" style={{ gap: 8 }}>
      <Field label={title}>
        <PlaceSearch saved={destinations} text={e.text} autoFocus={autoFocus} placeholder="Mentett úticél vagy új cím…"
          onText={(t) => set({ text: t })} onPick={pick(set)} />
      </Field>
      {e.newName !== undefined && !e.saved && (
        <div className="row" style={{ gap: 8 }}>
          <span className="chip sign">új úticél</span>
          <input className="input" style={{ padding: '7px 10px' }} value={e.newName} placeholder="Elnevezés (partner)"
            onChange={(ev) => set({ ...e, newName: ev.target.value })} />
        </div>
      )}
    </div>
  );

  return (
    <Modal wide title={initial.id ? 'Út szerkesztése' : 'Új út'} subtitle="Az út a telephelyről indul vagy oda érkezik; a másik végpont lehet mentett úticél vagy bármilyen cím — a legrövidebb autós útvonalat kiszámoljuk. A visszautat a generátor magától hozzáteszi." onClose={onClose}
      footer={<>
        {error && <span className="error-text" style={{ marginRight: 'auto' }}>{error}</span>}
        <button className="btn btn-ghost" onClick={onClose}>Mégse</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? <span className="spin" /> : <Icon name="save" />}Mentés</button>
      </>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr auto 1fr', alignItems: 'start' }}>
        {endInput('Honnan', from, setFrom, !initial.id)}
        <button className="btn btn-ghost icon-btn" style={{ marginTop: 28 }} title="Csere" aria-label="Kezdő- és végpont cseréje"
          onClick={() => { setFrom(to); setTo(from); }}><Icon name="swap" /></button>
        {endInput('Hová', to, setTo)}
      </div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 180px', alignItems: 'end' }}>
        <Field label="Az út neve">
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} placeholder="pl. Telephely → OTP" />
        </Field>
        <Field label="Távolság">
          <div className="input-suffix">
            <input className="input mono" inputMode="decimal" value={km} onChange={(e) => { setKm(e.target.value); setKmTouched(true); }} />
            <em>km</em>
          </div>
        </Field>
      </div>
      <div className="row small">
        {calcState === 'busy' && <><span className="spin" /> Útvonal számítása…</>}
        {calcState === 'error' && <span className="error-text">Az útvonal nem számolható — a távolságot kézzel is megadhatod.</span>}
        {calc && (
          <>
            <span className="chip go">Legrövidebb út: {fmtKm(calc.distanceKm)} km · ~{calc.durationMin} perc</span>
            {kmTouched && Number(km.replace(',', '.')) !== calc.distanceKm && (
              <button className="btn btn-sm btn-ghost" onClick={() => { setKm(String(calc.distanceKm).replace('.', ',')); setKmTouched(false); }}>Térkép szerinti érték használata</button>
            )}
          </>
        )}
      </div>
      <RouteMap points={points} line={calc?.geometry} height={300} />
    </Modal>
  );
}
