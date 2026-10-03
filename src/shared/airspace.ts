// Fictionalized Atlanta-style airspace adaptation data. NOT real procedures.
// One TRACON (APP + TWR) and two en route sectors (CTR-NW, CTR-SE).
import type { PositionId, Wake } from './types';
import { type Vec, dist, headingVec } from './geo';

export const AIRPORT = { id: 'KATL', name: 'Atlanta (fictionalized)', elev: 1000 };
export const TRACON_RADIUS = 35; // NM
export const TOWER_RADIUS = 5; // NM
export const TOWER_CEILING = 3500; // ft
export const AIRSPACE_RADIUS = 110; // NM, flights beyond this leave the simulation
export const FIELD_ELEV = AIRPORT.elev;

export type Runway = {
  id: string;
  hdg: number; // landing / takeoff direction
  thr: Vec; // landing threshold
  end: Vec; // departure end
  faf: Vec; // final approach fix, 8 NM on the extended centerline
  base: string; // fix where arrivals join (and hold if not cleared)
};

// Parallel runways, west flow, 1.5 NM apart.
const RWY_LEN = 1.7;
function makeRunway(id: string, y: number, base: string): Runway {
  const thr = { x: 1.5, y };
  const dir = headingVec(270);
  return {
    id,
    hdg: 270,
    thr,
    end: { x: thr.x + dir.x * RWY_LEN, y },
    faf: { x: thr.x - dir.x * 8, y },
    base,
  };
}

export const RUNWAYS: Record<string, Runway> = {
  '27R': makeRunway('27R', 0.75, 'NORTB'),
  '27L': makeRunway('27L', -0.75, 'SOUTB'),
};
export const ARRIVAL_RUNWAYS = ['27R', '27L'];
export const DEPARTURE_RUNWAY = '27L';

export type Fix = { name: string; pos: Vec; kind: 'corridor' | 'base' | 'gate' | 'enroute' };

export const FIXES: Record<string, Fix> = {
  // Arrival corridors (corner posts) on the TRACON boundary
  NWARD: { name: 'NWARD', pos: { x: -30, y: 18 }, kind: 'corridor' },
  NOLLY: { name: 'NOLLY', pos: { x: 6, y: 34 }, kind: 'corridor' },
  SEGRL: { name: 'SEGRL', pos: { x: 30, y: -18 }, kind: 'corridor' },
  SOWWY: { name: 'SOWWY', pos: { x: -6, y: -34 }, kind: 'corridor' },
  // Base fixes where arrivals join final (and hold when not yet cleared)
  NORTB: { name: 'NORTB', pos: { x: 14, y: 8 }, kind: 'base' },
  SOUTB: { name: 'SOUTB', pos: { x: 14, y: -8 }, kind: 'base' },
  // Departure gates
  DEPNW: { name: 'DEPNW', pos: { x: -35, y: 2 }, kind: 'gate' },
  DEPSW: { name: 'DEPSW', pos: { x: -22, y: -27 }, kind: 'gate' },
  // En route fixes
  RAZRB: { name: 'RAZRB', pos: { x: -60, y: 60 }, kind: 'enroute' },
  PEACH: { name: 'PEACH', pos: { x: 60, y: -60 }, kind: 'enroute' },
  BLURG: { name: 'BLURG', pos: { x: -80, y: 10 }, kind: 'enroute' },
  CHATT: { name: 'CHATT', pos: { x: -40, y: 80 }, kind: 'enroute' },
};

export type Corridor = { fix: string; runway: string; entry: Vec; entryAlt: number; sector: PositionId; from: string };
export const CORRIDORS: Corridor[] = [
  { fix: 'NWARD', runway: '27R', entry: { x: -88, y: 55 }, entryAlt: 22000, sector: 'CTR-NW', from: 'KBNA' },
  { fix: 'NOLLY', runway: '27R', entry: { x: 15, y: 100 }, entryAlt: 24000, sector: 'CTR-NW', from: 'KORD' },
  { fix: 'SEGRL', runway: '27L', entry: { x: 88, y: -55 }, entryAlt: 22000, sector: 'CTR-SE', from: 'KMCO' },
  { fix: 'SOWWY', runway: '27L', entry: { x: -15, y: -100 }, entryAlt: 24000, sector: 'CTR-SE', from: 'KMSY' },
];
export const DEPARTURE_GATES = [
  { fix: 'DEPNW', dest: 'KDEN', requestedAlt: 23000 },
  { fix: 'DEPSW', dest: 'KIAH', requestedAlt: 21000 },
];

// Altitude constraints flown automatically on the arrival ("descend via").
export const CORRIDOR_ALT = 11000;
export const BASE_ALT = 6000;
export const FAF_ALT = 3000;
export const DEPARTURE_INITIAL_ALT = 5000; // under the arrival flows

/** Which position's airspace contains a point. */
export function geoSector(p: Vec, alt: number): PositionId {
  const r = Math.hypot(p.x, p.y);
  if (r <= TOWER_RADIUS && alt < TOWER_CEILING) return 'TWR';
  if (r <= TRACON_RADIUS) return 'APP';
  return p.y - p.x >= 0 ? 'CTR-NW' : 'CTR-SE';
}

export function isTerminal(p: Vec): boolean {
  return Math.hypot(p.x, p.y) <= TRACON_RADIUS;
}

/** Final approach zone: 1 NM either side of the extended centerline, 0-12 NM from the threshold. */
export function finalZone(p: Vec): string | undefined {
  for (const rwy of Object.values(RUNWAYS)) {
    const along = p.x - rwy.thr.x; // approach comes from the east for 27L/27R
    if (along >= -0.5 && along <= 12 && Math.abs(p.y - rwy.thr.y) <= 1) return rwy.id;
  }
  return undefined;
}

/** Departure climb-out zone: 1 NM either side of the centerline, 0-12 NM beyond the threshold. */
export function departureZone(p: Vec): string | undefined {
  for (const rwy of Object.values(RUNWAYS)) {
    const beyond = rwy.thr.x - p.x;
    if (beyond >= 0 && beyond <= 12 && Math.abs(p.y - rwy.thr.y) <= 1) return rwy.id;
  }
  return undefined;
}

/** Applicable horizontal minimum (NM) for a pair. */
export function horizontalMinimum(a: Vec, b: Vec): number {
  const fa = finalZone(a), fb = finalZone(b);
  if (fa && fa === fb) return 2.5; // in-trail on the same final within 10 NM
  return isTerminal(a) || isTerminal(b) ? 3 : 5;
}

/** Pairs exempt from conflict probing (simultaneous independent parallel approaches). */
export function pairExempt(a: Vec, b: Vec): boolean {
  const fa = finalZone(a), fb = finalZone(b);
  return !!fa && !!fb && fa !== fb;
}

// ---- Terrain: coarse minimum safe altitude grid (10 NM cells) ----
export const TERRAIN_CELL = 10;
export const TERRAIN_MIN = -110;
export const TERRAIN_N = 22;

function cellMsa(cx: number, cy: number): number {
  // cell centre in NM
  const x = TERRAIN_MIN + (cx + 0.5) * TERRAIN_CELL;
  const y = TERRAIN_MIN + (cy + 0.5) * TERRAIN_CELL;
  // North Georgia mountains, fictionalized: high ground north of the airport.
  if (y > 40 && y < 80 && x > -50 && x < 30) {
    if (y > 50 && y < 70 && x > -30 && x < 10) return 8000;
    return 6000;
  }
  if (y > 30 && y < 90 && x > -70 && x < 50) return 5000;
  if (Math.hypot(x, y) < 20) return 2500;
  return 3000;
}

export const TERRAIN: number[][] = Array.from({ length: TERRAIN_N }, (_, cy) =>
  Array.from({ length: TERRAIN_N }, (_, cx) => cellMsa(cx, cy)),
);

export function terrainMsa(p: Vec): number {
  const cx = Math.floor((p.x - TERRAIN_MIN) / TERRAIN_CELL);
  const cy = Math.floor((p.y - TERRAIN_MIN) / TERRAIN_CELL);
  if (cx < 0 || cy < 0 || cx >= TERRAIN_N || cy >= TERRAIN_N) return 3000;
  return TERRAIN[cy][cx];
}

// ---- Aircraft performance: 5 classes ----
export type PerfClass = 'RJ' | 'NB' | 'WB' | 'TP' | 'BJ';
export type Perf = { cruise: number; climb: number; descent: number; vapp: number; vmin: number; vmax: number; wake: Wake };
export const PERF: Record<PerfClass, Perf> = {
  RJ: { cruise: 440, climb: 2500, descent: 2000, vapp: 140, vmin: 170, vmax: 460, wake: 'E' },
  NB: { cruise: 450, climb: 2500, descent: 2200, vapp: 140, vmin: 180, vmax: 470, wake: 'D' },
  WB: { cruise: 480, climb: 2000, descent: 2000, vapp: 150, vmin: 190, vmax: 490, wake: 'B' },
  TP: { cruise: 280, climb: 1500, descent: 1500, vapp: 120, vmin: 150, vmax: 290, wake: 'E' },
  BJ: { cruise: 460, climb: 3500, descent: 2500, vapp: 130, vmin: 170, vmax: 480, wake: 'F' },
};
export const AIRCRAFT_TYPES: Record<string, PerfClass> = {
  CRJ9: 'RJ', E175: 'RJ', B738: 'NB', A320: 'NB', A321: 'NB', B739: 'NB',
  B77W: 'WB', B763: 'WB', A332: 'WB', DH8D: 'TP', AT76: 'TP', CL35: 'BJ', GLF5: 'BJ',
};
export function perfOf(type: string): Perf {
  return PERF[AIRCRAFT_TYPES[type] ?? 'NB'];
}

// RECAT-style wake spacing on final (NM), leader -> follower.
const WAKE_ORDER: Wake[] = ['A', 'B', 'C', 'D', 'E', 'F'];
const WAKE_TABLE = [
  [3, 4, 5, 5, 6, 8],
  [3, 3, 4, 4, 5, 7],
  [3, 3, 3, 3, 3.5, 6],
  [3, 3, 3, 3, 3, 5],
  [3, 3, 3, 3, 3, 4],
  [3, 3, 3, 3, 3, 3],
];
export function wakeSpacing(leader: Wake, follower: Wake): number {
  return WAKE_TABLE[WAKE_ORDER.indexOf(leader)][WAKE_ORDER.indexOf(follower)];
}

export const AIRLINES = ['DAL', 'AAL', 'UAL', 'SWA', 'JBU', 'FDX', 'UPS', 'NKS', 'ASA', 'EDV'];

export function fixPos(name: string): Vec | undefined {
  return FIXES[name]?.pos;
}

export function nearestFix(p: Vec): string {
  let best = '', bd = Infinity;
  for (const f of Object.values(FIXES)) {
    const d = dist(p, f.pos);
    if (d < bd) { bd = d; best = f.name; }
  }
  return best;
}

/** Sector boundary polylines for drawing on the scope. */
export function sectorBoundaries(): Vec[][] {
  const circle = (r: number, n = 72) => Array.from({ length: n + 1 }, (_, i) => ({ x: r * Math.sin((i / n) * 2 * Math.PI), y: r * Math.cos((i / n) * 2 * Math.PI) }));
  const split = (from: number, to: number) => {
    const u = Math.SQRT1_2;
    return [{ x: from * u, y: from * u }, { x: to * u, y: to * u }];
  };
  return [circle(TRACON_RADIUS), circle(AIRSPACE_RADIUS), circle(TOWER_RADIUS, 36), split(TRACON_RADIUS, AIRSPACE_RADIUS), split(-TRACON_RADIUS, -AIRSPACE_RADIUS)];
}
