import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, download, useCollection } from '../api';
import { Icon } from '../components/Icon';
import { ResultView } from '../components/ResultView';
import { Empty, PageHead, useConfirm, useToast } from '../components/ui';
import type { SavedReport, Vehicle } from '../../shared/types';

type ReportItem = Pick<SavedReport, 'id' | 'title' | 'createdAt'>;

export function ReportsPage() {
  const [items, setItems] = useState<ReportItem[] | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const load = () => api<ReportItem[]>('/api/reports').then(setItems);
  useEffect(() => { load(); }, []);

  return (
    <>
      <PageHead eyebrow="Archívum" title="Mentett nyilvántartások" text="A korábban generált és elmentett nyilvántartások. Bármikor újra letöltheted őket Excelben."
        actions={<Link className="btn btn-primary" to="/generalas"><Icon name="sparkles" />Új generálás</Link>} />
      <div className="card">
        {items && items.length === 0 ? (
          <Empty icon="archive" title="Még nincs mentett nyilvántartás" text="Generálj egyet, és a végén a Mentés gombbal ide kerül."
            action={<Link className="btn btn-primary" to="/generalas"><Icon name="sparkles" />Generálás indítása</Link>} />
        ) : (
          items?.map((r) => (
            <Link key={r.id} to={`/nyilvantartasok/${r.id}`} className="item" style={{ textDecoration: 'none' }}>
              <div className="dot"><Icon name="file" /></div>
              <div style={{ flex: 1 }}><b>{r.title}</b><div className="muted small">Mentve: {r.createdAt.replace('T', ' ').slice(0, 16)}</div></div>
              <div className="actions">
                <button className="btn btn-ghost btn-danger icon-btn" aria-label="Törlés" onClick={async (e) => {
                  e.preventDefault();
                  if (!(await confirm('Nyilvántartás törlése', `Biztosan törlöd: ${r.title}?`))) return;
                  await api(`/api/reports/${r.id}`, { method: 'DELETE' }); toast('Törölve'); load();
                }}><Icon name="trash" /></button>
              </div>
              <Icon name="arrowRight" size={18} />
            </Link>
          ))
        )}
      </div>
    </>
  );
}

export function ReportPage() {
  const { id } = useParams();
  const [rep, setRep] = useState<SavedReport | null>(null);
  const [err, setErr] = useState('');
  const vehicles = useCollection<Vehicle>('vehicles');
  const toast = useToast();
  const navigate = useNavigate();
  useEffect(() => { api<SavedReport>(`/api/reports/${id}`).then(setRep).catch((e) => setErr(e.message)); }, [id]);

  if (err) return <Empty icon="alert" title="Nem található" text={err} action={<button className="btn" onClick={() => navigate('/nyilvantartasok')}>Vissza</button>} />;
  if (!rep) return <span className="spin" />;

  return (
    <>
      <PageHead eyebrow="Mentett nyilvántartás" title={rep.title}
        actions={<>
          <Link className="btn" to="/nyilvantartasok"><Icon name="arrowLeft" />Lista</Link>
          <button className="btn btn-sign" onClick={() => download('/api/export', rep, 'utnyilvantartas.xlsx').catch((e) => toast(e.message, true))}>
            <Icon name="download" />Excel letöltése
          </button>
        </>} />
      <ResultView result={rep.result} vehicle={vehicles.items.find((v) => v.id === rep.request.vehicleId)} fuelPrices={rep.fuelPrices} />
    </>
  );
}
