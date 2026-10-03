// Center Flow agent (every 30 s): time-based metering. Assigns runway times (STA) with wake
// spacing and proposes en route speed reductions to absorb delay before the TRACON.
import { FIXES, RUNWAYS, TRACON_RADIUS, perfOf, wakeSpacing } from '../shared/airspace';
import { dist } from '../shared/geo';
import type { Advisory, PositionId, Wake } from '../shared/types';
import type { Aircraft } from '../sim/world';
import type { Trajectory } from './trajectory';

export const FLOW_MODEL = 'tbfm-lite-0.9.1';

export function landingInterval(leader: Wake, followerType: string, followerWake: Wake): number {
  return Math.round((wakeSpacing(leader, followerWake) * 3600) / perfOf(followerType).vapp) + 20;
}

/** ETA at the runway threshold: predicted landing, or time to base fix + nominal approach time. */
export function etaThreshold(ac: Aircraft, traj: Trajectory | undefined, now: number): number | undefined {
  if (traj?.landT) return traj.landT;
  if (!ac.runway || !traj) return undefined;
  const rwy = RUNWAYS[ac.runway];
  const base = FIXES[rwy.base].pos;
  const approachSec = ((dist(base, rwy.faf) + 8) / 175) * 3600;
  const atBase = traj.points.find((p) => dist(p, base) < 3);
  if (atBase) return atBase.t + approachSec;
  if (ac.nav.mode === 'hold') return now + approachSec;
  return undefined;
}

export type FlowInput = {
  aircraft: Aircraft[];
  trajs: Map<string, Trajectory>;
  now: number;
  frozenSta: Record<string, number>;
  owner: (cs: string) => PositionId;
  emergencies: Set<string>;
};

export class CenterFlowAgent {
  readonly id = 'centerFlow' as const;
  sta: Record<string, number> = {};

  run(inp: FlowInput): Advisory[] {
    const out: Advisory[] = [];
    this.sta = {};
    for (const rwyId of Object.keys(RUNWAYS)) {
      const arrivals = inp.aircraft
        .filter((a) => a.kind === 'arrival' && a.runway === rwyId && (a.phase === 'airborne' || a.phase === 'approach'))
        .map((a) => ({ a, eta: inp.frozenSta[a.callsign] ?? etaThreshold(a, inp.trajs.get(a.callsign), inp.now) }))
        .filter((x): x is { a: Aircraft; eta: number } => x.eta !== undefined)
        .sort((p, q) => Number(inp.emergencies.has(q.a.callsign)) - Number(inp.emergencies.has(p.a.callsign)) || p.eta - q.eta);
      let prev: { t: number; wake: Wake } | undefined;
      for (const { a, eta } of arrivals) {
        const frozen = inp.frozenSta[a.callsign];
        const sta = frozen ?? (prev ? Math.max(eta, prev.t + landingInterval(prev.wake, a.type, a.wake)) : eta);
        this.sta[a.callsign] = sta;
        prev = { t: sta, wake: a.wake };
        const delay = sta - eta;
        const r = Math.hypot(a.x, a.y);
        // Slowing one aircraft must not compress the stream behind it.
        const corridor = a.plan.route[0];
        const trailing = inp.aircraft.some((o) => o !== a && o.kind === 'arrival' && o.routeIdx === 0 && o.plan.route[0] === corridor && dist(o, a) < 60 && dist(o, FIXES[corridor]?.pos ?? o) > dist(a, FIXES[corridor]?.pos ?? a));
        if (!frozen && !trailing && a.routeIdx === 0 && r > TRACON_RADIUS + 10 && delay > 90 && a.ias > 265 && a.tSpd === undefined && !inp.emergencies.has(a.callsign)) {
          const spd = 250;
          out.push({
            id: '', key: `flow:spd:${a.callsign}:${spd}`, source: 'centerFlow', position: inp.owner(a.callsign), flights: [a.callsign],
            action: [{ flight: a.callsign, spd }],
            rationale: { rule: 'FR-SEQ-02 meter to STA', text: `${a.callsign} is ${Math.round(delay)} s early for its runway ${rwyId} slot; slowing to ${spd} kt absorbs it en route instead of holding`, inputs: { delaySec: Math.round(delay), eta: Math.round(eta), sta: Math.round(sta) } },
            predicted: { minSepNm: 99, delaySec: Math.round(delay) }, confidence: 0.75, priority: 5, authority: 1,
            createdAt: inp.now, expiresAt: inp.now + 120, modelVersion: FLOW_MODEL,
          });
        }
      }
    }
    return out;
  }
}
