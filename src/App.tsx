import { NavLink, Route, Routes } from 'react-router-dom';
import { Icon } from './components/Icon';
import { useAuth } from './components/AuthGate';
import { HomePage } from './pages/Home';
import { MasterDataPage } from './pages/MasterData';
import { PlacesPage } from './pages/Places';
import { JournalPage } from './pages/Journal';
import { WizardPage } from './pages/Wizard';
import { ReportsPage, ReportPage } from './pages/Reports';
import { TemplatesPage } from './pages/Templates';

const nav = [
  { to: '/', icon: 'home', label: 'Áttekintés', end: true },
  { to: '/generalas', icon: 'sparkles', label: 'Nyilvántartás generálása' },
  { to: '/nyilvantartasok', icon: 'archive', label: 'Mentett nyilvántartások' },
];
const data = [
  { to: '/utak', icon: 'route', label: 'Utak és úticélok' },
  { to: '/sablonok', icon: 'calendar', label: 'Utazás-sablonok' },
  { to: '/torzsadatok', icon: 'building', label: 'Cég, jármű, sofőr' },
  { to: '/jarmunaplo', icon: 'wrench', label: 'Járműnapló' },
];

export function App() {
  const { authRequired, logout } = useAuth();
  return (
    <div className="shell">
      <aside className="side">
        <NavLink to="/" className="brand" aria-label="Menet Mester – kezdőlap">
          <img src="/logo.png" alt="Menet Mester" />
          <span>útnyilvántartás</span>
        </NavLink>
        <nav className="nav">
          <div className="nav-label">Munka</div>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
          <div className="nav-label">Adatok</div>
          {data.map((n) => (
            <NavLink key={n.to} to={n.to}><Icon name={n.icon} />{n.label}</NavLink>
          ))}
        </nav>
        <div className="side-foot">
          {authRequired && <button className="btn btn-sm btn-ghost logout" onClick={logout}><Icon name="arrowLeft" />Kijelentkezés</button>}
          <div>Térkép: © OpenStreetMap közreműködők</div>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/generalas" element={<WizardPage />} />
          <Route path="/nyilvantartasok" element={<ReportsPage />} />
          <Route path="/nyilvantartasok/:id" element={<ReportPage />} />
          <Route path="/utak" element={<PlacesPage />} />
          <Route path="/sablonok" element={<TemplatesPage />} />
          <Route path="/torzsadatok" element={<MasterDataPage />} />
          <Route path="/jarmunaplo" element={<JournalPage />} />
        </Routes>
      </main>
    </div>
  );
}
