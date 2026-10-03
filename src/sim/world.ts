// Sim World: point-mass aircraft kinematics, pilot model and traffic generator.
// Fully deterministic for a given scenario, seed and sequence of issued clearances.
import {
  AIRSPACE_RADIUS, AIRCRAFT_TYPES, AIRLINES, BASE_ALT, CORRIDORS, CORRIDOR_ALT, DEPARTURE_GATES, DEPARTURE_INITIAL_ALT,
  DEPARTURE_RUNWAY, FAF_ALT, FIELD_ELEV, FIXES, RUNWAYS, TRACON_RADIUS, geoSector, perfOf,
} from '../shared/airspace';
import { angleDiff, bearing, clamp, DEG, dist, headingVec, norm360, type Vec } from '../shared/geo';
import type { Clearance, CommsLine, Flight, FlightKind, FlightPhase, PositionId, RawFrame, RunwayClearance, TrafficLevel, Wake } from '../shared/types';
import { makeRng, next, pick, range, int, type RngState } from './rng';
import { TRAFFIC_RATES, type Scenario, type ScenarioAircraft, type ScenarioEvent, type WindLayer } from './scenario';
import { readbackText } from '../shared/commands';

export const SWEEP_SEC = 4.8;
export const TURN_RATE = 3; // deg/s, standard rate
export const GLIDE_FT_PER_NM = 318; // 3 degrees
export const ARRIVAL_STREAM_SPEED = 290; // kt, uniform en route arrival stream speed (no overtaking)

export type NavMode = 'route' | 'heading' | 'direct' | 'approach' | 'hold' | 'straight';

export type PendingClearance = { applyAt: number; issued: Clearance; flown: Clearance };

export type Aircraft = {
  id: string;
  callsign: string;
  type: string;
  wake: Wake;
  kind: FlightKind;
  phase: FlightPhase;
  x: number;
  y: number;
  alt: number;
  hdg: number;
  ias: number;
  vs: number;
  gs: number;
  trk: number;
  squawk: string;
  nordo: boolean;
  engineOut: boolean;
  plan: { origin: string; dest: string; route: string[] };
  routeIdx: number;
  requestedAlt?: number;
  runway?: string;
  cleared: { alt?: number; hdg?: number; spd?: number; direct?: string; approach?: string };
  nav: { mode: NavMode; hdg?: number; direct?: string; leg?: -1 | 0 | 1 }; // approach legs: -1 to base fix, 0 to FAF, 1 localizer
  tAlt: number;
  tSpd?: number;
  descendVia: boolean;
  pending: PendingClearance[];
  rwyClr?: RunwayClearance;
  forceWrongReadback?: number | true;
  spawnT: number;
  owner: PositionId;
  lastControllerClearanceT?: number;
};

export type WorldState = {
  scenarioId: string;
  seed: number;
  t: number;
  tick: number;
  wind: WindLayer[];
  traffic: TrafficLevel;
  departuresPerHour?: number;
  aircraft: Aircraft[];
  rng: RngState; // traffic generator, pilot delays
  dlRng: RngState; // readback errors
  nextSpawn: Record<string, number>;
  nextDeparture: number;
  events: ScenarioEvent[];
  eventIdx: number;
  serial: number;
  landed: { callsign: string; runway: string; t: number; wake: Wake; sta?: number }[];
};

export type Readback = { callsign: string; issued: Clearance; flown: Clearance; text: string; t: number };

export type StepResult = {
  comms: CommsLine[];
  readbacks: Readback[];
  landed: string[];
  exited: string[];
  squawks: { callsign: string; code: string }[];
  scenarioClearances: { clearance: Clearance; position: PositionId }[];
};

export function windAt(layers: WindLayer[], alt: number): Vec {
  if (!layers.length) return { x: 0, y: 0 };
  let lo = layers[0], hi = layers[layers.length - 1];
  for (let i = 0; i < layers.length - 1; i++) {
    if (alt >= layers[i].alt && alt <= layers[i + 1].alt) { lo = layers[i]; hi = layers[i + 1]; break; }
  }
  const f = hi.alt === lo.alt ? 0 : clamp((alt - lo.alt) / (hi.alt - lo.alt), 0, 1);
  const spd = lo.spd + (hi.spd - lo.spd) * f;
  const dir = lo.dir + angleDiff(hi.dir, lo.dir) * f;
  const v = headingVec(dir + 180); // wind blows toward dir + 180
  return { x: v.x * spd, y: v.y * spd };
}

export function onGround(ac: Aircraft): boolean {
  return ac.phase === 'holding-short' || ac.phase === 'lineup' || (ac.phase === 'takeoff' && ac.alt <= FIELD_ELEV + 1);
}

// ---------------------------------------------------------------------------
// Pilot model + kinematics for one aircraft over dt seconds. Pure; also used by the Trajectory agent.
// ---------------------------------------------------------------------------
export function stepAircraft(ac: Aircraft, dt: number, wind: WindLayer[]): { landed?: boolean } {
  const perf = perfOf(ac.type);
  const r = Math.hypot(ac.x, ac.y);

  if (ac.phase === 'holding-short' || ac.phase === 'lineup') {
    ac.gs = 0; ac.vs = 0; ac.ias = 0;
    return {};
  }

  if (ac.phase === 'takeoff') {
    const rwy = RUNWAYS[ac.runway ?? DEPARTURE_RUNWAY];
    ac.hdg = rwy.hdg;
    ac.ias = Math.min(ac.ias + 5 * dt, 250);
    if (ac.ias >= 150) {
      ac.phase = 'airborne';
      ac.rwyClr = undefined;
      ac.nav = { mode: 'route' };
      ac.tAlt = ac.cleared.alt ?? DEPARTURE_INITIAL_ALT;
      ac.cleared.alt = ac.tAlt;
    }
  }

  // ---- lateral guidance ----
  let targetHdg = ac.hdg;
  let continuousRight = false;
  const nav = ac.nav;
  const holdOrFix = (fixName: string) => {
    const p = FIXES[fixName]?.pos;
    if (!p) return;
    if (dist(ac, p) > 4) targetHdg = bearing(ac, p);
    else continuousRight = true;
  };
  if (ac.phase === 'airborne' || ac.phase === 'approach') {
    const climbingOut = ac.kind === 'departure' && ac.runway && dist(ac, RUNWAYS[ac.runway].thr) < 4 && nav.mode === 'route';
    if (climbingOut) {
      targetHdg = RUNWAYS[ac.runway!].hdg;
    } else if (nav.mode === 'heading' && nav.hdg !== undefined) {
      targetHdg = nav.hdg;
    } else if (nav.mode === 'route') {
      const fix = ac.plan.route[ac.routeIdx];
      const p = fix ? FIXES[fix]?.pos : undefined;
      if (p) {
        if (dist(ac, p) < 1.5) {
          passFix(ac, fix);
        } else targetHdg = bearing(ac, p);
      }
    } else if (nav.mode === 'direct' && nav.direct) {
      const p = FIXES[nav.direct]?.pos;
      if (p) {
        if (dist(ac, p) < 1.5) {
          const idx = ac.plan.route.indexOf(nav.direct);
          const passed = nav.direct;
          if (idx >= 0) { ac.routeIdx = idx; ac.nav = { mode: 'route' }; passFix(ac, passed); }
          else if (FIXES[passed].kind === 'base' && ac.kind === 'arrival') ac.nav = { mode: 'hold', direct: passed };
          else ac.nav = { mode: 'straight' };
          ac.cleared.direct = undefined;
        } else targetHdg = bearing(ac, p);
      }
    } else if (nav.mode === 'hold' && nav.direct) {
      holdOrFix(nav.direct);
    } else if (nav.mode === 'approach' && ac.runway) {
      const rwy = RUNWAYS[ac.runway];
      if (nav.leg === -1) {
        const base = FIXES[rwy.base].pos;
        if (dist(ac, base) < 2) nav.leg = 0;
        else targetHdg = bearing(ac, base);
      }
      if (nav.leg === 0) {
        const established = Math.abs(ac.y - rwy.thr.y) < 1 && ac.x > rwy.thr.x && ac.x <= rwy.faf.x + 2;
        if (dist(ac, rwy.faf) < 2 || established) nav.leg = 1;
        else targetHdg = bearing(ac, rwy.faf);
      }
      if (nav.leg === 1) {
        // Localizer: steer toward a point on the centerline 1.5 NM ahead.
        const dir = headingVec(rwy.hdg);
        const along = (ac.x - rwy.thr.x) * dir.x + (ac.y - rwy.thr.y) * dir.y; // negative before threshold
        const aim = { x: rwy.thr.x + dir.x * (along + 1.5), y: rwy.thr.y + dir.y * (along + 1.5) };
        targetHdg = bearing(ac, aim);
        if (along >= 0) {
          ac.phase = 'landed';
          return { landed: true };
        }
      }
    }
  }

  // ---- turn ----
  const maxTurn = TURN_RATE * dt;
  if (continuousRight) ac.hdg = norm360(ac.hdg + maxTurn);
  else {
    const d = angleDiff(targetHdg, ac.hdg);
    ac.hdg = norm360(ac.hdg + clamp(d, -maxTurn, maxTurn));
  }

  // ---- speed ----
  if (ac.phase !== 'takeoff') {
    let target = ac.tSpd ?? autoSpeed(ac, r);
    if (ac.nav.mode === 'approach' && ac.runway) {
      const dThr = dist(ac, RUNWAYS[ac.runway].thr);
      target = dThr < 5 ? perf.vapp : ac.nav.leg === -1 ? ac.tSpd ?? autoSpeed(ac, r) : Math.min(ac.tSpd ?? 180, 180);
    }
    if (ac.engineOut) target = Math.min(target, 210);
    target = clamp(target, ac.nav.mode === 'approach' ? perf.vapp : perf.vmin, perf.vmax);
    if (ac.alt < 10000 && ac.nav.mode !== 'approach') target = Math.min(target, 250);
    const accel = target > ac.ias ? 1.5 : 1.2;
    ac.ias += clamp(target - ac.ias, -accel * dt, accel * dt);
  }

  // ---- vertical ----
  if (ac.phase === 'airborne' || ac.phase === 'approach') {
    let climb = perf.climb * (ac.engineOut ? 0.4 : 1);
    const descent = perf.descent;
    let tAlt = ac.tAlt;
    if (ac.engineOut) tAlt = Math.min(tAlt, 15000);
    if (ac.nav.mode === 'approach' && ac.runway) {
      const rwy = RUNWAYS[ac.runway];
      if (ac.nav.leg === 1) {
        const glide = FIELD_ELEV + 50 + dist(ac, rwy.thr) * GLIDE_FT_PER_NM;
        tAlt = Math.min(ac.alt, Math.max(glide, FIELD_ELEV + 50));
        climb = 0;
      } else if (ac.nav.leg === -1) tAlt = Math.min(ac.alt, Math.min(tAlt, BASE_ALT));
      else tAlt = Math.min(ac.alt, FAF_ALT);
    }
    const diff = tAlt - ac.alt;
    const maxUp = (climb / 60) * dt, maxDown = (descent / 60) * dt;
    const delta = clamp(diff, -maxDown, maxUp);
    ac.alt += delta;
    ac.vs = Math.round((delta / dt) * 60);
  } else if (ac.phase === 'takeoff') {
    ac.vs = 0;
  }

  // ---- position with wind ----
  const air = headingVec(ac.hdg);
  const w = windAt(wind, ac.alt);
  const vx = air.x * ac.ias + (ac.phase === 'takeoff' ? 0 : w.x);
  const vy = air.y * ac.ias + (ac.phase === 'takeoff' ? 0 : w.y);
  ac.gs = Math.hypot(vx, vy);
  ac.trk = ac.gs > 1 ? norm360(Math.atan2(vx, vy) / DEG) : ac.hdg;
  ac.x += (vx * dt) / 3600;
  ac.y += (vy * dt) / 3600;
  if (ac.phase === 'takeoff' && ac.ias >= 150) ac.alt = FIELD_ELEV + 1;
  return {};
}

function passFix(ac: Aircraft, fix: string) {
  ac.routeIdx++;
  const f = FIXES[fix];
  if (ac.kind === 'arrival' && f?.kind === 'corridor' && ac.descendVia) {
    ac.tAlt = Math.min(ac.tAlt, BASE_ALT);
    ac.cleared.alt = ac.tAlt;
  }
  if (ac.routeIdx >= ac.plan.route.length) {
    if (ac.kind === 'arrival' && f?.kind === 'base') ac.nav = { mode: 'hold', direct: fix };
    else ac.nav = { mode: 'straight' };
  }
}

function autoSpeed(ac: Aircraft, r: number): number {
  const perf = perfOf(ac.type);
  if (ac.kind === 'arrival') {
    if (r < TRACON_RADIUS) {
      const base = ac.runway ? FIXES[RUNWAYS[ac.runway].base].pos : undefined;
      if (ac.nav.mode === 'hold' || (base && dist(ac, base) < 12)) return Math.max(210, perf.vmin);
      return 250;
    }
    return Math.min(perf.cruise, ARRIVAL_STREAM_SPEED);
  }
  if (ac.alt < 10000) return 250;
  return perf.cruise;
}

/** Applies a received clearance to the pilot's targets. */
export function applyClearance(ac: Aircraft, c: Clearance): void {
  if (c.alt !== undefined) { ac.tAlt = c.alt; ac.cleared.alt = c.alt; ac.descendVia = false; }
  if (c.spd !== undefined) { ac.tSpd = c.spd; ac.cleared.spd = c.spd; }
  if (c.hdg !== undefined) {
    ac.nav = { mode: 'heading', hdg: c.hdg };
    ac.cleared.hdg = c.hdg; ac.cleared.direct = undefined; ac.cleared.approach = undefined;
    if (ac.phase === 'approach') ac.phase = 'airborne';
  }
  if (c.direct) {
    ac.nav = { mode: 'direct', direct: c.direct };
    ac.cleared.direct = c.direct; ac.cleared.hdg = undefined;
  }
  if (c.approach && ac.phase === 'airborne') {
    ac.runway = c.approach;
    const rwy = RUNWAYS[c.approach];
    const viaBase = approachViaBase(ac, c.approach);
    ac.nav = { mode: 'approach', leg: viaBase ? -1 : 0 };
    ac.phase = 'approach';
    ac.cleared.approach = c.approach; ac.cleared.hdg = undefined; ac.cleared.direct = undefined; ac.cleared.spd = undefined;
    ac.tSpd = undefined;
  }
  if (c.lineup && ac.phase === 'holding-short') {
    const rwy = RUNWAYS[c.lineup];
    ac.phase = 'lineup'; ac.runway = c.lineup; ac.x = rwy.thr.x; ac.y = rwy.thr.y; ac.hdg = rwy.hdg;
  }
  if (c.takeoff && (ac.phase === 'holding-short' || ac.phase === 'lineup')) {
    const rwy = RUNWAYS[c.takeoff];
    ac.phase = 'takeoff'; ac.runway = c.takeoff; ac.x = rwy.thr.x; ac.y = rwy.thr.y; ac.hdg = rwy.hdg; ac.ias = 0;
  }
  if (c.resume && ac.phase === 'airborne') {
    ac.nav = { mode: 'route' }; ac.cleared.hdg = undefined; ac.cleared.direct = undefined;
    if (ac.routeIdx >= ac.plan.route.length) ac.nav = { mode: 'straight' };
  }
}

/** Approach entry: still inbound to the base fix (on route or direct) => via base; holding => straight to the FAF. */
export function approachViaBase(ac: Aircraft, runway: string): boolean {
  const rwy = RUNWAYS[runway];
  const base = FIXES[rwy.base].pos;
  if (ac.nav.mode === 'hold') return false;
  const baseIdx = ac.plan.route.indexOf(rwy.base);
  if ((ac.nav.mode === 'route' && baseIdx >= 0 && ac.routeIdx <= baseIdx) || (ac.nav.mode === 'direct' && ac.nav.direct === rwy.base)) return dist(ac, base) > 2;
  return dist(ac, rwy.faf) > dist(base, rwy.faf) + 2;
}

export function cloneAircraft(ac: Aircraft): Aircraft {
  return {
    ...ac,
    plan: { ...ac.plan, route: ac.plan.route },
    cleared: { ...ac.cleared },
    nav: { ...ac.nav },
    pending: ac.pending.map((p) => ({ ...p })),
  };
}

// Arrival streams are jets (turboprops would be overtaken in a single-altitude stream).
const ARRIVAL_TYPES = Object.keys(AIRCRAFT_TYPES).filter((t) => perfOf(t).cruise >= 400);

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export class World {
  state: WorldState;

  constructor(state: WorldState) {
    this.state = state;
  }

  static fromScenario(sc: Scenario, seed = sc.seed, traffic: TrafficLevel = sc.traffic): World {
    const st: WorldState = {
      scenarioId: sc.id, seed, t: 0, tick: 0, wind: sc.wind, traffic, departuresPerHour: sc.departuresPerHour,
      aircraft: [], rng: makeRng(seed), dlRng: makeRng(seed * 7919 + 13), nextSpawn: {}, nextDeparture: 0,
      events: [...sc.events].sort((a, b) => a.at - b.at), eventIdx: 0, serial: 0, landed: [],
    };
    const w = new World(st);
    for (const a of sc.aircraft) w.addScenarioAircraft(a);
    w.scheduleTraffic(true);
    return w;
  }

  static fromJSON(json: string): World {
    return new World(JSON.parse(json) as WorldState);
  }

  toJSON(): string {
    return JSON.stringify(this.state);
  }

  get t() { return this.state.t; }
  get tick() { return this.state.tick; }
  get aircraft() { return this.state.aircraft; }

  find(callsign: string): Aircraft | undefined {
    return this.state.aircraft.find((a) => a.callsign === callsign || a.id === callsign);
  }

  private newId(): string {
    return `F${(++this.state.serial).toString(36).toUpperCase()}`;
  }

  addScenarioAircraft(a: ScenarioAircraft): Aircraft {
    const perf = perfOf(a.type);
    const ac: Aircraft = {
      id: this.newId(), callsign: a.callsign, type: a.type, wake: perf.wake, kind: a.kind,
      phase: a.phase ?? (a.approach ? 'approach' : 'airborne'),
      x: a.x, y: a.y, alt: a.alt, hdg: a.hdg, ias: a.spd, vs: 0, gs: a.spd, trk: a.hdg,
      squawk: a.squawk ?? this.squawkFor(), nordo: false, engineOut: false,
      plan: { origin: a.origin ?? (a.kind === 'departure' ? 'KATL' : 'ZZZZ'), dest: a.dest ?? (a.kind === 'arrival' ? 'KATL' : 'ZZZZ'), route: a.route ?? [] },
      routeIdx: 0, requestedAlt: a.requestedAlt, runway: a.runway ?? a.approach,
      cleared: { alt: a.clearedAlt ?? a.alt }, nav: { mode: a.route?.length ? 'route' : 'straight' },
      tAlt: a.clearedAlt ?? a.alt, descendVia: a.kind === 'arrival' && a.clearedAlt === undefined,
      pending: [], spawnT: this.state.t, owner: a.owner ?? geoSector(a, a.alt),
    };
    if (a.clearedHdg !== undefined) { ac.nav = { mode: 'heading', hdg: a.clearedHdg }; ac.cleared.hdg = a.clearedHdg; }
    if (a.approach) { ac.nav = { mode: 'approach', leg: 0 }; ac.cleared.approach = a.approach; }
    if (ac.phase === 'holding-short' || ac.phase === 'lineup') { ac.ias = 0; ac.gs = 0; ac.alt = FIELD_ELEV; ac.owner = a.owner ?? 'TWR'; }
    this.state.aircraft.push(ac);
    return ac;
  }

  private squawkFor(): string {
    // 4 octal digits, avoiding special codes
    let s = '';
    do {
      s = Array.from({ length: 4 }, () => int(this.state.rng, 0, 7)).join('');
    } while (/^(7500|7600|7700|1200|0000)$/.test(s));
    return s;
  }

  setTraffic(level: TrafficLevel) {
    this.state.traffic = level;
    this.scheduleTraffic(true);
  }

  private scheduleTraffic(reset: boolean) {
    const rates = TRAFFIC_RATES[this.state.traffic];
    for (const c of CORRIDORS) {
      if (rates.arrivalsPerHour <= 0) { delete this.state.nextSpawn[c.fix]; continue; }
      if (reset || this.state.nextSpawn[c.fix] === undefined) {
        const mean = 3600 / (rates.arrivalsPerHour / CORRIDORS.length);
        this.state.nextSpawn[c.fix] = this.state.t + mean * range(this.state.rng, 0.05, 0.9);
      }
    }
    const dph = this.state.departuresPerHour ?? rates.departuresPerHour;
    this.state.nextDeparture = dph > 0 ? this.state.t + (3600 / dph) * range(this.state.rng, 0.2, 1) : Infinity;
  }

  private uniqueCallsign(): string {
    for (;;) {
      const cs = `${pick(this.state.rng, AIRLINES)}${int(this.state.rng, 10, 2999)}`;
      if (!this.find(cs)) return cs;
    }
  }

  private generateTraffic(out: StepResult) {
    const rates = TRAFFIC_RATES[this.state.traffic];
    const types = Object.keys(AIRCRAFT_TYPES);
    if (rates.arrivalsPerHour > 0) {
      const mean = 3600 / (rates.arrivalsPerHour / CORRIDORS.length);
      for (const c of CORRIDORS) {
        if (this.state.t < (this.state.nextSpawn[c.fix] ?? Infinity)) continue;
        const crowded = this.state.aircraft.some((a) => (dist(a, c.entry) < 10 && Math.abs(a.alt - c.entryAlt) < 2000) || (a.plan.route[0] === c.fix && a.routeIdx === 0 && dist(a, c.entry) < 18));
        if (crowded) { this.state.nextSpawn[c.fix] = this.state.t + 30; continue; }
        const type = pick(this.state.rng, ARRIVAL_TYPES);
        const perf = perfOf(type);
        const fixPos = FIXES[c.fix].pos;
        const ac = this.addScenarioAircraft({
          callsign: this.uniqueCallsign(), type, kind: 'arrival', x: c.entry.x, y: c.entry.y,
          alt: c.entryAlt, hdg: bearing(c.entry, fixPos), spd: Math.min(perf.cruise, ARRIVAL_STREAM_SPEED),
          route: [c.fix, RUNWAYS[c.runway].base], runway: c.runway, origin: c.from, dest: 'KATL', owner: c.sector,
        });
        ac.tAlt = CORRIDOR_ALT; ac.cleared.alt = CORRIDOR_ALT; ac.descendVia = true;
        this.state.nextSpawn[c.fix] = this.state.t + mean * range(this.state.rng, 0.6, 1.4);
        out.comms.push({ t: this.state.t, from: ac.callsign, to: c.sector, text: `Atlanta Center, ${ac.callsign}, descending via the arrival to ${CORRIDOR_ALT.toLocaleString('en-US')}`, kind: 'pilot' });
      }
    }
    const dph = this.state.departuresPerHour ?? rates.departuresPerHour;
    if (dph > 0 && this.state.t >= this.state.nextDeparture) {
      const queue = this.state.aircraft.filter((a) => a.phase === 'holding-short');
      if (queue.length < 3) {
        const gate = pick(this.state.rng, DEPARTURE_GATES);
        const rwy = RUNWAYS[DEPARTURE_RUNWAY];
        const type = pick(this.state.rng, types);
        const ac = this.addScenarioAircraft({
          callsign: this.uniqueCallsign(), type, kind: 'departure', x: rwy.thr.x + 0.3 * queue.length, y: rwy.thr.y - 0.25,
          alt: FIELD_ELEV, hdg: 360, spd: 0, route: [gate.fix], runway: DEPARTURE_RUNWAY, origin: 'KATL', dest: gate.dest,
          requestedAlt: gate.requestedAlt, phase: 'holding-short', owner: 'TWR', clearedAlt: DEPARTURE_INITIAL_ALT,
        });
        out.comms.push({ t: this.state.t, from: ac.callsign, to: 'TWR', text: `Atlanta Tower, ${ac.callsign}, holding short runway ${DEPARTURE_RUNWAY}, ready`, kind: 'pilot' });
      }
      this.state.nextDeparture = this.state.t + (3600 / dph) * range(this.state.rng, 0.6, 1.4);
    }
  }

  /**
   * Controller issues a clearance. The pilot acts on it after a 3-8 s delay and reads it back
   * (2% of readbacks, or a scripted one, contain a wrong digit and the pilot flies the wrong value).
   */
  issueClearance(c: Clearance): { ok: boolean; error?: string; applyAt?: number } {
    const ac = this.find(c.flight);
    if (!ac) return { ok: false, error: `No flight ${c.flight}` };
    const delay = range(this.state.rng, 3, 8);
    const roll = next(this.state.dlRng);
    if (c.lineup) ac.rwyClr = { flight: ac.callsign, runway: c.lineup, kind: 'lineup' };
    if (c.takeoff) ac.rwyClr = { flight: ac.callsign, runway: c.takeoff, kind: 'takeoff' };
    if (ac.nordo) return { ok: true };
    let flown: Clearance = { ...c };
    const wrongForced = ac.forceWrongReadback;
    if ((wrongForced !== undefined || roll < 0.02) && (c.alt !== undefined || c.hdg !== undefined)) {
      if (c.alt !== undefined) {
        flown.alt = typeof wrongForced === 'number' ? wrongForced : c.alt + (c.alt >= 4000 ? -1000 : 1000);
      } else if (c.hdg !== undefined) {
        flown.hdg = norm360(c.hdg + (c.hdg >= 100 ? 10 : 20)) || 360;
      }
      ac.forceWrongReadback = undefined;
    }
    ac.pending.push({ applyAt: this.state.t + delay, issued: c, flown });
    return { ok: true, applyAt: this.state.t + delay };
  }

  setOwner(callsign: string, owner: PositionId) {
    const ac = this.find(callsign);
    if (ac) ac.owner = owner;
  }

  /** Advance one radar sweep. */
  step(dt = SWEEP_SEC): StepResult {
    const st = this.state;
    st.t = Math.round((st.t + dt) * 1000) / 1000;
    st.tick++;
    const out: StepResult = { comms: [], readbacks: [], landed: [], exited: [], squawks: [], scenarioClearances: [] };

    // Scheduled scenario events
    while (st.eventIdx < st.events.length && st.events[st.eventIdx].at <= st.t) {
      const ev = st.events[st.eventIdx++];
      if (ev.kind === 'clearance') { out.scenarioClearances.push({ clearance: ev.clearance, position: ev.position }); continue; }
      const ac = this.find(ev.callsign);
      if (!ac) continue;
      if (ev.kind === 'squawk') {
        ac.squawk = ev.code;
        out.squawks.push({ callsign: ac.callsign, code: ev.code });
        if (ev.code === '7600') ac.nordo = true;
        if (ev.code === '7700') {
          // Diverts into the airport: becomes an arrival for the nearer runway.
          if (ac.kind !== 'arrival') { ac.kind = 'arrival'; ac.plan = { ...ac.plan, dest: 'KATL' }; ac.runway = ac.y >= 0 ? '27R' : '27L'; }
          ac.requestedAlt = Math.max(FIELD_ELEV + 5000, Math.min(ac.alt - 4000, 10000));
          out.comms.push({ t: st.t, from: ac.callsign, to: ac.owner, text: `MAYDAY MAYDAY MAYDAY, ${ac.callsign}, request immediate descent to ${ac.requestedAlt.toLocaleString('en-US')} and vectors to Atlanta`, kind: 'pilot' });
        }
      } else if (ev.kind === 'wrongReadback') {
        ac.forceWrongReadback = ev.alt ?? true;
      } else if (ev.kind === 'engineOut') {
        ac.engineOut = true;
        out.comms.push({ t: st.t, from: ac.callsign, to: ac.owner, text: `${ac.callsign}, engine failure, unable to maintain speed`, kind: 'pilot' });
      } else if (ev.kind === 'pilotRequest') {
        out.comms.push({ t: st.t, from: ac.callsign, to: ac.owner, text: ev.text, kind: 'pilot' });
      }
    }

    this.generateTraffic(out);

    // Pilot receives clearances whose delay has elapsed, reads back, then flies
    for (const ac of st.aircraft) {
      if (!ac.pending.length) continue;
      const due = ac.pending.filter((p) => p.applyAt <= st.t);
      if (!due.length) continue;
      ac.pending = ac.pending.filter((p) => p.applyAt > st.t);
      for (const p of due) {
        applyClearance(ac, p.flown);
        // The flight data shows what the controller issued, even if the pilot flies something else.
        if (p.issued.alt !== undefined) ac.cleared.alt = p.issued.alt;
        if (p.issued.hdg !== undefined && ac.nav.mode === 'heading') ac.cleared.hdg = p.issued.hdg;
        const text = readbackText(p.flown);
        out.readbacks.push({ callsign: ac.callsign, issued: p.issued, flown: p.flown, text, t: st.t });
        out.comms.push({ t: st.t, from: ac.callsign, to: ac.owner, text, kind: 'readback' });
      }
    }

    // Kinematics
    const remove = new Set<string>();
    for (const ac of st.aircraft) {
      const res = stepAircraft(ac, dt, st.wind);
      if (res.landed) {
        remove.add(ac.id);
        out.landed.push(ac.callsign);
        st.landed.push({ callsign: ac.callsign, runway: ac.runway ?? '', t: st.t, wake: ac.wake });
        out.comms.push({ t: st.t, from: 'TWR', to: ac.callsign, text: `${ac.callsign} landed runway ${ac.runway}`, kind: 'system' });
      } else if (Math.hypot(ac.x, ac.y) > AIRSPACE_RADIUS + 2 && ac.kind !== 'arrival') {
        remove.add(ac.id);
        out.exited.push(ac.callsign);
      } else if (Math.hypot(ac.x, ac.y) > AIRSPACE_RADIUS + 30) {
        remove.add(ac.id);
        out.exited.push(ac.callsign);
      }
    }
    if (remove.size) st.aircraft = st.aircraft.filter((a) => !remove.has(a.id));
    if (st.landed.length > 400) st.landed.splice(0, st.landed.length - 400);
    return out;
  }

  /** Physics-only fingerprint used by the replay test. */
  hash(): string {
    let h = 2166136261;
    const s = this.state.aircraft.map((a) => `${a.callsign}:${a.x.toFixed(6)},${a.y.toFixed(6)},${a.alt.toFixed(3)},${a.hdg.toFixed(4)},${a.ias.toFixed(4)},${a.phase}`).join('|') + `@${this.state.t}`;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16);
  }

  runwayClearances(): RunwayClearance[] {
    const out: RunwayClearance[] = [];
    for (const a of this.state.aircraft) {
      if (a.rwyClr && (a.phase === 'holding-short' || a.phase === 'lineup' || a.phase === 'takeoff')) out.push(a.rwyClr);
      if (a.phase === 'approach' && a.runway) out.push({ flight: a.callsign, runway: a.runway, kind: 'land' });
    }
    return out;
  }
}

/** Published flight view (what the console and agents see). */
export function toFlight(ac: Aircraft, extra?: Partial<Flight>): Flight {
  return {
    id: ac.id, callsign: ac.callsign, type: ac.type, wake: ac.wake,
    pos: { x: ac.x, y: ac.y }, alt: Math.round(ac.alt), gs: Math.round(ac.gs), trk: Math.round(ac.trk), vs: ac.vs,
    squawk: ac.squawk, owner: ac.owner, cleared: { ...ac.cleared }, plan: ac.plan, kind: ac.kind, phase: ac.phase,
    runway: ac.runway, nordo: ac.nordo || undefined, ...extra,
  };
}

/** Track agent output: raw surveillance frame with radar noise and occasional dropouts. */
export function rawFrame(world: World, noise: RngState): RawFrame {
  const tracks = world.aircraft.map((a) => {
    const ground = onGround(a);
    const n = ground ? 0 : 0.03;
    return {
      id: a.id, callsign: a.callsign,
      x: a.x + (next(noise) - 0.5) * 2 * n, y: a.y + (next(noise) - 0.5) * 2 * n,
      alt: Math.round(a.alt), gs: a.gs, trk: a.trk, vs: a.vs, squawk: a.squawk, onGround: ground,
    };
  });
  return { t: world.t, tick: world.tick, tracks, runwayClearances: world.runwayClearances() };
}
