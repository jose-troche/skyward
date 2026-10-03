// Sector agents (CTR-NW, CTR-SE, APP, TWR): own flights per position, draft handoffs 3-5 min
// before the boundary, and add position-level advice (emergency handling, climb to requested altitude).
import { BASE_ALT, CORRIDOR_ALT, RUNWAYS, TRACON_RADIUS, geoSector } from '../shared/airspace';
import type { Advisory, Handoff, PositionId } from '../shared/types';
import type { Aircraft } from '../sim/world';
import type { Trajectory } from './trajectory';

export const SECTOR_MODEL = 'sector-1.1.0';
export const HANDOFF_LOOKAHEAD = 300; // s
export const SILENT_CONSENT = 10; // s (authority level 2)

export type SectorInput = {
  aircraft: Aircraft[];
  trajs: Map<string, Trajectory>;
  now: number;
  handoffs: Record<string, Handoff>;
  emergencies: Set<string>;
};

/**
 * Handoff target for a flight: the next position along its predicted path within the look-ahead.
 * If the flight already sits in another position's airspace without a handoff, target that one now.
 */
export function nextSector(ac: Aircraft, traj: Trajectory | undefined): { to: PositionId; inSec: number } | undefined {
  if (!traj) return undefined;
  const g0 = geoSector(traj.points[0], traj.points[0].alt);
  if (ac.owner !== g0) {
    // Accepted early: the owner is the sector the flight is about to enter.
    for (const p of traj.points) {
      if (p.t - traj.points[0].t > HANDOFF_LOOKAHEAD) break;
      if (geoSector(p, p.alt) === ac.owner) return undefined;
    }
    return { to: g0, inSec: 0 };
  }
  for (const p of traj.points) {
    if (p.t - traj.points[0].t > HANDOFF_LOOKAHEAD) break;
    const s = geoSector(p, p.alt);
    if (s !== g0) return { to: s, inSec: Math.round(p.t - traj.points[0].t) };
  }
  return undefined;
}

export class SectorAgent {
  readonly id = 'sector' as const;

  /** Drafts (or retracts) handoffs. Returns the handoffs that changed. */
  draftHandoffs(inp: SectorInput): Handoff[] {
    const changed: Handoff[] = [];
    for (const ac of inp.aircraft) {
      if (ac.phase === 'holding-short' || ac.phase === 'lineup') continue;
      const cur = inp.handoffs[ac.callsign];
      const ns = nextSector(ac, inp.trajs.get(ac.callsign));
      if (!ns) {
        if (cur && cur.state === 'proposed' && geoSector(ac, ac.alt) === ac.owner) { delete inp.handoffs[ac.callsign]; changed.push({ ...cur, state: 'rejected' }); }
        continue;
      }
      if (cur && cur.state === 'proposed' && cur.to === ns.to) { cur.crossInSec = ns.inSec; continue; }
      const h: Handoff = { flight: ac.callsign, from: ac.owner, to: ns.to, state: 'proposed', at: inp.now, crossInSec: ns.inSec };
      inp.handoffs[ac.callsign] = h;
      changed.push(h);
    }
    for (const cs of Object.keys(inp.handoffs)) if (!inp.aircraft.some((a) => a.callsign === cs)) delete inp.handoffs[cs];
    return changed;
  }

  advise(inp: SectorInput, owner: (cs: string) => PositionId): Advisory[] {
    const out: Advisory[] = [];
    for (const ac of inp.aircraft) {
      if (ac.phase !== 'airborne' || ac.nordo) continue;
      // Emergency: descent to the requested altitude and toward the airport.
      if (inp.emergencies.has(ac.callsign) && ac.squawk === '7700') {
        const alt = ac.requestedAlt ?? Math.max(6000, Math.round((ac.alt - 4000) / 1000) * 1000);
        const rwy = RUNWAYS[ac.runway ?? (ac.y >= 0 ? '27R' : '27L')];
        const action = [{ flight: ac.callsign, ...(ac.tAlt > alt ? { alt } : {}), ...(ac.nav.mode !== 'hold' && ac.nav.direct !== rwy.base ? { direct: rwy.base } : {}) }];
        if (Object.keys(action[0]).length > 1) {
          out.push({
            id: '', key: `sector:emerg:${ac.callsign}:${JSON.stringify(action[0])}`, source: 'sector', position: owner(ac.callsign), flights: [ac.callsign], action,
            rationale: { rule: 'FR-EMG-01 emergency priority', text: `${ac.callsign} declared an emergency and requested descent; descend and route direct ${rwy.base} for runway ${rwy.id}`, inputs: { requestedAlt: alt } },
            predicted: { minSepNm: 99, delaySec: 0 }, confidence: 0.9, priority: 4, authority: 1, createdAt: inp.now, expiresAt: inp.now + 120, modelVersion: SECTOR_MODEL,
          });
        }
      }
      // Arrivals left high (e.g. after a level-off resolution): re-clear the descent profile.
      if (ac.kind === 'arrival' && !ac.pending.length && ac.nav.mode !== 'approach') {
        const r = Math.hypot(ac.x, ac.y);
        const profile = r > TRACON_RADIUS ? CORRIDOR_ALT : BASE_ALT;
        if (ac.tAlt > profile + 500 && !ac.descendVia) {
          out.push({
            id: '', key: `sector:desc:${ac.callsign}:${profile}`, source: 'sector', position: owner(ac.callsign), flights: [ac.callsign],
            action: [{ flight: ac.callsign, alt: profile }],
            rationale: { rule: 'Arrival descent profile', text: `${ac.callsign} is above the arrival profile; descend to ${profile.toLocaleString('en-US')} to reach the ${r > TRACON_RADIUS ? 'corridor' : 'base fix'} on profile`, inputs: { profile, cleared: ac.tAlt } },
            predicted: { minSepNm: 99, delaySec: 0 }, confidence: 0.85, priority: 5, authority: 1, createdAt: inp.now, expiresAt: inp.now + 90, modelVersion: SECTOR_MODEL,
          });
        }
      }
      // Efficiency: departures in en route airspace climb to their requested altitude.
      if (ac.kind === 'departure' && ac.requestedAlt && (ac.cleared.alt ?? 0) < ac.requestedAlt && (ac.owner === 'CTR-NW' || ac.owner === 'CTR-SE') && !ac.pending.length) {
        out.push({
          id: '', key: `sector:climb:${ac.callsign}:${ac.requestedAlt}`, source: 'sector', position: owner(ac.callsign), flights: [ac.callsign],
          action: [{ flight: ac.callsign, alt: ac.requestedAlt }],
          rationale: { rule: 'Efficiency: requested altitude', text: `${ac.callsign} is clear of arrival flows; climb to requested ${ac.requestedAlt / 100 >= 180 ? `FL${ac.requestedAlt / 100}` : ac.requestedAlt} saves fuel`, inputs: { requestedAlt: ac.requestedAlt } },
          predicted: { minSepNm: 99, delaySec: 0 }, confidence: 0.8, priority: 6, authority: 1, createdAt: inp.now, expiresAt: inp.now + 120, modelVersion: SECTOR_MODEL,
        });
      }
    }
    return out;
  }
}

/** Frequency-change phraseology drafted by the transferring sector. */
export function frequencyChange(callsign: string, to: PositionId): string {
  const f: Record<PositionId, string> = { 'CTR-NW': 'Atlanta Center 134.35', 'CTR-SE': 'Atlanta Center 132.97', APP: 'Atlanta Approach 127.25', TWR: 'Atlanta Tower 119.1' };
  return `${callsign}, contact ${f[to]}`;
}

