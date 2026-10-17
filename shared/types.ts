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
  maxPerDay: number | null; // how many times a day it may be visited (default 1)
  minGapDays: number | null; // at least this many days between two visits
}

/** Placeholder for the company base inside trip templates. */
export const BASE = 0;

export interface TripTemplateDay {
  stops: number[]; // destination ids in order, BASE = telephely; empty = the car stays parked
  repeat: number; // the same day plan repeated on consecutive days
}

/** A recurring trip described day by day, e.g. a Monday–Friday stay abroad. */
export interface TripTemplate {
  id: number;
  name: string;
  startWeekdays: number[]; // 1 = Monday … 7 = Sunday; empty = any working day
  days: TripTemplateDay[];
  minPerMonth: number | null;
  maxPerMonth: number | null;
  onlyDates: string[]; // when set, the trip happens exactly on these start dates and never otherwise
  note: string;
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

export interface TemplateRule {
  templateId: number;
  minPerMonth: number | null;
  maxPerMonth: number | null;
}

/** Something the user knows about a given day, placed on the planner calendar. */
export type PlanEntry =
  | { id: string; date: string; type: 'visit'; destinationIds: number[]; odometer: number | null }
  | { id: string; date: string; type: 'template'; templateId: number };

export type TourChance = 'never' | 'rare' | 'sometimes' | 'often';

export type DayKind = 'free' | 'trip' | 'template' | 'required' | 'plan';

/** What the car did on one day. Days without driving inside a multi-day trip have no stops. */
export interface DayPlan {
  date: string;
  stops: number[];
  kind: DayKind;
  label: string;
  unitId: string; // days of one multi-day trip share it
  ruleKey?: string; // r:<routeId> or t:<templateId> on the first day of a generated unit
  locked?: boolean;
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
  templates: TemplateRule[];
  plan: PlanEntry[];
  locked: DayPlan[];
  tourChance: TourChance;
  farKm: number | null; // one-way distance from which a trip may include nights away; null = never
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
  kind: DayKind;
  label: string;
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
  days: DayPlan[];
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
