import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import './db.js';
import { suggest, route as osrmRoute } from './geo.js';
import {
  companies, coordsOf, destinations, drivers, reports, resolveLegs, routes, templates, vehicleEvents, vehicles,
} from './repo.js';
import { generate } from './generator.js';
import { buildWorkbook } from './export.js';
import { monthLabel, lastDayOfMonth } from '../shared/calendar.js';
import type { GenerateRequest, RequiredStop } from '../shared/types.js';

const app = express();
app.use(express.json({ limit: '5mb' }));

type Handler = (req: Request, res: Response) => unknown;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  Promise.resolve(fn(req, res)).catch(next);

function crud(name: string, repo: typeof companies | typeof vehicles | typeof drivers | typeof destinations | typeof routes | typeof vehicleEvents) {
  app.get(`/api/${name}`, h((_q, r) => r.json(repo.list())));
  app.post(`/api/${name}`, h((q, r) => r.json(repo.get(repo.create(q.body)))));
  app.put(`/api/${name}/:id`, h((q, r) => {
    repo.update(Number(q.params.id), q.body);
    r.json(repo.get(Number(q.params.id)));
  }));
  app.delete(`/api/${name}/:id`, h((q, r) => {
    repo.remove(Number(q.params.id));
    r.json({ ok: true });
  }));
}
crud('companies', companies);
crud('vehicles', vehicles);
crud('drivers', drivers);
crud('destinations', destinations);
crud('routes', routes);
crud('vehicle-events', vehicleEvents);

app.get('/api/templates', h((_q, r) => r.json(templates.list())));
app.post('/api/templates', h((q, r) => r.json(templates.get(templates.create(q.body)))));
app.put('/api/templates/:id', h((q, r) => {
  templates.update(Number(q.params.id), q.body);
  r.json(templates.get(Number(q.params.id)));
}));
app.delete('/api/templates/:id', h((q, r) => {
  templates.remove(Number(q.params.id));
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
  const a = destinations.get(Number(q.query.from));
  const b = destinations.get(Number(q.query.to));
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
      return vehicleEvents
        .list()
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

app.get('/api/reports', h((_q, r) => r.json(reports.list())));
app.get('/api/reports/:id', h((q, r) => {
  const rep = reports.get(Number(q.params.id));
  return rep ? r.json(rep) : r.status(404).json({ error: 'Nincs ilyen nyilvántartás' });
}));
app.post('/api/reports', h((q, r) => r.json({ id: reports.create(q.body) })));
app.delete('/api/reports/:id', h((q, r) => {
  reports.remove(Number(q.params.id));
  r.json({ ok: true });
}));

app.post('/api/export', h(async (q, r) => {
  const { request, result, fuelPrices } = q.body;
  const company = companies.get(request.companyId);
  const vehicle = vehicles.get(request.vehicleId);
  const driver = drivers.get(request.driverId);
  if (!company || !vehicle || !driver) return r.status(400).json({ error: 'Hiányzó cég, jármű vagy sofőr' });
  const buf = await buildWorkbook({ company, vehicle, driver, result, fuelPrices });
  const months = result.months;
  const name = `Utnyilvantartas_${vehicle.plate}_${months[0].month}${months.length > 1 ? '_' + months[months.length - 1].month : ''}.xlsx`;
  r.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  r.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  r.setHeader('X-Title', encodeURIComponent(`${vehicle.plate} – ${monthLabel(months[0].month)}`));
  r.send(Buffer.from(buf as ArrayBuffer));
}));

// ---- errors & static ----
app.use('/api', (err: Error, _q: Request, r: Response, _n: NextFunction) => {
  console.error(err);
  r.status(500).json({ error: err.message || 'Váratlan hiba' });
});

const dist = path.resolve('dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_q, r) => r.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.API_PORT ?? (process.env.NODE_ENV === "production" ? process.env.PORT : undefined) ?? 3001);
app.listen(port, () => console.log(`Menet Mester API: http://localhost:${port}`));
