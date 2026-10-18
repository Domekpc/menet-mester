import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { formatPlate } from '../../shared/plate';

// ---------- toast ----------
interface Toast { id: number; text: string; error?: boolean }
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error?: boolean) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 6000 : 3200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- modal ----------
export function Modal({
  title, subtitle, onClose, children, footer, wide,
}: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {subtitle && <p className="muted small" style={{ marginTop: 4 }}>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost icon-btn" onClick={onClose} aria-label="Bezárás"><Icon name="x" /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- confirm ----------
type ConfirmReq = { title: string; text: string; action: string; resolve: (ok: boolean) => void };
const ConfirmCtx = createContext<(title: string, text: string, action?: string) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const ask = useCallback(
    (title: string, text: string, action = 'Törlés') => new Promise<boolean>((resolve) => setReq({ title, text, action, resolve })),
    [],
  );
  const close = (ok: boolean) => { req?.resolve(ok); setReq(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal title={req.title} onClose={() => close(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => close(false)}>Mégse</button>
            <button className="btn btn-primary" style={{ background: 'var(--stop)', borderColor: 'var(--stop)' }} onClick={() => close(true)} autoFocus>{req.action}</button>
          </>}>
          <p>{req.text}</p>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------- small bits ----------
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <small className="error-text">{error}</small> : hint && <small>{hint}</small>}
    </label>
  );
}

export function Empty({ icon, title, text, action }: { icon: string; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      <p className="muted" style={{ marginBottom: action ? 16 : 0 }}>{text}</p>
      {action}
    </div>
  );
}

export function Plate({ value }: { value: string }) {
  return <span className="plate"><span>{formatPlate(value)}</span></span>;
}

export function PageHead({ eyebrow, title, text, actions }: { eyebrow: string; title: string; text?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {text && <p>{text}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Odometer({ value, onChange, placeholder, autoFocus }: {
  value: number | ''; onChange: (v: number | '') => void; placeholder?: string; autoFocus?: boolean;
}) {
  return (
    <div className="odo">
      <input inputMode="numeric" value={value === '' ? '' : String(value)} placeholder={placeholder ?? '000000'} autoFocus={autoFocus}
        onChange={(e) => {
          const digits = e.target.value.replace(/\D/g, '').slice(0, 7);
          onChange(digits === '' ? '' : Number(digits));
        }} />
      <em>km</em>
    </div>
  );
}
