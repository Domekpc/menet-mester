import { useMemo, useState } from 'react';
import { fmtDate, fmtInt, fmtKm } from '../api';
import { monthLabel, MONTH_NAMES } from '../../shared/calendar';
import type { DayKind, DayPlan, Destination, GenerateResult, Vehicle } from '../../shared/types';
import { Icon } from './Icon';
import { MonthGrid } from './MonthGrid';
import { decimalHu } from '../../shared/plate';

export const KIND_LABEL: Record<DayKind, string> = {
  free: 'generált', template: 'utazás-sablon', required: 'járműnapló', plan: 'megadott nap',
};

const weekdays = ['V', 'H', 'K', 'Sze', 'Cs', 'P', 'Szo'];
const wd = (d: string) => weekdays[new Date(`${d}T00:00:00Z`).getUTCDay()];

/** Month-by-month preview of a generated record with fuel cost calculation. */
export function ResultView({ result, vehicle, destById, fuelPrices, onFuelPrice, lockedUnits, onToggleLock }: {
  result: GenerateResult;
  vehicle?: Vehicle;
  destById?: Map<number, Destination>;
  fuelPrices: Record<string, number>;
  onFuelPrice?: (month: string, price: number) => void;
  lockedUnits?: Set<string>;
  onToggleLock?: (unitId: string) => void;
}) {
  const [tab, setTab] = useState(0);
  const [view, setView] = useState<'calendar' | 'table'>('calendar');
  const dayMap = useMemo(() => new Map((result.days ?? []).map((d) => [d.date, d])), [result.days]);
  const dayKm = useMemo(() => {
    const m = new Map<string, number>();
    for (const mo of result.months) for (const l of mo.legs) m.set(l.date, Math.round(((m.get(l.date) ?? 0) + l.km) * 10) / 10);
    return m;
  }, [result.months]);
  const placeName = (id: number) => destById?.get(id)?.name ?? result.months.flatMap((m) => m.legs).find((l) => l.toId === id)?.partner ?? '?';
  const isLocked = (d: DayPlan) => !!lockedUnits?.has(d.unitId) || !!d.locked;
  const month = result.months[tab];
  const max = Math.max(1, ...result.months.map((m) => m.totalKm));
  const cost = (m: { month: string; totalKm: number }) =>
    vehicle ? Math.round((m.totalKm * vehicle.consumption * (fuelPrices[m.month] ?? 0)) / 100) : 0;
  const totalCost = result.months.reduce((s, m) => s + cost(m), 0);
  const diff = Math.round((result.totalKm - result.targetKm) * 10) / 10;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Összes út</div>
          <div className="v">{fmtKm(result.totalKm)}<small>km</small></div>
          <div className={`small ${Math.abs(diff) < 1 ? '' : 'error-text'}`} style={{ color: Math.abs(diff) < 1 ? 'var(--go)' : undefined }}>
            {Math.abs(diff) < 1 ? '✓ egyezik a km-óra különbségével' : `${diff > 0 ? '+' : ''}${fmtKm(diff)} km eltérés a km-órától`}
          </div>
        </div>
        <div className="card stat">
          <div className="k">Utak száma</div>
          <div className="v">{result.months.reduce((s, m) => s + m.legs.length, 0)}<small>szakasz</small></div>
          <div className="small muted">{result.months.length} hónap · {result.months.reduce((s, m) => s + new Set(m.legs.map((l) => l.date)).size, 0)} úti nap</div>
        </div>
        <div className="card stat">
          <div className="k">Üzemanyagköltség</div>
          <div className="v">{fmtInt(totalCost)}<small>Ft</small></div>
          <div className="small muted">{vehicle ? `${decimalHu(vehicle.consumption)} L/100km norma alapján` : ''}</div>
        </div>
      </div>

      {result.warnings.length > 0 && (
        <div className="note warn">
          <Icon name="alert" />
          <div><b>Figyelj ezekre:</b><ul>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div>
        </div>
      )}

      <div className="card card-pad">
        <div className="month-bars">
          {result.months.map((m, i) => (
            <div key={m.month} className={i === tab ? 'on' : ''} style={{ cursor: 'pointer' }} onClick={() => setTab(i)} title={`${monthLabel(m.month)}: ${fmtKm(m.totalKm)} km`}>
              <i style={{ height: `${(m.totalKm / max) * 70}%` }} />
              <span>{MONTH_NAMES[Number(m.month.slice(5)) - 1].slice(0, 3)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="row wrap" style={{ padding: 16, borderBottom: '1px solid var(--line)', gap: 16 }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="btn btn-ghost icon-btn" disabled={tab === 0} onClick={() => setTab(tab - 1)} aria-label="Előző hónap"><Icon name="arrowLeft" /></button>
            <h3 style={{ minWidth: 150, textAlign: 'center' }}>{monthLabel(month.month)}</h3>
            <button className="btn btn-ghost icon-btn" disabled={tab === result.months.length - 1} onClick={() => setTab(tab + 1)} aria-label="Következő hónap"><Icon name="arrowRight" /></button>
          </div>
          <span className="chip">Kezdő km: <b className="mono">{fmtInt(month.startOdometer)}</b></span>
          <span className="chip">Záró km: <b className="mono">{fmtInt(month.endOdometer)}</b></span>
          <div className="spacer" />
          <label className="row small" style={{ gap: 8 }}>
            {vehicle?.fuel ?? 'Üzemanyag'} ár
            <div className="input-suffix" style={{ width: 120 }}>
              <input className="input mono" style={{ padding: '7px 10px' }} inputMode="numeric" disabled={!onFuelPrice}
                value={fuelPrices[month.month] ?? ''} onChange={(e) => onFuelPrice?.(month.month, Number(e.target.value.replace(/\D/g, '')))} />
              <em>Ft/L</em>
            </div>
          </label>
          <span className="chip sign">{fmtKm(month.totalKm)} km · {fmtInt(cost(month))} Ft</span>
          {result.days && (
            <div className="tabs">
              <button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>Naptár</button>
              <button className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>Táblázat</button>
            </div>
          )}
        </div>
        {view === 'calendar' && result.days ? (
          <div style={{ padding: 16 }} className="stack">
            {onToggleLock && <p className="muted small">Kattints egy napra a rögzítéshez — az „Új változat” a rögzített napokat (és a hozzájuk tartozó többnapos utat) megtartja, a többit újrasorsolja.</p>}
            <MonthGrid month={month.month}
              onCellClick={onToggleLock ? (d) => { const p = dayMap.get(d); if (p) onToggleLock(p.unitId); } : undefined}
              cellClass={(d) => { const p = dayMap.get(d); return p ? `rk-${p.kind} ${isLocked(p) ? 'locked' : ''}` : ''; }}
              cell={(d) => {
                const p = dayMap.get(d);
                if (!p) return null;
                return (
                  <div className="mgrid-items" title={`${KIND_LABEL[p.kind]}${p.label ? ' · ' + p.label : ''}`}>
                    {isLocked(p) && <span className="lock-badge" aria-label="Rögzítve"><Icon name="check" size={11} /></span>}
                    <span className="rday">{p.stops.length ? p.stops.map(placeName).join(' → ') : <i>ott tartózkodik</i>}</span>
                    {dayKm.get(d) ? <span className="rkm mono">{fmtKm(dayKm.get(d)!)} km</span> : null}
                  </div>
                );
              }} />
            <div className="row wrap small" style={{ gap: 14 }}>
              {(Object.keys(KIND_LABEL) as DayKind[]).map((k) => <span key={k} className="legend"><i className={`lg rk-${k}`} />{KIND_LABEL[k]}</span>)}
            </div>
          </div>
        ) : month.legs.length === 0 ? (
          <p className="muted" style={{ padding: 24 }}>Ebben a hónapban nincs út.</p>
        ) : (
          <table className="table">
            <thead><tr><th style={{ width: 150 }}>Dátum</th><th>Útvonal</th><th>Partner</th><th className="num">Km</th></tr></thead>
            <tbody>
              {month.legs.map((l, i) => {
                const newDay = i === 0 || month.legs[i - 1].date !== l.date;
                return (
                  <tr key={i} className={l.required ? 'req' : ''} style={newDay && i > 0 ? { borderTop: '2px solid var(--line)' } : undefined}>
                    <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{newDay ? <>{fmtDate(l.date)} <span className="muted">{wd(l.date)}</span></> : ''}</td>
                    <td>
                      <span className="small">{l.fromAddress} <span className="muted">→</span> {l.toAddress}</span>
                      {l.required && <span className="chip sign" style={{ marginLeft: 8 }}>{l.kind === 'plan' ? 'megadott' : 'kötelező'}</span>}
                      {newDay && l.kind === 'template' && <span className="chip info" style={{ marginLeft: 8 }}>{l.label}</span>}
                    </td>
                    <td>{l.partner}</td>
                    <td className="num mono">{fmtKm(l.km)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
