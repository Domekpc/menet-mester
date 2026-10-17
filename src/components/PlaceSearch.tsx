import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Icon } from './Icon';
import type { Destination, GeoSuggestion } from '../../shared/types';

export type PlacePick = { kind: 'saved'; destination: Destination } | { kind: 'address'; suggestion: GeoSuggestion };

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Google Maps style search box: as you type it lists matching saved destinations
 * first, then live address suggestions from OpenStreetMap.
 */
export function PlaceSearch({
  saved, text, onText, onPick, placeholder, autoFocus, invalid,
}: {
  saved?: Destination[];
  text: string;
  onText: (t: string) => void;
  onPick: (p: PlacePick) => void;
  placeholder?: string;
  autoFocus?: boolean;
  invalid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [results, setResults] = useState<GeoSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const savedHits = useMemo(() => {
    if (!saved) return [];
    const q = norm(text.trim());
    const list = q ? saved.filter((d) => norm(`${d.name} ${d.address}`).includes(q)) : saved;
    return list.slice(0, 5);
  }, [saved, text]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 3) { setResults([]); return; }
    const my = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = await api<GeoSuggestion[]>(`/api/geo/suggest?q=${encodeURIComponent(q)}`);
        if (my === seq.current) { setResults(r); setFailed(false); }
      } catch {
        if (my === seq.current) setFailed(true);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [text, open]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const options: PlacePick[] = [
    ...savedHits.map((d) => ({ kind: 'saved' as const, destination: d })),
    ...results.map((s) => ({ kind: 'address' as const, suggestion: s })),
  ];

  const choose = (p: PlacePick) => {
    onPick(p);
    setOpen(false);
  };

  return (
    <div className="ac" ref={boxRef}>
      <input
        className={`input ${invalid ? 'invalid' : ''}`}
        value={text}
        placeholder={placeholder ?? 'Kezdd el gépelni a címet vagy a helyet…'}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        // keep browser / password manager autofill (e.g. Safari's iCloud Passwords prompt) away
        // from this field: Safari skips fields whose name looks like a search box
        type="search"
        name="search-place"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        onFocus={() => setOpen(true)}
        onChange={(e) => { onText(e.target.value); setOpen(true); setHl(0); }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHl((h) => Math.min(h + 1, options.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHl((h) => Math.max(h - 1, 0)); }
          if (e.key === 'Enter' && options[hl]) { e.preventDefault(); choose(options[hl]); }
          if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        }}
      />
      {busy && <span className="ac-spin"><span className="spin" /></span>}
      {open && (savedHits.length > 0 || text.trim().length >= 3) && (
        <div className="ac-list" role="listbox">
          {savedHits.length > 0 && <div className="ac-group">Mentett úticélok</div>}
          {options.map((o, i) => {
            const first = o.kind === 'address' && i === savedHits.length;
            return (
              <div key={i}>
                {first && <div className="ac-group">Címek a térképről</div>}
                <div className={`ac-item ${i === hl ? 'hl' : ''}`} role="option" aria-selected={i === hl}
                  onMouseEnter={() => setHl(i)} onMouseDown={(e) => { e.preventDefault(); choose(o); }}>
                  <Icon name={o.kind === 'saved' ? 'flag' : 'pin'} />
                  <div>
                    <b>{o.kind === 'saved' ? o.destination.name : o.suggestion.primary}</b>
                    <small>{o.kind === 'saved' ? o.destination.address : o.suggestion.secondary}</small>
                  </div>
                </div>
              </div>
            );
          })}
          {text.trim().length >= 3 && !busy && results.length === 0 && (
            <div className="ac-empty">{failed ? 'A címkereső most nem érhető el.' : 'Nincs találat a térképen — próbáld irányítószámmal vagy településsel.'}</div>
          )}
        </div>
      )}
    </div>
  );
}
