// Separation Assurance agent: pairwise probe over the 20-min predicted trajectories
// (3 NM terminal / 5 NM en route, 1,000 ft) and ranked vector, altitude and speed resolutions.
import { FIELD_ELEV, RUNWAYS, horizontalMinimum, pairExempt, perfOf, terrainMsa } from '../shared/airspace';
import { round, norm360 } from '../shared/geo';
import { formatCommand } from '../shared/commands';
import type { Advisory, Clearance, PositionId } from '../shared/types';
import type { Aircraft } from '../sim/world';
import type { WindLayer } from '../sim/scenario';
import { predict, type Trajectory, type PredPoint } from './trajectory';

export const MODEL_VERSION = 'sep-probe-1.2.0';
export const RESOLUTION_MARGIN = 1.15;
export const ACTION_HORIZON = 480; // s: conflicts are detected 20 min out, resolutions proposed inside 8 min

export type Conflict = { key: string; a: string; b: string; tLos: number; minH: number; minV: number; atLos: { h: number; v: number } };

function airborne(p: PredPoint) {
  return !p.ground && p.alt > FIELD_ELEV + 300;
}

/** Separation score along two trajectories: min over time of max(h / hMin, v / 1000). < 1 means loss of separation. */
export function pairScore(a: Trajectory, b: Trajectory): { score: number; tLos?: number; minH: number; minV: number } {
  const n = Math.min(a.points.length, b.points.length);
  let score = Infinity, minH = Infinity, minV = Infinity;
  let tLos: number | undefined;
  for (let i = 0; i < n; i++) {
    const pa = a.points[i], pb = b.points[i];
    if (!airborne(pa) || !airborne(pb)) continue;
    if (pairExempt(pa, pb)) continue;
    const h = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    const v = Math.abs(pa.alt - pb.alt);
    const hMin = horizontalMinimum(pa, pb);
    const s = Math.max(h / hMin, v / 1000);
    if (s < score) score = s;
    if (v < 1000 && h < minH) minH = h;
    if (h < hMin && v < minV) minV = v;
    if (h < hMin && v < 1000 && tLos === undefined) tLos = pa.t;
  }
  return { score, tLos, minH, minV };
}

export function probe(trajs: Map<string, Trajectory>): Conflict[] {
  const list = [...trajs.values()];
  const out: Conflict[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const p0a = a.points[0], p0b = b.points[0];
      // quick reject: farther apart than 2 x 20 min at 600 kt or never vertically close
      if (Math.hypot(p0a.x - p0b.x, p0a.y - p0b.y) > 400) continue;
      const s = pairScore(a, b);
      if (s.tLos === undefined) continue;
      const [x, y] = [a.callsign, b.callsign].sort();
      out.push({ key: `sep:${x}-${y}`, a: x, b: y, tLos: s.tLos, minH: s.minH, minV: s.minV, atLos: { h: s.minH, v: s.minV } });
    }
  }
  return out.sort((p, q) => p.tLos - q.tLos);
}

type Candidate = { clearance: Clearance; kind: 'alt' | 'hdg' | 'spd'; cost: number; delaySec: number };

function candidates(ac: Aircraft): Candidate[] {
  const out: Candidate[] = [];
  const perf = perfOf(ac.type);
  const baseAlt = round(ac.tAlt, 1000);
  const floor = Math.max(terrainMsa(ac) + 1000, 3000);
  for (const d of [1000, -1000, 2000, -2000]) {
    const alt = baseAlt + d;
    if (alt < floor || alt > 41000) continue;
    if (ac.kind === 'arrival' && d > 0 && Math.hypot(ac.x, ac.y) < 60) continue;
    out.push({ clearance: { flight: ac.callsign, alt }, kind: 'alt', cost: Math.abs(d) / 1000 * 30 + (d > 0 && ac.kind === 'arrival' ? 40 : 0), delaySec: Math.abs(d) / 1000 * 10 });
  }
  // level off at the nearest thousand when climbing or descending
  if (Math.abs(ac.vs) > 300) {
    const alt = ac.vs > 0 ? Math.ceil(ac.alt / 1000) * 1000 : Math.floor(ac.alt / 1000) * 1000;
    if (alt >= floor && alt !== baseAlt) out.push({ clearance: { flight: ac.callsign, alt }, kind: 'alt', cost: 15, delaySec: 20 });
  }
  for (const d of [20, -20, 30, -30, 45, -45]) {
    const hdg = norm360(round(ac.hdg + d, 5)) || 360;
    out.push({ clearance: { flight: ac.callsign, hdg }, kind: 'hdg', cost: Math.abs(d) * 1.5 + 20, delaySec: Math.round(Math.abs(d) * 2.5) });
  }
  if (ac.ias - 40 >= perf.vmin) out.push({ clearance: { flight: ac.callsign, spd: round(ac.ias - 40, 10) }, kind: 'spd', cost: 50, delaySec: 60 });
  return out;
}

export function maneuverable(ac: Aircraft | undefined): ac is Aircraft {
  return !!ac && !ac.nordo && ac.phase === 'airborne' && ac.alt > FIELD_ELEV + 1500;
}

export type SeparationInput = {
  aircraft: Map<string, Aircraft>;
  trajs: Map<string, Trajectory>;
  wind: WindLayer[];
  now: number;
  owner: (callsign: string) => PositionId;
  existing: Advisory[]; // separation advisories still active in the arbiter pool
};

export class SeparationAgent {
  readonly id = 'separation' as const;
  lastConflicts: Conflict[] = [];

  run(inp: SeparationInput): Advisory[] {
    const conflicts = probe(inp.trajs);
    this.lastConflicts = conflicts;
    const out: Advisory[] = [];
    for (const c of conflicts) {
      if (c.tLos - inp.now > ACTION_HORIZON) continue;
      // Keep still-valid advisories for this conflict instead of churning new ones every sweep.
      const kept = inp.existing.filter((a) => a.group === c.key && this.stillResolves(a, inp));
      if (kept.length) { out.push(...kept); continue; }
      out.push(...this.resolve(c, inp));
    }
    out.push(...this.returnToRoute(conflicts, inp));
    return out;
  }

  /** Vectored flights clear of conflict are sent back on their route (direct to the next fix). */
  private returnToRoute(conflicts: Conflict[], inp: SeparationInput): Advisory[] {
    const out: Advisory[] = [];
    const inConflict = new Set(conflicts.filter((c) => c.tLos - inp.now <= ACTION_HORIZON).flatMap((c) => [c.a, c.b]));
    for (const ac of inp.aircraft.values()) {
      if (!maneuverable(ac) || ac.nav.mode !== 'heading' || ac.pending.length || inConflict.has(ac.callsign)) continue;
      const base = ac.kind === 'arrival' && ac.runway ? RUNWAYS[ac.runway].base : undefined;
      // Inside the TRACON an arrival rejoins at its base fix rather than turning back to the corridor.
      const fix = base && Math.hypot(ac.x, ac.y) < 40 ? base : ac.plan.route[ac.routeIdx] ?? base;
      if (!fix) continue;
      const clearance: Clearance = { flight: ac.callsign, direct: fix };
      const ev = this.evaluate(ac, clearance, inp);
      if (ev.score < RESOLUTION_MARGIN) continue;
      out.push({
        id: '', key: `sep:resume:${ac.callsign}:${fix}`, source: 'separation', position: inp.owner(ac.callsign), flights: [ac.callsign], action: [clearance],
        rationale: { rule: 'Return to route after vector', text: `${ac.callsign} is clear of conflicting traffic; direct ${fix} rejoins the route with no conflict for 20 min`, inputs: { predictedScore: round(Math.min(ev.score, 99), 0.01) } },
        predicted: { minSepNm: ev.minH === Infinity ? 99 : round(ev.minH, 0.1), delaySec: 0 }, confidence: 0.85, priority: 3, authority: 1,
        createdAt: inp.now, expiresAt: inp.now + 120, modelVersion: MODEL_VERSION,
      });
    }
    return out;
  }

  private stillResolves(adv: Advisory, inp: SeparationInput): boolean {
    const cl = adv.action[0];
    const ac = inp.aircraft.get(cl.flight);
    if (!maneuverable(ac)) return false;
    return this.evaluate(ac, cl, inp).score >= RESOLUTION_MARGIN;
  }

  private evaluate(ac: Aircraft, clearance: Clearance, inp: SeparationInput) {
    const traj = predict(ac, inp.wind, inp.now, { clearance });
    let score = Infinity, minH = Infinity;
    for (const [cs, other] of inp.trajs) {
      if (cs === ac.callsign) continue;
      const s = pairScore(traj, other);
      if (s.score < score) score = s.score;
      if (s.minH < minH) minH = s.minH;
    }
    return { score, minH };
  }

  resolve(c: Conflict, inp: SeparationInput): Advisory[] {
    const A = inp.aircraft.get(c.a), B = inp.aircraft.get(c.b);
    const ranked: { cand: Candidate; score: number; minH: number; ac: Aircraft; total: number }[] = [];
    for (const ac of [A, B]) {
      if (!maneuverable(ac)) continue;
      const emergencyPenalty = ac.squawk === '7700' ? 1000 : 0;
      for (const cand of candidates(ac)) {
        const ev = this.evaluate(ac, cand.clearance, inp);
        if (ev.score < RESOLUTION_MARGIN) continue;
        ranked.push({ cand, score: ev.score, minH: ev.minH, ac, total: cand.cost + emergencyPenalty - Math.min(ev.score, 3) * 5 });
      }
    }
    ranked.sort((p, q) => p.total - q.total);
    // Top two, preferring two different maneuver types.
    const picks: typeof ranked = [];
    for (const r of ranked) {
      if (picks.length === 0 || (picks.length === 1 && r.cand.kind !== picks[0].cand.kind)) picks.push(r);
      if (picks.length === 2) break;
    }
    if (picks.length === 1 && ranked.length > 1) picks.push(ranked.find((r) => r !== picks[0])!);
    return picks.map((p, i) => {
      const other = p.ac.callsign === c.a ? c.b : c.a;
      const cmd = formatCommand(p.cand.clearance, p.ac.alt);
      const losIn = Math.max(0, Math.round(c.tLos - inp.now));
      return {
        id: '', key: `${c.key}:${cmd}`, group: c.key, source: 'separation', position: inp.owner(p.ac.callsign),
        flights: [p.ac.callsign, other], action: [p.cand.clearance],
        rationale: {
          rule: 'FR-SEP-02 ranked resolution',
          text: `${p.ac.callsign} and ${other} lose separation in ${fmtSec(losIn)}; ${cmd} keeps ${p.minH === Infinity ? '1,000 ft' : `${p.minH.toFixed(1)} NM`} (rank ${i + 1})`,
          inputs: { losInSec: losIn, minSepNow: round(c.minH === Infinity ? 0 : c.minH, 0.1), predictedScore: round(p.score, 0.01), rank: i + 1 },
        },
        predicted: { minSepNm: p.minH === Infinity ? 99 : round(p.minH, 0.1), delaySec: p.cand.delaySec },
        confidence: i === 0 ? 0.9 : 0.8, priority: 2, authority: 1,
        createdAt: inp.now, expiresAt: inp.now + Math.max(60, Math.min(180, losIn)), modelVersion: MODEL_VERSION,
      } satisfies Advisory;
    });
  }
}

export function fmtSec(s: number): string {
  const m = Math.floor(s / 60), r = Math.round(s % 60);
  return m ? `${m} min ${r.toString().padStart(2, '0')} s` : `${r} s`;
}
