import { db } from './db.js';
import type { SQLInputValue } from 'node:sqlite';
import { geocode, route as osrmRoute } from './geo.js';
import type {
  Company, Destination, Driver, GenerateRequest, Route, SavedReport, Vehicle, VehicleEvent,
} from '../shared/types.js';

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
export const destinations = entity<Destination>('destinations', { name: 'name', address: 'address', lat: 'lat', lon: 'lon' });
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

/**
 * Distance table for every leg a generation may need. Saved routes win (in either direction),
 * the rest is calculated with the routing service.
 */
export async function resolveLegs(req: GenerateRequest) {
  const allRoutes = routes.list();
  const destMap = new Map(destinations.list().map((d) => [d.id, d]));
  const known = new Map<string, number>();
  const key = (a: number, b: number) => `${a}-${b}`;
  for (const r of allRoutes) {
    known.set(key(r.fromId, r.toId), r.distanceKm);
    if (!known.has(key(r.toId, r.fromId))) known.set(key(r.toId, r.fromId), r.distanceKm);
  }

  const pairs = new Set<string>();
  const base = req.baseDestinationId;
  const need = (a: number, b: number) => { if (a !== b) { pairs.add(key(a, b)); pairs.add(key(b, a)); } };
  for (const rule of req.routes) {
    const r = allRoutes.find((x) => x.id === rule.routeId);
    if (!r) continue;
    need(base, r.fromId); need(r.fromId, r.toId); need(r.toId, base);
  }
  const byDate = new Map<string, number[]>();
  for (const s of req.stops) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s.destinationId]);
  for (const ids of byDate.values()) {
    const seq = [base, ...ids, base];
    seq.slice(1).forEach((id, i) => need(seq[i], id));
  }

  for (const p of pairs) {
    if (known.has(p)) continue;
    const [a, b] = p.split('-').map(Number);
    if (known.has(key(b, a))) { known.set(p, known.get(key(b, a))!); continue; }
    const da = destMap.get(a), dbb = destMap.get(b);
    if (!da || !dbb) throw new Error('Hiányzó úticél az adatok között');
    const calc = await osrmRoute(await coordsOf(da), await coordsOf(dbb));
    known.set(p, calc.distanceKm);
  }

  return {
    destinations: destMap,
    routes: new Map(allRoutes.map((r) => [r.id, r])),
    legKm: (a: number, b: number) => {
      const v = known.get(key(a, b));
      if (v == null) throw new Error(`Ismeretlen távolság: ${destMap.get(a)?.name} → ${destMap.get(b)?.name}`);
      return v;
    },
  };
}
