import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { app } from './app.js';
import { getDb } from './db.js';

// Local / self-hosted server. On Vercel the same app runs from api/index.ts.
const dist = path.resolve('dist');
if (process.env.NODE_ENV === 'production' && fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_q, r) => r.sendFile(path.join(dist, 'index.html')));
}

const port = Number(process.env.API_PORT ?? (process.env.NODE_ENV === 'production' ? process.env.PORT : undefined) ?? 3001);
getDb()
  .then((db) => app.listen(port, () => console.log(`Menet Mester API: http://localhost:${port} (${db.dialect === 'pg' ? 'Postgres' : 'SQLite'})`)))
  .catch((e) => { console.error('Az adatbázis nem érhető el:', e); process.exit(1); });
