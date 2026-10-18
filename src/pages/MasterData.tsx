import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCollection } from '../api';
import { Icon } from '../components/Icon';
import { Empty, Field, Modal, PageHead, Plate, useConfirm, useToast } from '../components/ui';
import { decimalHu, formatPlate } from '../../shared/plate';
import type { Company, Destination, Driver, Vehicle } from '../../shared/types';

type Kind = 'companies' | 'vehicles' | 'drivers';

interface FieldDef { key: string; label: string; hint?: string; type?: 'text' | 'number' | 'select'; options?: string[]; required?: boolean; suffix?: string }

const FORMS: Record<Kind, { title: string; one: string; icon: string; fields: FieldDef[] }> = {
  companies: {
    title: 'Cégek', one: 'cég', icon: 'building',
    fields: [
      { key: 'name', label: 'Cég neve', required: true },
      { key: 'address', label: 'Cím', required: true },
      { key: 'taxNumber', label: 'Adószám', hint: 'Formátum: 12345678-1-12', required: true },
    ],
  },
  vehicles: {
    title: 'Járművek', one: 'jármű', icon: 'car',
    fields: [
      { key: 'plate', label: 'Rendszám', required: true },
      { key: 'category', label: 'Kategória', type: 'select', options: ['Személygépkocsi', 'Kisteherautó', 'Tehergépkocsi', 'Motorkerékpár'] },
      { key: 'model', label: 'Típus', required: true },
      { key: 'fuel', label: 'Üzemanyag', type: 'select', options: ['Benzin', 'Dízel', 'Hibrid (benzin)', 'LPG'] },
      { key: 'consumption', label: 'Norma', type: 'number', suffix: 'L/100km', required: true, hint: 'Az üzemanyag-költség ebből számolódik' },
    ],
  },
  drivers: {
    title: 'Sofőrök', one: 'sofőr', icon: 'user',
    fields: [
      { key: 'name', label: 'Név', required: true },
      { key: 'taxNumber', label: 'Adóazonosító jel', required: true },
      { key: 'address', label: 'Lakcím', required: true },
    ],
  },
};

type AnyEntity = Company | Vehicle | Driver;

export function MasterDataPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Kind) ?? 'companies';
  const cols = {
    companies: useCollection<Company>('companies'),
    vehicles: useCollection<Vehicle>('vehicles'),
    drivers: useCollection<Driver>('drivers'),
  };
  const destinations = useCollection<Destination>('destinations');
  const [editing, setEditing] = useState<{ kind: Kind; item: Partial<AnyEntity> } | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  const col = cols[tab];
  const form = FORMS[tab];

  const remove = async (item: AnyEntity) => {
    const name = 'name' in item ? item.name : formatPlate((item as Vehicle).plate);
    if (!(await confirm(`${form.one[0].toUpperCase() + form.one.slice(1)} törlése`, `Biztosan törlöd: ${name}? A korábban mentett nyilvántartások nem változnak.`))) return;
    await col.remove(item.id);
    toast(`${name} törölve`);
  };

  return (
    <>
      <PageHead eyebrow="Törzsadatok" title="Cég, jármű, sofőr"
        text="Ezek kerülnek a nyilvántartás fejlécébe. Generáláskor csak ki kell választani őket."
        actions={<button className="btn btn-primary" onClick={() => setEditing({ kind: tab, item: {} })}><Icon name="plus" />Új {form.one}</button>} />

      <div className="tabs" style={{ marginBottom: 18 }}>
        {(Object.keys(FORMS) as Kind[]).map((k) => (
          <button key={k} className={k === tab ? 'on' : ''} onClick={() => setParams({ tab: k })}>
            {FORMS[k].title}<span className="count">{cols[k].items.length}</span>
          </button>
        ))}
      </div>

      {col.items.length === 0 && !col.loading ? (
        <div className="card"><Empty icon={form.icon} title={`Még nincs ${form.one}`} text="Vedd fel az elsőt, hogy generálni tudj."
          action={<button className="btn btn-primary" onClick={() => setEditing({ kind: tab, item: {} })}><Icon name="plus" />Új {form.one}</button>} /></div>
      ) : (
        <div className="grid cols-3">
          {col.items.map((item) => (
            <div key={item.id} className="card card-pad item" style={{ flexDirection: 'column', alignItems: 'stretch', cursor: 'default', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <div className="dot"><Icon name={form.icon} /></div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  {tab === 'vehicles' ? <Plate value={(item as Vehicle).plate} /> : <h3>{(item as Company).name}</h3>}
                </div>
                <div className="actions">
                  <button className="btn btn-ghost icon-btn" aria-label="Szerkesztés" onClick={() => setEditing({ kind: tab, item })}><Icon name="edit" /></button>
                  <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={() => remove(item)}><Icon name="trash" /></button>
                </div>
              </div>
              <dl style={{ margin: '14px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 14 }}>
                {form.fields.filter((f) => !(tab === 'vehicles' && f.key === 'plate') && !(tab !== 'vehicles' && f.key === 'name')).map((f) => (
                  <Detail key={f.key} label={f.label} value={`${f.type === 'number' ? decimalHu((item as unknown as Record<string, number>)[f.key]) : (item as unknown as Record<string, string>)[f.key]}${f.suffix ? ' ' + f.suffix : ''}`} />
                ))}
                {tab === 'companies' && (
                  <Detail label="Telephely" value={destinations.items.find((d) => d.id === (item as Company).homeDestinationId)?.name ?? '—'} />
                )}
              </dl>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <EntityForm kind={editing.kind} item={editing.item} destinations={destinations.items}
          onClose={() => setEditing(null)}
          onSave={async (data) => {
            const c = cols[editing.kind];
            if (editing.item.id) await c.update(editing.item.id, data as never);
            else await c.create(data as never);
            toast(editing.item.id ? 'Módosítás mentve' : `Új ${FORMS[editing.kind].one} létrehozva`);
            setEditing(null);
          }} />
      )}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <><dt className="muted">{label}</dt><dd style={{ margin: 0, fontWeight: 500 }}>{value}</dd></>;
}

function EntityForm({ kind, item, destinations, onClose, onSave }: {
  kind: Kind; item: Partial<AnyEntity>; destinations: Destination[];
  onClose: () => void; onSave: (data: Record<string, unknown>) => Promise<void>;
}) {
  const form = FORMS[kind];
  const [data, setData] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = { ...item };
    form.fields.forEach((f) => { if (init[f.key] == null) init[f.key] = f.options?.[0] ?? ''; });
    if (kind === 'companies' && init.homeDestinationId === undefined) init.homeDestinationId = null;
    return init;
  });
  const [tried, setTried] = useState(false);
  const missing = form.fields.filter((f) => f.required && String(data[f.key] ?? '').trim() === '');

  const submit = async () => {
    setTried(true);
    if (missing.length) return;
    const out = { ...data };
    if (kind === 'vehicles') {
      out.consumption = Number(String(out.consumption).replace(',', '.'));
      out.plate = formatPlate(String(out.plate));
    }
    delete out.id;
    await onSave(out);
  };

  return (
    <Modal title={item.id ? `${form.one[0].toUpperCase() + form.one.slice(1)} szerkesztése` : `Új ${form.one}`} onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Mégse</button><button className="btn btn-primary" onClick={submit}>Mentés</button></>}>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="stack">
        {form.fields.map((f, i) => (
          <Field key={f.key} label={f.label} hint={f.hint} error={tried && missing.includes(f) ? 'Kötelező mező' : undefined}>
            {f.type === 'select' ? (
              <select className="input" value={String(data[f.key])} onChange={(e) => setData({ ...data, [f.key]: e.target.value })}>
                {[...new Set([...(f.options ?? []), String(data[f.key])])].filter(Boolean).map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : (
              <div className="input-suffix">
                <input className={`input ${tried && missing.includes(f) ? 'invalid' : ''}`} autoFocus={i === 0}
                  inputMode={f.type === 'number' ? 'decimal' : undefined}
                  value={String(data[f.key] ?? '')} onChange={(e) => setData({ ...data, [f.key]: e.target.value })} />
                {f.suffix && <em>{f.suffix}</em>}
              </div>
            )}
          </Field>
        ))}
        {kind === 'companies' && (
          <Field label="Telephely (innen indulnak és ide érkeznek vissza az utak)" hint="Az „Utak és úticélok” oldalon felvett úticélok közül">
            <select className="input" value={String(data.homeDestinationId ?? '')}
              onChange={(e) => setData({ ...data, homeDestinationId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">— nincs megadva —</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.address}</option>)}
            </select>
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
