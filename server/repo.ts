import { db } from './db.js';
import type { SQLInputValue } from 'node:sqlite';
import { distanceMatrix, geocode } from './geo.js';
import type {
  Company, Destination, Driver, GenerateRequest, Route, SavedReport, TripTemplate, Vehicle, VehicleEvent,
} from '../shared/types.js';
import { BASE } from '../shared/types.js';

// Column mapping between snake_case tables and camelCase API objects.
type Mapping = Record<string, string>;

function entity<T extends { id: number }>(table: string, map: Mapping) {
  const cols = Object.keys(map);
  const toRow = (o: Partial<T>) => cols.map((c) => ((o as Record<string, unknown>)[c] ?? null) as SQLInputValue);
  const fromRow = (r: Record<string, unknown>) =>
    Object.fromEntries([['id', r.id], ...cols.map((c) => [c, r[map[c]]])]) as T;
  const colList = cols.map((c) => map[c]).join(', ');
  return {
    list: () => (db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Record<string, unknown>[]).map(fromRow),
    get: (id: number) => {
      const r = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
      return r ? fromRow(r) : undefined;
    },
    create: (o: Partial<T>) => {
      const id = db
        .prepare(`INSERT INTO ${table} (${colList}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...toRow(o)).lastInsertRowid;
      return Number(id);
    },
    update: (id: number, o: Partial<T>) =>
      db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${map[c]} = ?`).join(', ')} WHERE id = ?`).run(...toRow(o), id),
    remove: (id: number) => db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id),
  };
}

export const companies = entity<Company>('companies', {
  name: 'name', address: 'address', taxNumber: 'tax_number', homeDestinationId: 'home_destination_id',
});
export const vehicles = entity<Vehicle>('vehicles', {
  plate: 'plate', category: 'category', model: 'model', fuel: 'fuel', consumption: 'consumption',
});
export const drivers = entity<Driver>('drivers', { name: 'name', taxNumber: 'tax_number', address: 'address' });
export const destinations = entity<Destination>('destinations', {
  name: 'name', address: 'address', lat: 'lat', lon: 'lon', maxPerDay: 'max_per_day', minGapDays: 'min_gap_days',
});
export const routes = entity<Route>('routes', { name: 'name', fromId: 'from_id', toId: 'to_id', distanceKm: 'distance_km' });
export const vehicleEvents = entity<VehicleEvent>('vehicle_events', {
  vehicleId: 'vehicle_id', date: 'date', type: 'type', destinationId: 'destination_id',
  odometer: 'odometer', note: 'note', source: 'source',
});

export const reports = {
  list: () =>
    (db.prepare('SELECT id, title, created_at FROM reports ORDER BY id DESC').all() as {
      id: number; title: string; created_at: string;
    }[]).map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at })),
  get: (id: number): SavedReport | undefined => {
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!r) return undefined;
    return {
      id: Number(r.id), title: r.title, createdAt: r.created_at,
      request: JSON.parse(r.request), result: JSON.parse(r.result), fuelPrices: JSON.parse(r.fuel_prices),
    };
  },
  create: (r: Omit<SavedReport, 'id' | 'createdAt'>) =>
    Number(
      db.prepare('INSERT INTO reports (title, request, result, fuel_prices) VALUES (?, ?, ?, ?)')
        .run(r.title, JSON.stringify(r.request), JSON.stringify(r.result), JSON.stringify(r.fuelPrices)).lastInsertRowid,
    ),
  remove: (id: number) => db.prepare('DELETE FROM reports WHERE id = ?').run(id),
};

/** Coordinates of a destination, geocoding and storing them on first use. */
export async function coordsOf(d: Destination) {
  if (d.lat != null && d.lon != null) return { lat: d.lat, lon: d.lon };
  const c = await geocode(d.address);
  if (!c) throw new Error(`Nem sikerült a címet térképen megtalálni: ${d.name} (${d.address})`);
  db.prepare('UPDATE destinations SET lat = ?, lon = ? WHERE id = ?').run(c.lat, c.lon, d.id);
  d.lat = c.lat;
  d.lon = c.lon;
  return c;
}

export const templates = (() => {
  const fromRow = (r: Record<string, unknown>): TripTemplate => ({
    id: Number(r.id),
    name: String(r.name),
    startWeekdays: JSON.parse(String(r.start_weekdays)),
    days: JSON.parse(String(r.days)),
    minPerMonth: r.min_per_month == null ? null : Number(r.min_per_month),
    maxPerMonth: r.max_per_month == null ? null : Number(r.max_per_month),
    onlyDates: JSON.parse(String(r.only_dates)),
    note: String(r.note ?? ''),
  });
  const values = (t: Partial<TripTemplate>) => [
    t.name ?? '', JSON.stringify(t.startWeekdays ?? []), JSON.stringify(t.days ?? []),
    t.minPerMonth ?? null, t.maxPerMonth ?? null, JSON.stringify(t.onlyDates ?? []), t.note ?? '',
  ];
  const cols = 'name, start_weekdays, days, min_per_month, max_per_month, only_dates, note';
  return {
    list: () => (db.prepare('SELECT * FROM trip_templates ORDER BY id').all() as Record<string, unknown>[]).map(fromRow),
    get: (id: number) => {
      const r = db.prepare('SELECT * FROM trip_templates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return r ? fromRow(r) : undefined;
    },
    create: (t: Partial<TripTemplate>) =>
      Number(db.prepare(`INSERT INTO trip_templates (${cols}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...values(t)).lastInsertRowid),
    update: (id: number, t: Partial<TripTemplate>) =>
      db.prepare(`UPDATE trip_templates SET ${cols.split(', ').map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values(t), id),
    remove: (id: number) => db.prepare('DELETE FROM trip_templates WHERE id = ?').run(id),
  };
})();

/**
 * Distances between every destination a generation may touch. Saved routes win (in either
 * direction), the rest comes from one routing-service distance matrix.
 */
export async function resolveLegs(req: GenerateRequest) {
  const allRoutes = routes.list();
  const allTemplates = templates.list();
  const destMap = new Map(destinations.list().map((d) => [d.id, d]));
  const base = req.baseDestinationId;
  const real = (id: number) => (id === BASE ? base : id);

  const ids = new Set<number>([base]);
  for (const rule of req.routes) {
    const r = allRoutes.find((x) => x.id === rule.routeId);
    if (r) { ids.add(r.fromId); ids.add(r.toId); }
  }
  const usedTemplates = new Set([
    ...(req.templates ?? []).map((t) => t.templateId),
    ...(req.plan ?? []).flatMap((e) => (e.type === 'template' ? [e.templateId] : [])),
  ]);
  for (const t of allTemplates) if (usedTemplates.has(t.id)) t.days.forEach((d) => d.stops.forEach((id) => ids.add(real(id))));
  for (const e of req.plan ?? []) if (e.type === 'visit') e.destinationIds.forEach((id) => ids.add(id));
  for (const s of req.stops) ids.add(s.destinationId);
  for (const l of req.locked ?? []) l.stops.forEach((id) => ids.add(id));

  const list = [...ids].filter((id) => destMap.has(id));
  const missing = [...ids].filter((id) => !destMap.has(id));
  if (missing.length) throw new Error('Hiányzó úticél az adatok között — lehet, hogy közben törölték.');

  const known = new Map<string, number>();
  const key = (a: number, b: number) => `${a}-${b}`;
  const points = await Promise.all(list.map((id) => coordsOf(destMap.get(id)!)));
  const matrix = await distanceMatrix(points);
  list.forEach((a, i) => list.forEach((b, j) => { if (!Number.isNaN(matrix[i][j])) known.set(key(a, b), matrix[i][j]); }));
  for (const r of allRoutes) {
    known.set(key(r.fromId, r.toId), r.distanceKm);
    known.set(key(r.toId, r.fromId), r.distanceKm);
  }

  return {
    destinations: destMap,
    routes: new Map(allRoutes.map((r) => [r.id, r])),
    templates: new Map(allTemplates.map((t) => [t.id, t])),
    legKm: (a: number, b: number) => {
      if (a === b) return 0;
      const v = known.get(key(a, b));
      if (v == null) throw new Error(`Ismeretlen távolság: ${destMap.get(a)?.name} → ${destMap.get(b)?.name}`);
      return v;
    },
  };
}
