import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE ?? path.resolve('data', 'menet-mester.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS destinations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat REAL,
  lon REAL
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  tax_number TEXT NOT NULL,
  home_destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  fuel TEXT NOT NULL,
  consumption REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tax_number TEXT NOT NULL,
  address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  from_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  distance_km REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicle_events (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  odometer INTEGER,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Kézi rögzítés'
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  request TEXT NOT NULL,
  result TEXT NOT NULL,
  fuel_prices TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start_weekdays TEXT NOT NULL DEFAULT '[]',
  days TEXT NOT NULL DEFAULT '[]',
  min_per_month INTEGER,
  max_per_month INTEGER,
  only_dates TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS geo_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// Columns added after the first release
function addColumn(table: string, column: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('destinations', 'max_per_day', 'INTEGER');
addColumn('destinations', 'min_gap_days', 'INTEGER');

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number };
  if (count.n > 0) return;

  const insDest = db.prepare('INSERT INTO destinations (name, address, lat, lon) VALUES (?, ?, ?, ?)');
  const insRoute = db.prepare('INSERT INTO routes (name, from_id, to_id, distance_km) VALUES (?, ?, ?, ?)');

  transaction(() => {
    const home = insDest.run('ERNIVILL Kft', '7305 Komló, Iskola út 41.', 46.2127544, 18.2418763).lastInsertRowid;
    db.prepare('INSERT INTO companies (name, address, tax_number, home_destination_id) VALUES (?, ?, ?, ?)')
      .run('Ernivill Kft.', '7305 Komló, Iskola út 41.', '23585182-2-02', home);
    db.prepare('INSERT INTO vehicles (plate, category, model, fuel, consumption) VALUES (?, ?, ?, ?, ?)')
      .run('AELU-689', 'Személygépkocsi', 'Mercedes GLC', 'Benzin', 9.5);
    db.prepare('INSERT INTO drivers (name, tax_number, address) VALUES (?, ?, ?)')
      .run('Eckhardt Tímea', '8398242566', '7305 Komló, Iskola út 41.');

    // Partners and distances taken from the 2024 sample records.
    const partners: [string, string, number | null, number | null, number][] = [
      ['Pappas Auto', '7630 Pécs, Koksz utca 125.', 46.0844904, 18.2762294, 25.9],
      ['Magyar Posta Zrt.', '7300 Komló, Városház tér 2.', 46.1906513, 18.2610458, 3.2],
      ['OTP Bank', '7300 Komló, Kossuth Lajos utca 95.', 46.1902207, 18.2653289, 3.4],
      ['Könyvelő iroda', '7300 Komló, Városház tér 13.', 46.1911, 18.2627, 3.2],
      ['Metro', '7634 Pécs, Makay István út 6.', null, null, 27.6],
    ];
    for (const [name, address, lat, lon, km] of partners) {
      const id = insDest.run(name, address, lat, lon).lastInsertRowid;
      insRoute.run(`Telephely → ${name}`, home, id, km);
    }
  });
}

seed();
