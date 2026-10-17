import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtInt, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { PlaceSearch, type PlacePick } from '../components/PlaceSearch';
import { Empty, Field, Modal, PageHead, Plate, useConfirm, useToast } from '../components/ui';
import type { Destination, Vehicle, VehicleEvent, VehicleEventType } from '../../shared/types';

export const EVENT_TYPES: Record<VehicleEventType, { label: string; cls: string }> = {
  service: { label: 'Szerviz', cls: 'info' },
  inspection: { label: 'Műszaki vizsga', cls: 'go' },
  other: { label: 'Egyéb', cls: '' },
};

export function JournalPage() {
  const vehicles = useCollection<Vehicle>('vehicles');
  const events = useCollection<VehicleEvent>('vehicle-events');
  const dests = useCollection<Destination>('destinations');
  const [vehicleId, setVehicleId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Partial<VehicleEvent> | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  useEffect(() => {
    if (vehicleId == null && vehicles.items[0]) setVehicleId(vehicles.items[0].id);
  }, [vehicles.items, vehicleId]);

  const list = events.items.filter((e) => e.vehicleId === vehicleId).sort((a, b) => b.date.localeCompare(a.date));
  const byId = new Map(dests.items.map((d) => [d.id, d]));

  return (
    <>
      <PageHead eyebrow="Kötelező helyszínek forrása" title="Járműnapló"
        text="Szervizlátogatások, műszaki vizsgák és más események, amikor az autónak bizonyosan egy adott helyen kellett lennie — rögzített km-állással. A generátor ezeket kötelezően beépíti."
        actions={<button className="btn btn-primary" disabled={!vehicleId} onClick={() => setEditing({ vehicleId: vehicleId!, type: 'service', date: new Date().toISOString().slice(0, 10) })}><Icon name="plus" />Új esemény</button>} />

      <div className="row wrap" style={{ marginBottom: 18 }}>
        {vehicles.items.map((v) => (
          <button key={v.id} className={`pick ${v.id === vehicleId ? 'on' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: '10px 44px 10px 14px' }} onClick={() => setVehicleId(v.id)}>
            <Plate value={v.plate} /><span>{v.model}</span>
          </button>
        ))}
      </div>

      <div className="split" style={{ gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)' }}>
        <div className="card">
          {list.length === 0 ? (
            <Empty icon="wrench" title="Nincs rögzített esemény" text="Vedd fel a szerviz- és vizsgaalkalmakat a km-állással — így a generált nyilvántartás egyezni fog a hivatalos adatokkal." />
          ) : (
            <table className="table">
              <thead><tr><th>Dátum</th><th>Esemény</th><th>Helyszín</th><th className="num">Km-állás</th><th /></tr></thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{fmtDate(e.date)}</td>
                    <td><span className={`chip ${EVENT_TYPES[e.type]?.cls}`}>{EVENT_TYPES[e.type]?.label}</span>{e.note && <div className="muted small">{e.note}</div>}</td>
                    <td><b>{byId.get(e.destinationId)?.name}</b><div className="muted small">{byId.get(e.destinationId)?.address}</div></td>
                    <td className="num mono">{e.odometer != null ? fmtInt(e.odometer) : '—'}</td>
                    <td>
                      <div className="actions">
                        <button className="btn btn-ghost icon-btn" aria-label="Szerkesztés" onClick={() => setEditing(e)}><Icon name="edit" /></button>
                        <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={async () => {
                          if (!(await confirm('Esemény törlése', 'Biztosan törlöd ezt az eseményt?'))) return;
                          await events.remove(e.id); toast('Esemény törölve');
                        }}><Icon name="trash" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card card-pad stack">
          <div className="row"><Icon name="link" /><h3>Honnan jöhetnek ezek az adatok?</h3></div>
          <p className="small">A km-állás hivatalosan a <b>Jármű Szolgáltatási Platformba (JSZP)</b> kerül be szervizeléskor és műszaki vizsgán. Ehhez nincs nyilvános, automatizálható API: a jármű előélete a <i>magyarorszag.hu</i>-n Ügyfélkapuval kérdezhető le.</p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <li><b>Most:</b> a JSZP lekérdezés / szervizszámla / vizsgalap alapján itt rögzíted — a generátor innen „kéri le”.</li>
            <li><b>Bővíthető:</b> gyártói felhő (pl. Mercedes-Benz connected car API) vagy flottakezelő GPS — üzleti szerződéssel, a rendszer forrás-modulként fogadja.</li>
          </ul>
        </div>
      </div>

      {editing && (
        <EventForm initial={editing} destinations={dests.items} onClose={() => setEditing(null)}
          onSave={async (data) => {
            if (editing.id) await events.update(editing.id, data); else await events.create(data);
            await dests.reload();
            setEditing(null); toast('Esemény mentve');
          }} />
      )}
    </>
  );
}

function EventForm({ initial, destinations, onClose, onSave }: {
  initial: Partial<VehicleEvent>; destinations: Destination[]; onClose: () => void; onSave: (e: Omit<VehicleEvent, 'id'>) => Promise<void>;
}) {
  const [date, setDate] = useState(initial.date ?? '');
  const [type, setType] = useState<VehicleEventType>(initial.type ?? 'service');
  const [odo, setOdo] = useState(initial.odometer != null ? String(initial.odometer) : '');
  const [note, setNote] = useState(initial.note ?? '');
  const [place, setPlace] = useState<PlacePick | null>(() => {
    const d = destinations.find((x) => x.id === initial.destinationId);
    return d ? { kind: 'saved', destination: d } : null;
  });
  const [placeName, setPlaceName] = useState('');
  const [text, setText] = useState(place?.kind === 'saved' ? place.destination.name : '');
  const [err, setErr] = useState('');

  const ready = useMemo(() => !!date && !!place && (place.kind === 'saved' || placeName.trim()), [date, place, placeName]);

  const submit = async () => {
    if (!ready) return setErr('Add meg a dátumot és a helyszínt.');
    let destinationId: number;
    if (place!.kind === 'saved') destinationId = place!.destination.id;
    else {
      const s = place!.suggestion;
      destinationId = (await api<Destination>('/api/destinations', { method: 'POST', json: { name: placeName.trim(), address: s.label, lat: s.lat, lon: s.lon } })).id;
    }
    await onSave({
      vehicleId: initial.vehicleId!, date, type, destinationId,
      odometer: odo ? Number(odo.replace(/\D/g, '')) : null, note: note.trim(), source: initial.source ?? 'Kézi rögzítés',
    });
  };

  return (
    <Modal title={initial.id ? 'Esemény szerkesztése' : 'Új esemény'} onClose={onClose}
      footer={<>{err && <span className="error-text" style={{ marginRight: 'auto' }}>{err}</span>}<button className="btn btn-ghost" onClick={onClose}>Mégse</button><button className="btn btn-primary" onClick={submit}>Mentés</button></>}>
      <div className="grid cols-2">
        <Field label="Dátum"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Típus">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as VehicleEventType)}>
            {Object.entries(EVENT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Helyszín" hint="Mentett úticél vagy új cím">
        <PlaceSearch saved={destinations} text={text} onText={(t) => { setText(t); setPlace(null); }}
          onPick={(p) => { setPlace(p); setText(p.kind === 'saved' ? p.destination.name : p.suggestion.label); if (p.kind === 'address') setPlaceName(p.suggestion.primary); }} />
      </Field>
      {place?.kind === 'address' && (
        <Field label="Új úticél neve"><input className="input" value={placeName} onChange={(e) => setPlaceName(e.target.value)} placeholder="pl. Mercedes szerviz Pécs" /></Field>
      )}
      <div className="grid cols-2">
        <Field label="Rögzített km-állás" hint="Ha ismert (vizsgalap, munkalap)">
          <div className="input-suffix"><input className="input mono" inputMode="numeric" value={odo} onChange={(e) => setOdo(e.target.value.replace(/\D/g, ''))} /><em>km</em></div>
        </Field>
        <Field label="Megjegyzés"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="pl. olajcsere" /></Field>
      </div>
    </Modal>
  );
}
