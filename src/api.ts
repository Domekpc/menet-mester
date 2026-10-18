import { useCallback, useEffect, useState } from 'react';

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.auth) window.dispatchEvent(new Event(AUTH_EVENT));
    throw new Error(data.error ?? `Hiba történt (${res.status})`);
  }
  return res.json();
}

/** Fired when the server asks for the password (session expired or never logged in). */
export const AUTH_EVENT = 'menet-mester:auth-required';

/** List + CRUD helpers for one REST collection. */
export function useCollection<T extends { id: number }>(name: string) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setItems(await api<T[]>(`/api/${name}`));
    setLoading(false);
  }, [name]);
  useEffect(() => { reload(); }, [reload]);

  return {
    items,
    loading,
    reload,
    create: async (data: Omit<T, 'id'>) => {
      const created = await api<T>(`/api/${name}`, { method: 'POST', json: data });
      await reload();
      return created;
    },
    update: async (id: number, data: Omit<T, 'id'>) => {
      const updated = await api<T>(`/api/${name}/${id}`, { method: 'PUT', json: data });
      await reload();
      return updated;
    },
    remove: async (id: number) => {
      await api(`/api/${name}/${id}`, { method: 'DELETE' });
      await reload();
    },
  };
}

export async function download(url: string, body: unknown, fallbackName: string) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) window.dispatchEvent(new Event(AUTH_EVENT));
  if (!res.ok) throw new Error('Az exportálás nem sikerült');
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/.exec(cd);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = m ? decodeURIComponent(m[1]) : fallbackName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const fmtKm = (n: number) => n.toLocaleString('hu-HU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
export const fmtInt = (n: number) => Math.round(n).toLocaleString('hu-HU');
export const fmtDate = (s: string) => s.replaceAll('-', '. ') + '.';
