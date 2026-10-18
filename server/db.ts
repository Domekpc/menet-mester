import fs from 'node:fs';
import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';

/**
 * Small async database layer with two drivers: Postgres when DATABASE_URL is set (Vercel + Neon),
 * otherwise a local SQLite file. SQL is written once with `?` placeholders.
 */
export interface Db {
  dialect: 'sqlite' | 'pg';
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** INSERT … returning the new row id */
  insert(sql: string, params?: unknown[]): Promise<number>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** `?` → `$1, $2, …` for Postgres */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export async function pgDb(connectionString: string): Promise<Db> {
  const pg = (await import('pg')).default;
  // NUMERIC / BIGINT come back as strings by default; our ids and counts fit in a JS number
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new pg.Pool({ connectionString, max: 3, ssl: local ? undefined : true });
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(numbered(sql), params)).rows;
  return {
    dialect: 'pg',
    all: async (sql, params) => (await q(sql, params)) as never,
    get: async (sql, params) => (await q(sql, params))[0] as never,
    run: async (sql, params) => { await q(sql, params); },
    insert: async (sql, params) => Number((await q(`${sql} RETURNING id`, params))[0].id),
    exec: async (sql) => { await pool.query(sql); },
    close: () => pool.end(),
  };
}

export async function sqliteDb(file: string): Promise<Db> {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const args = (params: unknown[] = []) => params.map((p) => (p === undefined ? null : p)) as SQLInputValue[];
  return {
    dialect: 'sqlite',
    all: async (sql, params) => db.prepare(sql).all(...args(params)) as never,
    get: async (sql, params) => db.prepare(sql).get(...args(params)) as never,
    run: async (sql, params) => { db.prepare(sql).run(...args(params)); },
    insert: async (sql, params) => Number(db.prepare(sql).run(...args(params)).lastInsertRowid),
    exec: async (sql) => { db.exec(sql); },
    close: async () => db.close(),
  };
}

function schema(dialect: Db['dialect']) {
  const id = dialect === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY';
  const real = dialect === 'pg' ? 'DOUBLE PRECISION' : 'REAL';
  return `
CREATE TABLE IF NOT EXISTS destinations (
  id ${id},
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  lat ${real},
  lon ${real},
  max_per_day INTEGER,
  min_gap_days INTEGER
);
CREATE TABLE IF NOT EXISTS companies (
  id ${id},
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  tax_number TEXT NOT NULL,
  home_destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS vehicles (
  id ${id},
  plate TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  fuel TEXT NOT NULL,
  consumption ${real} NOT NULL
);
CREATE TABLE IF NOT EXISTS drivers (
  id ${id},
  name TEXT NOT NULL,
  tax_number TEXT NOT NULL,
  address TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routes (
  id ${id},
  name TEXT NOT NULL,
  from_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  distance_km ${real} NOT NULL
);
CREATE TABLE IF NOT EXISTS vehicle_events (
  id ${id},
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  destination_id INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  odometer INTEGER,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'Kézi rögzítés'
);
CREATE TABLE IF NOT EXISTS reports (
  id ${id},
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request TEXT NOT NULL,
  result TEXT NOT NULL,
  fuel_prices TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_templates (
  id ${id},
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
);`;
}

/** Columns added after the first release (older local databases). */
async function migrate(db: Db) {
  const add = async (table: string, column: string, type: string) => {
    if (db.dialect === 'pg') return db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`);
    const cols = await db.all<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  await add('destinations', 'max_per_day', 'INTEGER');
  await add('destinations', 'min_gap_days', 'INTEGER');
}

/** Default records: the company, vehicle and driver from the brief plus the sample partners. */
async function seed(db: Db) {
  const { n } = (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM companies'))!;
  if (Number(n) > 0) return;
  const insDest = (name: string, address: string, lat: number | null, lon: number | null) =>
    db.insert('INSERT INTO destinations (name, address, lat, lon) VALUES (?, ?, ?, ?)', [name, address, lat, lon]);

  const home = await insDest('ERNIVILL Kft', '7305 Komló, Iskola út 41.', 46.2127544, 18.2418763);
  await db.insert('INSERT INTO companies (name, address, tax_number, home_destination_id) VALUES (?, ?, ?, ?)',
    ['Ernivill Kft.', '7305 Komló, Iskola út 41.', '23585182-2-02', home]);
  await db.insert('INSERT INTO vehicles (plate, category, model, fuel, consumption) VALUES (?, ?, ?, ?, ?)',
    ['AELU-689', 'Személygépkocsi', 'Mercedes GLC', 'Benzin', 9.5]);
  await db.insert('INSERT INTO drivers (name, tax_number, address) VALUES (?, ?, ?)',
    ['Eckhardt Tímea', '8398242566', '7305 Komló, Iskola út 41.']);

  // Partners and distances taken from the 2024 sample records.
  const partners: [string, string, number | null, number | null, number][] = [
    ['Pappas Auto', '7630 Pécs, Koksz utca 125.', 46.0844904, 18.2762294, 25.9],
    ['Magyar Posta Zrt.', '7300 Komló, Városház tér 2.', 46.1906513, 18.2610458, 3.2],
    ['OTP Bank', '7300 Komló, Kossuth Lajos utca 95.', 46.1902207, 18.2653289, 3.4],
    ['Könyvelő iroda', '7300 Komló, Városház tér 13.', 46.1911, 18.2627, 3.2],
    ['Metro', '7634 Pécs, Makay István út 6.', null, null, 27.6],
  ];
  for (const [name, address, lat, lon, km] of partners) {
    const id = await insDest(name, address, lat, lon);
    await db.insert('INSERT INTO routes (name, from_id, to_id, distance_km) VALUES (?, ?, ?, ?)', [`Telephely → ${name}`, home, id, km]);
  }
}

export async function prepare(db: Db) {
  await db.exec(schema(db.dialect));
  await migrate(db);
  await seed(db);
  return db;
}

export function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (url) return pgDb(url);
  return sqliteDb(process.env.DB_FILE ?? path.resolve('data', 'menet-mester.db'));
}

let ready: Promise<Db> | null = null;
/** The shared, initialised database (schema and defaults are applied once per process). */
export function getDb(): Promise<Db> {
  ready ??= openDb().then(prepare).catch((e) => { ready = null; throw e; });
  return ready;
}
