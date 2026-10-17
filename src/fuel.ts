// Fuel prices per month (Ft/L). The NAV publishes official monthly prices; the user can
// overwrite them in the result view and we remember the last value they used.
const KNOWN: Record<string, number> = { '2024-04': 617, '2024-05': 646 };
const KEY = 'menet-mester:fuel-prices';

function stored(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function defaultFuelPrices(months: string[]): Record<string, number> {
  const mem = { ...KNOWN, ...stored() };
  let last = Object.keys(mem).sort().map((k) => mem[k]).pop() ?? 620;
  const out: Record<string, number> = {};
  for (const m of months) {
    if (mem[m]) last = mem[m];
    out[m] = mem[m] ?? last;
  }
  return out;
}

export function rememberFuelPrices(prices: Record<string, number>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...stored(), ...prices }));
  } catch {
    /* storage unavailable — not critical */
  }
}
