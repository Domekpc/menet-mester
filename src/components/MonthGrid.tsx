import type { ReactNode } from 'react';
import { addDays, isDrivingDay, lastDayOfMonth } from '../../shared/calendar';

const HEAD = ['H', 'K', 'Sze', 'Cs', 'P', 'Szo', 'V'];

/** Monday-first month calendar; cells outside the month are blank. */
export function MonthGrid({ month, cell, onCellClick, onDropOn, cellClass }: {
  month: string;
  cell: (date: string) => ReactNode;
  onCellClick?: (date: string) => void;
  onDropOn?: (date: string, data: string) => void;
  cellClass?: (date: string) => string;
}) {
  const first = `${month}-01`;
  const last = lastDayOfMonth(month);
  const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7;
  const dates: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = first; d <= last; d = addDays(d, 1)) dates.push(d);
  while (dates.length % 7) dates.push(null);

  return (
    <div className="mgrid">
      {HEAD.map((h) => <div key={h} className="mgrid-head">{h}</div>)}
      {dates.map((d, i) =>
        d ? (
          <div key={d}
            className={`mgrid-cell ${isDrivingDay(d) ? '' : 'off'} ${onCellClick ? 'click' : ''} ${cellClass?.(d) ?? ''}`}
            onClick={() => onCellClick?.(d)}
            onDragOver={onDropOn ? (e) => { e.preventDefault(); e.currentTarget.classList.add('drop'); } : undefined}
            onDragLeave={onDropOn ? (e) => e.currentTarget.classList.remove('drop') : undefined}
            onDrop={onDropOn ? (e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('drop');
              onDropOn(d, e.dataTransfer.getData('text/plain'));
            } : undefined}>
            <span className="mgrid-num">{Number(d.slice(8))}</span>
            {cell(d)}
          </div>
        ) : (
          <div key={`x${i}`} className="mgrid-cell blank" />
        ),
      )}
    </div>
  );
}
