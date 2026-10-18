/**
 * Hungarian number plates in one form: upper case, letters and digits separated by a hyphen
 * ("rgk362" → "RGK-362", "AELU689" → "AELU-689"). Anything unusual is only upper-cased.
 */
export function formatPlate(value: string): string {
  const raw = value.toUpperCase().replace(/[^A-Z0-9ÁÉÍÓÖŐÚÜŰ]/g, '');
  const m = /^([A-Z]{3,4})(\d{3})$/.exec(raw);
  return m ? `${m[1]}-${m[2]}` : value.trim().toUpperCase();
}

/** 9.5 → "9,5" */
export const decimalHu = (n: number | string) => String(n).replace('.', ',');
