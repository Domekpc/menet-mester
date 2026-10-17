// Shared domain types between the API server and the web client.

export interface Company {
  id: number;
  name: string;
  address: string;
  taxNumber: string;
  homeDestinationId: number | null;
}

export interface Vehicle {
  id: number;
  plate: string;
  category: string;
  model: string;
  fuel: string;
  consumption: number; // L/100km
}

export interface Driver {
  id: number;
  name: string;
  taxNumber: string;
  address: string;
}

export interface Destination {
  id: number;
  name: string;
  address: string;
  lat: number | null;
  lon: number | null;
}

export interface Route {
  id: number;
  name: string;
  fromId: number;
  toId: number;
  distanceKm: number;
}

export type VehicleEventType = 'service' | 'inspection' | 'other';

export interface VehicleEvent {
  id: number;
  vehicleId: number;
  date: string; // YYYY-MM-DD
  type: VehicleEventType;
  destinationId: number;
  odometer: number | null;
  note: string;
  source: string;
}

export interface GeoSuggestion {
  label: string;
  primary: string;
  secondary: string;
  lat: number;
  lon: number;
}

export interface RouteCalc {
  distanceKm: number;
  durationMin: number;
  geometry: [number, number][]; // [lat, lon]
}

// ---------- Generator ----------

/** A day where the vehicle had to be at a given place (service, inspection, user requirement). */
export interface RequiredStop {
  date: string;
  destinationId: number;
  odometer: number | null; // odometer reading on arrival, if known
  label: string;
  source: string;
}

/** Odometer must read `odometer` at the end of `date`. */
export interface OdometerCheckpoint {
  date: string;
  odometer: number;
}

export interface RouteRule {
  routeId: number;
  minPerMonth: number | null;
  maxPerMonth: number | null;
}

export interface GenerateRequest {
  companyId: number;
  vehicleId: number;
  driverId: number;
  baseDestinationId: number;
  startOdometer: number;
  endOdometer: number;
  fromMonth: string; // YYYY-MM
  toMonth: string; // YYYY-MM
  stops: RequiredStop[];
  checkpoints: OdometerCheckpoint[];
  routes: RouteRule[];
  seed?: number;
}

export interface TripLeg {
  date: string;
  fromId: number;
  toId: number;
  fromAddress: string;
  toAddress: string;
  partner: string;
  km: number;
  required: boolean;
}

export interface MonthResult {
  month: string; // YYYY-MM
  startOdometer: number;
  endOdometer: number;
  totalKm: number;
  legs: TripLeg[];
}

export interface GenerateResult {
  months: MonthResult[];
  totalKm: number;
  targetKm: number;
  warnings: string[];
  seed: number;
}

export interface SavedReport {
  id: number;
  title: string;
  createdAt: string;
  request: GenerateRequest;
  result: GenerateResult;
  fuelPrices: Record<string, number>;
}
