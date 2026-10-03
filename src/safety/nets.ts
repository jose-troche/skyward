// Independent safety nets: conflict alert (CA), minimum safe altitude warning (MSAW),
// runway safety and emergency squawk alerting.
// Consumes only raw surveillance frames and runway clearance data. It never imports the
// sim world or any planning agent, so it keeps alerting with every agent switched off.
import { FIELD_ELEV, RUNWAYS, departureZone, finalZone, horizontalMinimum, pairExempt, terrainMsa } from '../shared/airspace';
import type { Alert, AlertKind, RawFrame, RawTrack } from '../shared/types';

export const CA_LOOKAHEAD_SEC = 120;
export const MSAW_LOOKAHEAD_SEC = 30;
const CA_STEP = 4;
const CLEAR_AFTER_FRAMES = 2;

type Candidate = { key: string; kind: AlertKind; flights: string[]; severity: 'caution' | 'warning'; text: string };
type Held = { alert: Alert; missed: number };

function project(t: RawTrack, sec: number) {
  const rad = (t.trk * Math.PI) / 180;
  const nm = (t.gs * sec) / 3600;
  return { x: t.x + Math.sin(rad) * nm, y: t.y + Math.cos(rad) * nm, alt: t.alt + (t.vs * sec) / 60 };
}

export function conflictAlerts(frame: RawFrame): Candidate[] {
  const out: Candidate[] = [];
  const air = frame.tracks.filter((t) => !t.onGround && t.alt > FIELD_ELEV + 300);
  for (let i = 0; i < air.length; i++) {
    for (let j = i + 1; j < air.length; j++) {
      const a = air[i], b = air[j];
      // Quick reject: too far apart to meet within the look-ahead.
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d0 > ((a.gs + b.gs) * CA_LOOKAHEAD_SEC) / 3600 + 6) continue;
      for (let s = 0; s <= CA_LOOKAHEAD_SEC; s += CA_STEP) {
        const pa = project(a, s), pb = project(b, s);
        if (pairExempt(pa, pb)) continue;
        const h = Math.hypot(pa.x - pb.x, pa.y - pb.y);
        const v = Math.abs(pa.alt - pb.alt);
        if (h < horizontalMinimum(pa, pb) && v < 1000) {
          const flights = [a.callsign, b.callsign].sort();
          out.push({
            key: `CA:${flights.join('-')}`, kind: 'CA', flights,
            severity: s <= 60 ? 'warning' : 'caution',
            text: s === 0 ? `Loss of separation ${flights.join(' / ')}: ${h.toFixed(1)} NM, ${Math.round(v)} ft` : `Conflict ${flights.join(' / ')} in ${s} s`,
          });
          break;
        }
      }
    }
  }
  return out;
}

export function msawAlerts(frame: RawFrame): Candidate[] {
  const out: Candidate[] = [];
  for (const t of frame.tracks) {
    if (t.onGround || t.alt < FIELD_ELEV + 200) continue;
    // Inhibit areas: final approach and departure climb-out corridors.
    if (finalZone(t) || departureZone(t)) continue;
    const msa = terrainMsa(t);
    const ahead = project(t, MSAW_LOOKAHEAD_SEC);
    const msaAhead = terrainMsa(ahead);
    if (t.alt < msa) out.push({ key: `MSAW:${t.callsign}`, kind: 'MSAW', flights: [t.callsign], severity: 'warning', text: `LOW ALTITUDE ${t.callsign}: ${Math.round(t.alt)} ft, minimum ${msa}` });
    else if (ahead.alt < msaAhead && t.vs < 0) out.push({ key: `MSAW:${t.callsign}`, kind: 'MSAW', flights: [t.callsign], severity: 'caution', text: `LOW ALTITUDE ${t.callsign}: predicted ${Math.round(ahead.alt)} ft, minimum ${msaAhead}` });
  }
  return out;
}

export function runwayAlerts(frame: RawFrame): Candidate[] {
  const out: Candidate[] = [];
  const byCs = new Map(frame.tracks.map((t) => [t.callsign, t]));
  for (const clr of frame.runwayClearances) {
    if (clr.kind === 'land') continue;
    const dep = byCs.get(clr.flight);
    if (!dep || !dep.onGround) continue;
    const rwy = RUNWAYS[clr.runway];
    if (!rwy) continue;
    for (const arr of frame.tracks) {
      if (arr.onGround || arr.callsign === dep.callsign) continue;
      if (finalZone(arr) !== clr.runway) continue;
      const d = Math.hypot(arr.x - rwy.thr.x, arr.y - rwy.thr.y);
      if (d <= 2.5 && arr.alt < FIELD_ELEV + 1500) {
        const flights = [dep.callsign, arr.callsign];
        out.push({ key: `RWY:${clr.runway}:${flights.join('-')}`, kind: 'RWY', flights, severity: 'warning', text: `RUNWAY ${clr.runway} OCCUPIED: ${dep.callsign} (${clr.kind}), ${arr.callsign} ${d.toFixed(1)} NM final` });
      }
    }
  }
  return out;
}

export function emergencyAlerts(frame: RawFrame): Candidate[] {
  const out: Candidate[] = [];
  for (const t of frame.tracks) {
    const label = t.squawk === '7700' ? 'EMERGENCY' : t.squawk === '7600' ? 'RADIO FAILURE' : t.squawk === '7500' ? 'HIJACK' : '';
    if (label) out.push({ key: `EMERG:${t.callsign}`, kind: 'EMERG', flights: [t.callsign], severity: t.squawk === '7600' ? 'caution' : 'warning', text: `${label} ${t.callsign} squawk ${t.squawk}` });
  }
  return out;
}

/** Stateful alert manager with hysteresis: an alert clears only after it is absent for 2 frames. */
export class SafetyNets {
  private held = new Map<string, Held>();
  private counter = 0;

  process(frame: RawFrame): { raised: Alert[]; updated: Alert[]; cleared: Alert[]; active: Alert[] } {
    const candidates = [...emergencyAlerts(frame), ...runwayAlerts(frame), ...conflictAlerts(frame), ...msawAlerts(frame)];
    const raised: Alert[] = [], updated: Alert[] = [], cleared: Alert[] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const h = this.held.get(c.key);
      if (h) {
        h.missed = 0;
        if (h.alert.severity !== c.severity || h.alert.text !== c.text) {
          h.alert = { ...h.alert, severity: h.alert.severity === 'warning' ? 'warning' : c.severity, text: c.text };
          updated.push(h.alert);
        }
      } else {
        const alert: Alert = { id: `${c.key}#${++this.counter}`, kind: c.kind, flights: c.flights, severity: c.severity, at: frame.t, text: c.text };
        this.held.set(c.key, { alert, missed: 0 });
        raised.push(alert);
      }
    }
    for (const [key, h] of this.held) {
      if (seen.has(key)) continue;
      if (++h.missed >= CLEAR_AFTER_FRAMES) {
        this.held.delete(key);
        cleared.push(h.alert);
      }
    }
    return { raised, updated, cleared, active: this.active() };
  }

  active(): Alert[] {
    return [...this.held.values()].map((h) => h.alert);
  }

  reset() {
    this.held.clear();
  }
}
