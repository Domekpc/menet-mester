import { useMemo, useState } from 'react';
import { api, fmtDate, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { PlaceSearch } from '../components/PlaceSearch';
import { Empty, Field, Modal, PageHead, useConfirm, useToast } from '../components/ui';
import { BASE, type Destination, type TripTemplate, type TripTemplateDay } from '../../shared/types';

export const WEEKDAYS = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
export const BASE_PLACE: Destination = { id: BASE, name: 'Telephely', address: 'a generáláskor kiválasztott telephely', lat: null, lon: null, maxPerDay: null, minGapDays: null };

/** "1. nap", "2–4. nap" labels for template rows. */
export function dayLabels(days: TripTemplateDay[]) {
  let n = 1;
  return days.map((d) => {
    const r = Math.max(1, d.repeat || 1);
    const label = r > 1 ? `${n}–${n + r - 1}. nap` : `${n}. nap`;
    n += r;
    return label;
  });
}
export const templateLength = (t: Pick<TripTemplate, 'days'>) => t.days.reduce((s, d) => s + Math.max(1, d.repeat || 1), 0);

export function placeName(id: number, byId: Map<number, Destination>) {
  return id === BASE ? 'Telephely' : byId.get(id)?.name ?? '?';
}

/** One-line description of a template day. */
export function dayText(d: TripTemplateDay, byId: Map<number, Destination>) {
  return d.stops.length ? d.stops.map((id) => placeName(id, byId)).join(' → ') : 'az autó áll';
}

export function frequencyText(t: TripTemplate) {
  if (t.onlyDates.length) return `csak megadott napokon (${t.onlyDates.length})`;
  const parts = [];
  if (t.minPerMonth) parts.push(`min. ${t.minPerMonth}`);
  if (t.maxPerMonth != null) parts.push(`max. ${t.maxPerMonth}`);
  return parts.length ? `havonta ${parts.join(', ')}` : 'a generátor dönti el';
}

export function TemplatesPage() {
  const list = useCollection<TripTemplate>('templates');
  const dests = useCollection<Destination>('destinations');
  const [editing, setEditing] = useState<Partial<TripTemplate> | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const byId = useMemo(() => new Map(dests.items.map((d) => [d.id, d])), [dests.items]);

  return (
    <>
      <PageHead eyebrow="Útkészlet" title="Utazás-sablonok"
        text="Így szokott kinézni egy utazás, napokra bontva — például hétfőn kimész Deutschlandsbergbe, közben minden nap Aicheggbe és vissza, pénteken haza. A generátor egészében teszi be, vagy te húzod a naptárba."
        actions={<button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" />Új sablon</button>} />

      {list.items.length === 0 && !list.loading ? (
        <div className="card">
          <Empty icon="calendar" title="Még nincs utazás-sablon" text="Egy sablon lehet egy többnapos kiküldetés, egy szokásos körút (posta → bank → könyvelő), vagy egy út, ami csak megadott napokon történt."
            action={<button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" />Első sablon</button>} />
        </div>
      ) : (
        <div className="grid cols-2">
          {list.items.map((t) => (
            <div key={t.id} className="card card-pad item" style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'default', gap: 12 }}>
              <div className="row">
                <div className="dot"><Icon name="calendar" /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3>{t.name}</h3>
                  <div className="muted small">{templateLength(t)} nap · {frequencyText(t)}</div>
                </div>
                <div className="actions">
                  <button className="btn btn-ghost icon-btn" aria-label="Szerkesztés" onClick={() => setEditing(t)}><Icon name="edit" /></button>
                  <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={async () => {
                    if (!(await confirm('Sablon törlése', `Biztosan törlöd: ${t.name}?`))) return;
                    await list.remove(t.id); toast('Sablon törölve');
                  }}><Icon name="trash" /></button>
                </div>
              </div>
              <div className="tpl-days">
                {t.days.map((d, i) => (
                  <div key={i} className="tpl-day">
                    <span className="mono small">{dayLabels(t.days)[i]}</span>
                    <span className={d.stops.length ? '' : 'muted'}>{dayText(d, byId)}</span>
                  </div>
                ))}
              </div>
              {t.startWeekdays.length > 0 && (
                <div className="row small" style={{ gap: 6 }}>
                  <span className="muted">Indul:</span>
                  {t.startWeekdays.map((w) => <span key={w} className="chip">{WEEKDAYS[w - 1]}</span>)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TemplateForm initial={editing} destinations={dests.items} reloadDests={dests.reload} onClose={() => setEditing(null)}
          onSave={async (t) => {
            if (editing.id) await list.update(editing.id, t); else await list.create(t);
            setEditing(null); toast('Sablon mentve');
          }} />
      )}
    </>
  );
}

function TemplateForm({ initial, destinations, reloadDests, onClose, onSave }: {
  initial: Partial<TripTemplate>; destinations: Destination[]; reloadDests: () => Promise<void>;
  onClose: () => void; onSave: (t: Omit<TripTemplate, 'id'>) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name ?? '');
  const [weekdays, setWeekdays] = useState<number[]>(initial.startWeekdays ?? []);
  const [days, setDays] = useState<TripTemplateDay[]>(initial.days?.length ? initial.days : [{ stops: [BASE], repeat: 1 }]);
  const [mode, setMode] = useState<'auto' | 'dates'>(initial.onlyDates?.length ? 'dates' : 'auto');
  const [min, setMin] = useState(initial.minPerMonth != null ? String(initial.minPerMonth) : '');
  const [max, setMax] = useState(initial.maxPerMonth != null ? String(initial.maxPerMonth) : '');
  const [dates, setDates] = useState<string[]>(initial.onlyDates ?? []);
  const [dateInput, setDateInput] = useState('');
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState(initial.note ?? '');
  const [adding, setAdding] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');

  const saved = useMemo(() => [BASE_PLACE, ...destinations], [destinations]);
  const byId = useMemo(() => new Map(destinations.map((d) => [d.id, d])), [destinations]);
  const labels = dayLabels(days);

  const setDay = (i: number, patch: Partial<TripTemplateDay>) => setDays(days.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  /** where the car is at the end of row i */
  const endOf = (i: number): number => {
    for (let j = i; j >= 0; j--) if (days[j].stops.length) return days[j].stops[days[j].stops.length - 1];
    return BASE;
  };

  // continuity hints
  const hints: string[] = [];
  days.forEach((d, i) => {
    if (!d.stops.length) return;
    const from = i === 0 ? BASE : endOf(i - 1);
    if (d.stops[0] !== from) hints.push(`${labels[i]}: ${placeName(from, byId)} helyett innen indul: ${placeName(d.stops[0], byId)}.`);
  });
  if (endOf(days.length - 1) !== BASE) hints.push('Az utolsó nap nem a telephelyen ér véget — utána az autó nem lesz otthon.');

  const parseDates = (s: string) =>
    [...s.matchAll(/(\d{4})[.\-/ ]+(\d{1,2})[.\-/ ]+(\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);

  const submit = async () => {
    setErr('');
    if (!name.trim()) return setErr('Adj nevet a sablonnak.');
    if (!days.some((d) => d.stops.length > 1)) return setErr('Legalább egy napon legyen út (két hely).');
    if (mode === 'dates' && !dates.length) return setErr('Adj meg legalább egy dátumot, vagy válaszd az automatikus gyakoriságot.');
    await onSave({
      name: name.trim(), startWeekdays: [...weekdays].sort(), days: days.map((d) => ({ stops: d.stops, repeat: Math.max(1, d.repeat || 1) })),
      minPerMonth: mode === 'auto' && min ? Number(min) : null, maxPerMonth: mode === 'auto' && max ? Number(max) : null,
      onlyDates: mode === 'dates' ? [...new Set(dates)].sort() : [], note: note.trim(),
    });
  };

  return (
    <Modal wide title={initial.id ? 'Sablon szerkesztése' : 'Új utazás-sablon'} subtitle="Napról napra: hova megy az autó. Ha több egymást követő nap ugyanolyan, elég egyszer felvenni és megadni, hány napig ismétlődik."
      onClose={onClose}
      footer={<>{err && <span className="error-text" style={{ marginRight: 'auto' }}>{err}</span>}<button className="btn btn-ghost" onClick={onClose}>Mégse</button><button className="btn btn-primary" onClick={submit}><Icon name="save" />Mentés</button></>}>
      <div className="grid" style={{ gridTemplateColumns: '1fr auto', alignItems: 'end' }}>
        <Field label="Név"><input className="input" autoFocus={!initial.id} value={name} onChange={(e) => setName(e.target.value)} placeholder="pl. Deutschlandsbergi hét" /></Field>
        <Field label="Indulhat ezeken a napokon">
          <div className="weekdays">
            {WEEKDAYS.map((w, i) => (
              <button key={w} type="button" className={weekdays.includes(i + 1) ? 'on' : ''}
                onClick={() => setWeekdays(weekdays.includes(i + 1) ? weekdays.filter((x) => x !== i + 1) : [...weekdays, i + 1])}>{w}</button>
            ))}
          </div>
        </Field>
      </div>
      <small className="muted" style={{ marginTop: -8 }}>{weekdays.length ? '' : 'Ha egy napot sem jelölsz, bármelyik munkanapon indulhat.'}</small>

      <div className="stack" style={{ gap: 10 }}>
        {days.map((d, i) => (
          <div key={i} className="tpl-row">
            <div className="tpl-row-head">
              <b className="mono">{labels[i]}</b>
              <div className="stepper" title="Ennyi egymást követő napon ugyanez">
                <button type="button" onClick={() => setDay(i, { repeat: Math.max(1, d.repeat - 1) })} aria-label="Kevesebb nap">−</button>
                <span className="mono">{d.repeat}</span>
                <button type="button" onClick={() => setDay(i, { repeat: d.repeat + 1 })} aria-label="Több nap">+</button>
                <small className="muted">napig</small>
              </div>
            </div>
            <div className="tpl-chain">
              {d.stops.length === 0 && <span className="muted small">Az autó áll, nincs út.</span>}
              {d.stops.map((id, k) => (
                <span key={k} className="row" style={{ gap: 6 }}>
                  {k > 0 && <span className="muted">→</span>}
                  <span className={`chip ${id === BASE ? 'info' : ''}`}>
                    {placeName(id, byId)}
                    <button type="button" className="chip-x" aria-label="Eltávolítás" onClick={() => setDay(i, { stops: d.stops.filter((_, j) => j !== k) })}>×</button>
                  </span>
                </span>
              ))}
              {adding === i ? (
                <div style={{ minWidth: 260, flex: 1 }}>
                  <PlaceSearch saved={saved} text={text} autoFocus placeholder="Úticél vagy cím…" onText={setText}
                    onPick={async (p) => {
                      const id = p.kind === 'saved' ? p.destination.id : (await api<Destination>('/api/destinations', {
                        method: 'POST', json: { name: p.suggestion.primary, address: p.suggestion.label, lat: p.suggestion.lat, lon: p.suggestion.lon },
                      })).id;
                      if (p.kind === 'address') await reloadDests();
                      setDay(i, { stops: [...d.stops, id] });
                      setText('');
                    }} />
                </div>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setAdding(i); setText(''); }}><Icon name="plus" />hely</button>
              )}
              {adding === i && <button type="button" className="btn btn-sm" onClick={() => setAdding(null)}>Kész</button>}
            </div>
            <div className="row small" style={{ gap: 6 }}>
              {d.stops.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDay(i, { stops: [] })}>Az autó áll ezen a napon</button>}
              {i > 0 && <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => setDays(days.filter((_, j) => j !== i))}><Icon name="trash" />nap törlése</button>}
            </div>
          </div>
        ))}
        <button type="button" className="btn" style={{ alignSelf: 'flex-start' }}
          onClick={() => { setDays([...days, { stops: [endOf(days.length - 1)], repeat: 1 }]); setAdding(days.length); setText(''); }}>
          <Icon name="plus" />Következő nap
        </button>
        {hints.length > 0 && <div className="note warn"><Icon name="alert" /><div>{hints.map((h) => <div key={h}>{h}</div>)}</div></div>}
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <span className="small" style={{ fontWeight: 600, color: 'var(--ink-2)' }}>Mikor fordul elő?</span>
        <div className="tabs">
          <button type="button" className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>A generátor dönti el</button>
          <button type="button" className={mode === 'dates' ? 'on' : ''} onClick={() => setMode('dates')}>Csak ezeken a napokon</button>
        </div>
        {mode === 'auto' ? (
          <div className="row">
            <Field label="Havonta legalább"><input className="input mono" style={{ width: 110 }} inputMode="numeric" placeholder="–" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ''))} /></Field>
            <Field label="Havonta legfeljebb"><input className="input mono" style={{ width: 110 }} inputMode="numeric" placeholder="∞" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
        ) : (
          <>
            <p className="small muted">Pontosan ezeken a napokon indul, máskor soha — például ha számla igazolja, mikor voltál ott.</p>
            <div className="row wrap">
              <input type="date" className="input" style={{ width: 180 }} value={dateInput} onChange={(e) => setDateInput(e.target.value)} />
              <button type="button" className="btn" disabled={!dateInput} onClick={() => { setDates([...new Set([...dates, dateInput])].sort()); setDateInput(''); }}><Icon name="plus" />Dátum</button>
              <input className="input" style={{ flex: 1, minWidth: 220 }} placeholder="vagy másold be: 2024.05.03, 2024.05.24 …" value={paste}
                onChange={(e) => setPaste(e.target.value)}
                onBlur={() => { const p = parseDates(paste); if (p.length) { setDates([...new Set([...dates, ...p])].sort()); setPaste(''); } }} />
            </div>
            <div className="row wrap" style={{ gap: 6 }}>
              {dates.map((x) => (
                <span key={x} className="chip mono">{fmtDate(x)}<button type="button" className="chip-x" aria-label="Eltávolítás" onClick={() => setDates(dates.filter((y) => y !== x))}>×</button></span>
              ))}
            </div>
          </>
        )}
        <Field label="Megjegyzés"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="pl. számlák alapján" /></Field>
      </div>
    </Modal>
  );
}
