import express, { type Request, type Response, type NextFunction } from 'express';
import { suggest, route as osrmRoute } from './geo.js';
import {
  companies, coordsOf, destinations, drivers, reports, resolveLegs, routes, templates, vehicleEvents, vehicles,
} from './repo.js';
import { generate } from './generator.js';
import { buildWorkbook } from './export.js';
import { monthLabel, lastDayOfMonth } from '../shared/calendar.js';
import { formatPlate } from '../shared/plate.js';
import type { GenerateRequest, RequiredStop } from '../shared/types.js';

import { authRequired, isAuthenticated, login, logout, requireAuth } from './auth.js';

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

export const app = express();
app.use(express.json({ limit: '5mb' }));

// ---- login (only enforced when APP_PASSWORD is set) ----
app.get('/api/session', (q, r) => r.json({ authRequired: authRequired(), authenticated: isAuthenticated(q) }));
app.post('/api/login', h(login));
app.post('/api/logout', logout);
app.use('/api', requireAuth);


function crud(name: string, repo: typeof companies | typeof vehicles | typeof drivers | typeof destinations | typeof routes | typeof vehicleEvents) {
  app.get(`/api/${name}`, h(async (_q, r) => r.json(await repo.list())));
  app.post(`/api/${name}`, h(async (q, r) => r.json(await repo.get(await repo.create(q.body)))));
  app.put(`/api/${name}/:id`, h(async (q, r) => {
    await repo.update(Number(q.params.id), q.body);
    r.json(await repo.get(Number(q.params.id)));
  }));
  app.delete(`/api/${name}/:id`, h(async (q, r) => {
    await repo.remove(Number(q.params.id));
    r.json({ ok: true });
  }));
}
crud('companies', companies);
crud('vehicles', vehicles);
crud('drivers', drivers);
crud('destinations', destinations);
crud('routes', routes);
crud('vehicle-events', vehicleEvents);

app.get('/api/templates', h(async (_q, r) => r.json(await templates.list())));
app.post('/api/templates', h(async (q, r) => r.json(await templates.get(await templates.create(q.body)))));
app.put('/api/templates/:id', h(async (q, r) => {
  await templates.update(Number(q.params.id), q.body);
  r.json(await templates.get(Number(q.params.id)));
}));
app.delete('/api/templates/:id', h(async (q, r) => {
  await templates.remove(Number(q.params.id));
  r.json({ ok: true });
}));

// ---- maps ----
app.get('/api/geo/suggest', h(async (q, r) => r.json(await suggest(String(q.query.q ?? '')))));

app.post('/api/geo/route', h(async (q, r) => {
  const { from, to } = q.body as { from: { lat: number; lon: number }; to: { lat: number; lon: number } };
  r.json(await osrmRoute(from, to));
}));

/** Route between two saved destinations (geocodes missing coordinates on the fly). */
app.get('/api/geo/route-between', h(async (q, r) => {
  const a = await destinations.get(Number(q.query.from));
  const b = await destinations.get(Number(q.query.to));
  if (!a || !b) return r.status(404).json({ error: 'Ismeretlen úticél' });
  r.json(await osrmRoute(await coordsOf(a), await coordsOf(b)));
}));

// ---- integrations: where must the vehicle have been? ----
// Every provider returns the stops it knows for a vehicle in a period. The vehicle journal
// (service / inspection visits with odometer readings) is the built-in source; external
// sources (e.g. a manufacturer API) can be added to this list.
const providers: { id: string; name: string; fetch: (vehicleId: number, from: string, to: string) => Promise<RequiredStop[]> }[] = [
  {
    id: 'journal',
    name: 'Járműnapló (szerviz, műszaki vizsga)',
    fetch: async (vehicleId, from, to) => {
      const typeLabel = { service: 'Szerviz', inspection: 'Műszaki vizsga', other: 'Esemény' } as const;
      return (await vehicleEvents.list())
        .filter((e) => e.vehicleId === vehicleId && e.date >= from && e.date <= to)
        .map((e) => ({
          date: e.date,
          destinationId: e.destinationId,
          odometer: e.odometer,
          label: `${typeLabel[e.type] ?? 'Esemény'}${e.note ? ': ' + e.note : ''}`,
          source: e.source,
        }));
    },
  },
];

app.get('/api/integrations/stops', h(async (q, r) => {
  const vehicleId = Number(q.query.vehicleId);
  const from = `${q.query.fromMonth}-01`;
  const to = lastDayOfMonth(String(q.query.toMonth));
  const results = await Promise.all(
    providers.map(async (p) => {
      try {
        return { provider: p.name, ok: true, stops: await p.fetch(vehicleId, from, to) };
      } catch (e) {
        return { provider: p.name, ok: false, error: (e as Error).message, stops: [] };
      }
    }),
  );
  r.json(results);
}));

// ---- generation ----
app.post('/api/generate', h(async (q, r) => {
  const body = q.body as GenerateRequest;
  if (body.endOdometer <= body.startOdometer)
    return r.status(400).json({ error: 'A záró km-állásnak nagyobbnak kell lennie a kezdőnél.' });
  const ctx = await resolveLegs(body);
  r.json(generate(body, ctx));
}));

app.get('/api/reports', h(async (_q, r) => r.json(await reports.list())));
app.get('/api/reports/:id', h(async (q, r) => {
  const rep = await reports.get(Number(q.params.id));
  return rep ? r.json(rep) : r.status(404).json({ error: 'Nincs ilyen nyilvántartás' });
}));
app.post('/api/reports', h(async (q, r) => r.json({ id: await reports.create(q.body) })));
app.delete('/api/reports/:id', h(async (q, r) => {
  await reports.remove(Number(q.params.id));
  r.json({ ok: true });
}));

app.post('/api/export', h(async (q, r) => {
  const { request, result, fuelPrices } = q.body;
  const [company, vehicle, driver] = await Promise.all([
    companies.get(request.companyId), vehicles.get(request.vehicleId), drivers.get(request.driverId),
  ]);
  if (!company || !vehicle || !driver) return r.status(400).json({ error: 'Hiányzó cég, jármű vagy sofőr' });
  const buf = await buildWorkbook({ company, vehicle, driver, result, fuelPrices });
  const months = result.months;
  const name = `Utnyilvantartas_${formatPlate(vehicle.plate)}_${months[0].month}${months.length > 1 ? '_' + months[months.length - 1].month : ''}.xlsx`;
  r.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  r.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  r.setHeader('X-Title', encodeURIComponent(`${formatPlate(vehicle.plate)} – ${monthLabel(months[0].month)}`));
  r.send(Buffer.from(buf as ArrayBuffer));
}));

// ---- errors ----
app.use('/api', (err: Error, _q: Request, r: Response, _n: NextFunction) => {
  console.error(err);
  r.status(500).json({ error: err.message || 'Váratlan hiba' });
});
