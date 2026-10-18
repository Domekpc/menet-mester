import { useState } from 'react';
import { fmtDate } from '../api';
import { Icon } from './Icon';
import type { RulePeriod, UnitRule } from '../../shared/types';

export const WEEKDAYS = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];
const PERIODS: { v: RulePeriod; label: string; per: string }[] = [
  { v: 'day', label: 'Naponta', per: 'naponta' },
  { v: 'week', label: 'Hetente', per: 'hetente' },
  { v: 'month', label: 'Havonta', per: 'havonta' },
];

/** Editable rule state of one route or template in the generator. */
export interface RuleState {
  on: boolean;
  period: RulePeriod;
  min: string;
  max: string;
  gap: string;
  weekdays: number[];
  onlyDates: string[];
}

export const emptyRule = (on = true): RuleState => ({ on, period: 'month', min: '', max: '', gap: '', weekdays: [], onlyDates: [] });

/** Older saved preferences only had on/min/max. */
export const normalizeRule = (r: Partial<RuleState> | undefined, on = true): RuleState => ({ ...emptyRule(on), ...(r ?? {}) });

export const toUnitRule = (kind: UnitRule['kind'], id: number, r: RuleState): UnitRule => ({
  kind, id, period: r.period,
  min: r.min ? Number(r.min) : null,
  max: r.max ? Number(r.max) : null,
  minGapDays: r.gap ? Number(r.gap) : null,
  weekdays: [...r.weekdays].sort(),
  onlyDates: [...new Set(r.onlyDates)].sort(),
});

/** Short chips describing the rule, shown in the list row. */
export function ruleSummary(r: RuleState): string[] {
  if (r.onlyDates.length) return [`csak ${r.onlyDates.length} megadott napon`];
  const out: string[] = [];
  const per = PERIODS.find((p) => p.v === r.period)!.per;
  if (r.min && r.max) out.push(r.min === r.max ? `${per} ${r.min}×` : `${per} ${r.min}–${r.max}×`);
  else if (r.min) out.push(`${per} min. ${r.min}×`);
  else if (r.max) out.push(`${per} max. ${r.max}×`);
  if (r.gap) out.push(`≥ ${r.gap} nap szünet`);
  if (r.weekdays.length) out.push([...r.weekdays].sort().map((w) => WEEKDAYS[w - 1]).join(', '));
  return out;
}

const parseDates = (s: string) =>
  [...s.matchAll(/(\d{4})[.\-/ ]+(\d{1,2})[.\-/ ]+(\d{1,2})/g)].map((m) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`);

export function RuleEditor({ value, onChange, period }: { value: RuleState; onChange: (r: RuleState) => void; period: { from: string; to: string } }) {
  const [date, setDate] = useState('');
  const [paste, setPaste] = useState('');
  const set = (patch: Partial<RuleState>) => onChange({ ...value, ...patch });
  const dated = value.onlyDates.length > 0;
  const addDates = (list: string[]) => set({ onlyDates: [...new Set([...value.onlyDates, ...list])].sort() });
  const outside = value.onlyDates.filter((d) => d < period.from || d > period.to);
  const num = (v: string) => v.replace(/\D/g, '');

  return (
    <div className="rule-editor">
      <div className={`rule-block ${dated ? 'muted-block' : ''}`}>
        <div className="rule-label">Hányszor</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="tabs tabs-sm">
            {PERIODS.map((p) => <button key={p.v} type="button" className={value.period === p.v ? 'on' : ''} disabled={dated} onClick={() => set({ period: p.v })}>{p.label}</button>)}
          </div>
          <div className="limits">
            <input className="input mono" placeholder="min" inputMode="numeric" disabled={dated} value={value.min} aria-label="Minimum" onChange={(e) => set({ min: num(e.target.value) })} />
            <span className="muted">–</span>
            <input className="input mono" placeholder="max" inputMode="numeric" disabled={dated} value={value.max} aria-label="Maximum" onChange={(e) => set({ max: num(e.target.value) })} />
            <span className="muted small">alkalom</span>
          </div>
        </div>
      </div>

      <div className={`rule-block ${dated ? 'muted-block' : ''}`}>
        <div className="rule-label">Két alkalom között legalább</div>
        <div className="input-suffix" style={{ width: 130 }}>
          <input className="input mono" style={{ padding: '7px 10px' }} placeholder="–" inputMode="numeric" disabled={dated} value={value.gap} onChange={(e) => set({ gap: num(e.target.value) })} />
          <em>nap</em>
        </div>
      </div>

      <div className={`rule-block ${dated ? 'muted-block' : ''}`}>
        <div className="rule-label">Mely napokon</div>
        <div className="weekdays">
          {WEEKDAYS.map((w, i) => (
            <button key={w} type="button" disabled={dated} className={value.weekdays.includes(i + 1) ? 'on' : ''}
              onClick={() => set({ weekdays: value.weekdays.includes(i + 1) ? value.weekdays.filter((x) => x !== i + 1) : [...value.weekdays, i + 1] })}>{w}</button>
          ))}
        </div>
        <small className="muted">{value.weekdays.length ? 'Csak ezeken a napokon (többnapos útnál: indulás).' : 'Üresen: munkanapokon.'}</small>
      </div>

      <div className="rule-block">
        <div className="rule-label">Csak ezeken a napokon</div>
        <div className="row wrap" style={{ gap: 8 }}>
          <input type="date" className="input" style={{ width: 170, padding: '7px 10px' }} min={period.from} max={period.to} value={date} onChange={(e) => setDate(e.target.value)} />
          <button type="button" className="btn btn-sm" disabled={!date} onClick={() => { addDates([date]); setDate(''); }}><Icon name="plus" />Dátum</button>
          <input className="input" style={{ flex: 1, minWidth: 200, padding: '7px 10px' }} placeholder="vagy másold be: 2024.05.03, 2024.05.24 …" value={paste}
            onChange={(e) => setPaste(e.target.value)}
            onBlur={() => { const p = parseDates(paste); if (p.length) { addDates(p); setPaste(''); } }}
            onKeyDown={(e) => { if (e.key === 'Enter') { const p = parseDates(paste); if (p.length) { addDates(p); setPaste(''); } } }} />
        </div>
        {dated && (
          <>
            <div className="row wrap" style={{ gap: 6 }}>
              {value.onlyDates.map((d) => (
                <span key={d} className={`chip mono ${d < period.from || d > period.to ? 'stop' : ''}`}>{fmtDate(d)}
                  <button type="button" className="chip-x" aria-label="Eltávolítás" onClick={() => set({ onlyDates: value.onlyDates.filter((x) => x !== d) })}>×</button>
                </span>
              ))}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => set({ onlyDates: [] })}>Mind törlése</button>
            </div>
            <small className="muted">Pontosan ezeken a napokon szerepel, máskor soha — a többi szabály ilyenkor nem számít.{outside.length ? ` ${outside.length} dátum kívül esik az időszakon, ezeket kihagyjuk.` : ''}</small>
          </>
        )}
      </div>
    </div>
  );
}
