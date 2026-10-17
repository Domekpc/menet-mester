import { db } from './db.js';
import type { GeoSuggestion, RouteCalc } from '../shared/types.js';

// Free OpenStreetMap based services: Photon (search-as-you-type geocoder) and OSRM (routing).
const PHOTON = process.env.PHOTON_URL ?? 'https://photon.komoot.io';
const OSRM = process.env.OSRM_URL ?? 'https://router.project-osrm.org';
// Results near Hungary rank first, but foreign addresses (e.g. Austrian partners) are found too.
const BIAS = 'lat=47.16&lon=19.5&zoom=6&location_bias_scale=0.3';
const COUNTRIES: Record<string, string> = {
  AT: 'Ausztria', SK: 'Szlovákia', RO: 'Románia', RS: 'Szerbia', HR: 'Horvátország', SI: 'Szlovénia',
  UA: 'Ukrajna', DE: 'Németország', CZ: 'Csehország', PL: 'Lengyelország', IT: 'Olaszország',
};
const UA = 'menet-mester/0.1 (utnyilvantarto)';

const getCache = db.prepare('SELECT value FROM geo_cache WHERE key = ?');
const setCache = db.prepare('INSERT OR REPLACE INTO geo_cache (key, value) VALUES (?, ?)');

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = getCache.get(key) as { value: string } | undefined;
  if (hit) return JSON.parse(hit.value) as T;
  const value = await load();
  setCache.run(key, JSON.stringify(value));
  return value;
}

async function fetchJson(url: string) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Külső szolgáltatás hiba (${res.status})`);
  return res.json();
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | undefined>;
}

function toSuggestion(f: PhotonFeature): GeoSuggestion {
  const p = f.properties;
  const hu = !p.countrycode || p.countrycode === 'HU';
  // Hungarian house numbers are written with a trailing dot, foreign ones without
  const street = p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber + (hu ? '.' : '') : ''}` : '';
  const country = hu ? '' : COUNTRIES[p.countrycode!] ?? p.country ?? p.countrycode!;
  const city = p.city ?? p.town ?? p.village ?? p.county ?? '';
  const place = [p.postcode, city].filter(Boolean).join(' ');
  const primary = p.name && p.name !== street ? p.name : street || city || (p.name ?? '');
  const secondary = [p.name && p.name !== street ? street : '', place, country].filter(Boolean).join(', ');
  const label = [place, street || (p.name ?? ''), country].filter(Boolean).join(', ');
  return { label, primary, secondary, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
}

export async function suggest(q: string): Promise<GeoSuggestion[]> {
  const query = q.trim();
  if (query.length < 3) return [];
  return cached(`s2:${query.toLowerCase()}`, async () => {
    const url = `${PHOTON}/api/?q=${encodeURIComponent(query)}&limit=7&${BIAS}&lang=default`;
    const data = (await fetchJson(url)) as { features: PhotonFeature[] };
    const seen = new Set<string>();
    return data.features.map(toSuggestion).filter((s) => {
      const k = s.label + s.primary;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  });
}

export async function geocode(address: string): Promise<{ lat: number; lon: number } | null> {
  const list = await suggest(address);
  return list[0] ? { lat: list[0].lat, lon: list[0].lon } : null;
}

/** Shortest driving route (by distance) among the alternatives OSRM offers. */
export async function route(from: { lat: number; lon: number }, to: { lat: number; lon: number }): Promise<RouteCalc> {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  return cached(`r:${coords}`, async () => {
    const url = `${OSRM}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=3`;
    const data = (await fetchJson(url)) as {
      code: string;
      routes: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    };
    if (data.code !== 'Ok' || !data.routes.length) throw new Error('Nem található útvonal a két cím között');
    const best = data.routes.reduce((a, b) => (b.distance < a.distance ? b : a));
    return {
      distanceKm: Math.round(best.distance / 100) / 10,
      durationMin: Math.round(best.duration / 60),
      geometry: best.geometry.coordinates.map(([lon, lat]) => [lat, lon] as [number, number]),
    };
  });
}
