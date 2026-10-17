import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useCollection } from '../api';
import { Icon } from '../components/Icon';
import type { Destination, Route, SavedReport, Vehicle, VehicleEvent } from '../../shared/types';

export function HomePage() {
  const routes = useCollection<Route>('routes');
  const dests = useCollection<Destination>('destinations');
  const vehicles = useCollection<Vehicle>('vehicles');
  const events = useCollection<VehicleEvent>('vehicle-events');
  const [reports, setReports] = useState<Pick<SavedReport, 'id' | 'title' | 'createdAt'>[]>([]);
  useEffect(() => { api<typeof reports>('/api/reports').then(setReports); }, []);

  const quick = [
    { to: '/utak', icon: 'route', title: 'Utak és úticélok', text: `${routes.items.length} út, ${dests.items.length} úticél`, hint: 'Címkereséssel, automatikus távolsággal' },
    { to: '/torzsadatok', icon: 'car', title: 'Cég, jármű, sofőr', text: `${vehicles.items.length} jármű`, hint: 'A nyilvántartás fejléce' },
    { to: '/jarmunaplo', icon: 'wrench', title: 'Járműnapló', text: `${events.items.length} esemény`, hint: 'Szerviz és műszaki vizsga km-állással' },
  ];

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="eyebrow" style={{ color: '#9a9ca5' }}>Menet Mester</div>
          <h1>Útnyilvántartás,<br />ami kiállja a km-óra próbáját.</h1>
          <p>Add meg a kezdő és záró km-állást, jelöld meg a kötelező helyeket — a rendszer munkanapokra osztja az oda-vissza utakat, és kész a havi Excel.</p>
          <div className="row" style={{ marginTop: 24 }}>
            <Link to="/generalas" className="btn btn-sign"><Icon name="sparkles" />Nyilvántartás generálása</Link>
            <Link to="/utak" className="btn" style={{ background: 'transparent', color: '#fff', borderColor: '#2a3b63' }}><Icon name="plus" />Új út felvétele</Link>
          </div>
        </div>
        <img className="hero-logo" src="/logo.png" alt="Menet Mester logó" />
      </section>

      <div className="grid cols-3">
        {quick.map((q) => (
          <Link key={q.to} to={q.to} className="card quick">
            <Icon name={q.icon} />
            <h3>{q.title}</h3>
            <span className="mono small">{q.text}</span>
            <span className="muted small">{q.hint}</span>
          </Link>
        ))}
      </div>

      <div className="card card-pad">
        <div className="row" style={{ marginBottom: 12 }}>
          <h3 style={{ flex: 1 }}>Legutóbbi nyilvántartások</h3>
          <Link to="/nyilvantartasok" className="btn btn-sm btn-ghost">Összes<Icon name="arrowRight" /></Link>
        </div>
        {reports.length === 0 ? (
          <p className="muted small">Még nincs mentett nyilvántartás. Az első generálás kb. 2 perc.</p>
        ) : (
          reports.slice(0, 5).map((r) => (
            <Link key={r.id} to={`/nyilvantartasok/${r.id}`} className="item" style={{ textDecoration: 'none', padding: '10px 4px' }}>
              <Icon name="file" size={18} /><span style={{ flex: 1 }}>{r.title}</span>
              <span className="muted small mono">{r.createdAt.slice(0, 10)}</span>
            </Link>
          ))
        )}
      </div>
    </div>
  );
}
