// Terminal Sequencer (every 30 s, immediately on emergencies): final sequence per runway with
// RECAT wake spacing; approach clearances when a slot is available; departure releases.
import { DEPARTURE_RUNWAY, FIXES, RUNWAYS, finalZone } from '../shared/airspace';
import { dist } from '../shared/geo';
import type { Advisory, PositionId, Wake } from '../shared/types';
import type { Aircraft } from '../sim/world';
import type { WindLayer } from '../sim/scenario';
import { predict, type Trajectory } from './trajectory';
import { landingInterval } from './centerFlow';

export const SEQ_MODEL = 'seq-cs-1.0.3';

export type SequencerInput = {
  aircraft: Aircraft[];
  trajs: Map<string, Trajectory>;
  wind: WindLayer[];
  now: number;
  frozenSta: Record<string, number>;
  sta: Record<string, number>;
  owner: (cs: string) => PositionId;
  emergencies: Set<string>;
  lastTakeoffT: number;
};

export class SequencerAgent {
  readonly id = 'sequencer' as const;
  sequence: Record<string, number> = {};

  run(inp: SequencerInput): Advisory[] {
    const out: Advisory[] = [];
    this.sequence = {};
    const landTimes: Record<string, { t: number; wake: Wake }[]> = {};
    for (const rwyId of Object.keys(RUNWAYS)) {
      const rwy = RUNWAYS[rwyId];
      const base = FIXES[rwy.base].pos;
      const cleared = inp.aircraft
        .filter((a) => a.runway === rwyId && (a.phase === 'approach' || a.pending.some((p) => p.issued.approach)))
        .map((a) => ({ a, t: inp.trajs.get(a.callsign)?.landT ?? inp.frozenSta[a.callsign] ?? inp.now }))
        .sort((p, q) => p.t - q.t);
      landTimes[rwyId] = cleared.map((c) => ({ t: c.t, wake: c.a.wake }));
      const candidates = inp.aircraft
        .filter((a) => a.kind === 'arrival' && a.runway === rwyId && a.phase === 'airborne' && !a.nordo && !a.pending.some((p) => p.issued.approach))
        .filter((a) => a.nav.mode === 'hold' || (dist(a, base) < 45 && a.alt <= 14000) || (inp.emergencies.has(a.callsign) && Math.hypot(a.x, a.y) < 40))
        .map((a) => ({ a, pred: predict(a, inp.wind, inp.now, { clearance: { flight: a.callsign, approach: rwyId } }) }))
        .filter((c) => c.pred.landT !== undefined)
        // Emergencies first, then whoever can land soonest if cleared now.
        .sort((p, q) => Number(inp.emergencies.has(q.a.callsign)) - Number(inp.emergencies.has(p.a.callsign)) || p.pred.landT! - q.pred.landT!);
      let n = 0;
      for (const c of cleared) this.sequence[c.a.callsign] = ++n;
      for (const c of candidates) this.sequence[c.a.callsign] = ++n;
      if (!candidates.length) continue;
      const { a: next, pred } = candidates[0];
      const emergency = inp.emergencies.has(next.callsign);
      if (pred.landT === undefined) continue;
      const last = cleared[cleared.length - 1];
      const required = last ? last.t + landingInterval(last.a.wake, next.type, next.wake) : -Infinity;
      if (!emergency && pred.landT < required) continue;
      out.push({
        id: '', key: `seq:app:${next.callsign}:${rwyId}`, source: 'sequencer', position: inp.owner(next.callsign), flights: [next.callsign],
        action: [{ flight: next.callsign, approach: rwyId }],
        rationale: {
          rule: emergency ? 'FR-EMG-01 priority handling' : 'FR-SEQ-01 wake-spaced final sequence',
          text: emergency
            ? `${next.callsign} is an emergency: number 1 for runway ${rwyId}, clear the approach now`
            : `${next.callsign} is number ${cleared.length + 1} for ${rwyId}; landing ${last ? `${Math.round(pred.landT - last.t)} s behind ${last.a.callsign}` : 'with no traffic ahead'} meets wake spacing`,
          inputs: { landT: Math.round(pred.landT), requiredT: Number.isFinite(required) ? Math.round(required) : 0, number: cleared.length + 1 },
        },
        predicted: { minSepNm: 99, delaySec: Math.max(0, Math.round(pred.landT - (inp.sta[next.callsign] ?? pred.landT))) },
        confidence: 0.85, priority: emergency ? 4 : 5, authority: 1, createdAt: inp.now, expiresAt: inp.now + 90, modelVersion: SEQ_MODEL,
      });
    }

    // Departure release from the departure runway.
    const queue = inp.aircraft.filter((a) => a.phase === 'holding-short' && !a.rwyClr).sort((p, q) => p.spawnT - q.spawnT);
    const busy = inp.aircraft.some((a) => a.phase === 'lineup' || a.phase === 'takeoff' || (a.phase === 'holding-short' && a.rwyClr));
    const dep = queue[0];
    if (dep && !busy && inp.now - inp.lastTakeoffT >= 60) {
      const arrivalsSoon = (landTimes[DEPARTURE_RUNWAY] ?? []).some((l) => l.t > inp.now - 10 && l.t < inp.now + 120);
      const onShortFinal = inp.aircraft.some((a) => finalZone(a) === DEPARTURE_RUNWAY && a.phase === 'approach' && dist(a, RUNWAYS[DEPARTURE_RUNWAY].thr) < 5);
      if (!arrivalsSoon && !onShortFinal) {
        out.push({
          id: '', key: `seq:dep:${dep.callsign}`, source: 'sequencer', position: inp.owner(dep.callsign), flights: [dep.callsign],
          action: [{ flight: dep.callsign, takeoff: DEPARTURE_RUNWAY }],
          rationale: { rule: 'FR-SEQ-01 departure release', text: `Gap of at least 2 min before the next ${DEPARTURE_RUNWAY} arrival: release ${dep.callsign}`, inputs: { queue: queue.length } },
          predicted: { minSepNm: 99, delaySec: 0 }, confidence: 0.85, priority: 5, authority: 1, createdAt: inp.now, expiresAt: inp.now + 45, modelVersion: SEQ_MODEL,
        });
      }
    }
    return out;
  }
}
