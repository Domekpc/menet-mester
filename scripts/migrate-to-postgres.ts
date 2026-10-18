/**
 * Copies the local SQLite data (data/menet-mester.db) into the Postgres database given by
 * DATABASE_URL, keeping every id. The target tables are emptied first, so run it once, right
 * after the first deployment:
 *
 *   DATABASE_URL="postgres://…" npm run migrate:pg -- --yes
 */
import path from 'node:path';
import { pgDb, prepare, sqliteDb } from '../server/db.js';

// parents before children, so foreign keys are always satisfied
const TABLES = ['destinations', 'companies', 'vehicles', 'drivers', 'routes', 'vehicle_events', 'trip_templates', 'reports', 'geo_cache'];

async function main() {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) throw new Error('Add meg a DATABASE_URL-t (a Neon kapcsolódási címét).');
  const source = await prepare(await sqliteDb(process.env.DB_FILE ?? path.resolve('data', 'menet-mester.db')));
  const target = await pgDb(url);
  await prepare(target);

  const counts: Record<string, number> = {};
  for (const t of TABLES) counts[t] = (await source.all(`SELECT * FROM ${t}`)).length;
  console.log('Helyi adatok:', counts);
  if (!process.argv.includes('--yes')) {
    console.log('\nA céladatbázis táblái törlődnek és felülíródnak. Futtasd újra --yes kapcsolóval, ha ez rendben van.');
    await Promise.all([source.close(), target.close()]);
    return;
  }

  await target.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
  for (const t of TABLES) {
    const rows = await source.all(`SELECT * FROM ${t}`);
    for (const row of rows) {
      const cols = Object.keys(row);
      await target.run(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
    }
    // continue the id sequence after the copied rows
    if (t !== 'geo_cache') await target.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
    console.log(`${t}: ${rows.length} sor átmásolva`);
  }
  await Promise.all([source.close(), target.close()]);
  console.log('\nKész.');
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
