// Trajectory agent: 20-minute 4D prediction at 10 s steps from current state + cleared intent.
// Physics model = the same point-mass kinematics as the sim, fed with *issued* (not flown) clearances.
import { cloneAircraft, stepAircraft, applyClearance, type Aircraft } from '../sim/world';
import type { WindLayer } from '../sim/scenario';
import type { Clearance } from '../shared/types';

export const HORIZON_SEC = 1200;
export const PRED_STEP = 10;

export type PredPoint = { t: number; x: number; y: number; alt: number; ground: boolean };
export type Trajectory = { callsign: string; points: PredPoint[]; landT?: number };

export function predict(ac: Aircraft, wind: WindLayer[], now: number, extra?: { clearance: Clearance; delay?: number }, horizon = HORIZON_SEC): Trajectory {
  const sim = cloneAircraft(ac);
  const pending = sim.pending.map((p) => ({ at: p.applyAt, c: p.issued }));
  if (extra) pending.push({ at: now + (extra.delay ?? 5), c: extra.clearance });
  sim.pending = [];
  const points: PredPoint[] = [{ t: now, x: sim.x, y: sim.y, alt: sim.alt, ground: isGround(sim) }];
  let landT: number | undefined;
  for (let s = PRED_STEP; s <= horizon; s += PRED_STEP) {
    const t = now + s;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i].at <= t) { applyClearance(sim, pending[i].c); pending.splice(i, 1); }
    }
    // Expected approach: an arrival reaching its base fix is assumed cleared for the approach.
    if (sim.nav.mode === 'hold' && sim.kind === 'arrival' && sim.runway && !sim.nordo) applyClearance(sim, { flight: sim.callsign, approach: sim.runway });
    const res = stepAircraft(sim, PRED_STEP, wind);
    if (res.landed) { landT = t; break; }
    points.push({ t, x: sim.x, y: sim.y, alt: sim.alt, ground: isGround(sim) });
  }
  return { callsign: ac.callsign, points, landT };
}

function isGround(a: Aircraft): boolean {
  return a.phase === 'holding-short' || a.phase === 'lineup' || a.phase === 'takeoff';
}

export class TrajectoryAgent {
  readonly id = 'trajectory' as const;
  run(aircraft: Aircraft[], wind: WindLayer[], now: number): Map<string, Trajectory> {
    const out = new Map<string, Trajectory>();
    for (const ac of aircraft) out.set(ac.callsign, predict(ac, wind, now));
    return out;
  }
}
