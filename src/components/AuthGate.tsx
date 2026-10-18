import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, AUTH_EVENT } from '../api';
import { Icon } from './Icon';

interface Session { authRequired: boolean; authenticated: boolean }
const AuthCtx = createContext<{ authRequired: boolean; logout: () => void }>({ authRequired: false, logout: () => {} });
export const useAuth = () => useContext(AuthCtx);

/** Shows the login screen when the server is protected with a password (APP_PASSWORD). */
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Session>('/api/session').then(setSession).catch(() => setSession({ authRequired: false, authenticated: true }));
    const onAuth = () => setSession({ authRequired: true, authenticated: false });
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  const logout = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    setSession({ authRequired: true, authenticated: false });
  };

  if (!session) return null;
  if (session.authRequired && !session.authenticated) {
    return (
      <div className="login-page">
        <form className="login-card card" onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          const password = new FormData(e.currentTarget).get('password');
          try {
            await api('/api/login', { method: 'POST', json: { password } });
            setSession({ authRequired: true, authenticated: true });
          } catch (err) {
            setError((err as Error).message);
          }
        }}>
          <img src="/logo.png" alt="Menet Mester" />
          <h2>Belépés</h2>
          <p className="muted small">Az útnyilvántartás jelszóval védett.</p>
          <input className="input" type="password" name="password" autoComplete="current-password" placeholder="Jelszó" autoFocus />
          {error && <span className="error-text">{error}</span>}
          <button className="btn btn-sign" type="submit"><Icon name="arrowRight" />Belépés</button>
        </form>
      </div>
    );
  }
  return <AuthCtx.Provider value={{ authRequired: session.authRequired, logout }}>{children}</AuthCtx.Provider>;
}
