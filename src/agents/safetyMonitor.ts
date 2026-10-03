// Safety Monitor (runtime assurance, Simplex pattern).
// A minimal, separately written probe that re-checks every proposal before it can reach a console.
// It does NOT reuse the sim kinematics or the Trajectory agent: constant ground speed, standard-rate
// turns toward the intended heading/fix, constant climb/descent rates. A proposal is dropped if it
// creates a loss of separation (or makes an existing one worse) within 10 minutes, or busts terrain.
import { BASE_ALT, FAF_ALT, FIELD_ELEV, FIXES, RUNWAYS, horizontalMinimum, pairExempt, perfOf, terrainMsa } from '../shared/airspace';
import type { Advisory, AgentId, Clearance } from '../shared/types';
import { approachViaBase, type Aircraft } from '../sim/world';

const H = 600; // s
const DT = 6; // s

type MP = { x: number; y: number; alt: number; on: boolean };

export function monitorProject(ac: Aircraft, change?: Clearance): MP[] {
  const pts: MP[] = [];
  if (ac.phase === 'holding-short' || ac.phase === 'lineup') {
    if (!change?.takeoff) {
      for (let t = 0; t <= H; t += DT) pts.push({ x: ac.x, y: ac.y, alt: ac.alt, on: false });
      return pts;
    }
  }
  const perf = perfOf(ac.type);
  let x = ac.x, y = ac.y, alt = ac.alt, hdg = ac.hdg;
  let gs = Math.max(ac.gs, 140);
  let tAlt = ac.tAlt;
  let mode = ac.nav.mode as string;
  let vecHdg = ac.nav.hdg;
  let fixes: string[] = [];
  if (mode === 'route') fixes = ac.plan.route.slice(ac.routeIdx);
  if (mode === 'direct' && ac.nav.direct) fixes = [ac.nav.direct];
  let holdFix = mode === 'hold' ? ac.nav.direct : undefined;
  let rwy = ac.runway;
  let leg: number = ac.nav.leg ?? 0;
  // Pending clearances and the proposal are assumed to take effect ~5 s from now.
  const due = ac.pending.map((p) => p.issued);
  if (change) due.push(change);
  let landed = false;
  for (let t = 0; t <= H; t += DT) {
    if (t === DT) {
      for (const c of due) {
        if (c.alt !== undefined) tAlt = c.alt;
        if (c.hdg !== undefined) { mode = 'heading'; vecHdg = c.hdg; }
        if (c.direct) { mode = 'direct'; fixes = [c.direct]; }
        if (c.approach) {
          mode = 'approach'; rwy = c.approach;
          leg = approachViaBase(ac, c.approach) ? -1 : 0;
        }
        if (c.resume) { mode = 'route'; fixes = ac.plan.route.slice(ac.routeIdx); }
        if (c.spd !== undefined) gs = Math.max(140, gs + (c.spd - ac.ias));
        if (c.takeoff) { mode = 'route'; fixes = ac.plan.route.slice(ac.routeIdx); tAlt = ac.cleared.alt ?? 10000; }
      }
    }
    if (landed) { pts.push({ x, y, alt: FIELD_ELEV, on: false }); continue; }
    pts.push({ x, y, alt, on: alt > FIELD_ELEV + 300 });
    // lateral target
    let want = hdg;
    let orbit = false;
    if (mode === 'heading' && vecHdg !== undefined) want = vecHdg;
    else if ((mode === 'route' || mode === 'direct') && fixes.length) {
      const p = FIXES[fixes[0]]?.pos;
      if (p) {
        if (Math.hypot(p.x - x, p.y - y) < 1.5) {
          const passed = fixes.shift()!;
          if (!fixes.length && FIXES[passed]?.kind === 'base' && ac.kind === 'arrival') { mode = 'hold'; holdFix = passed; }
        } else want = (Math.atan2(p.x - x, p.y - y) * 180) / Math.PI;
      }
    } else if (mode === 'hold' && holdFix) {
      const p = FIXES[holdFix].pos;
      if (Math.hypot(p.x - x, p.y - y) > 4) want = (Math.atan2(p.x - x, p.y - y) * 180) / Math.PI;
      else orbit = true;
    } else if (mode === 'approach' && rwy) {
      const r = RUNWAYS[rwy];
      const b = FIXES[r.base].pos;
      if (leg === -1 && Math.hypot(b.x - x, b.y - y) < 2) leg = 0;
      if (leg === 0 && Math.hypot(r.faf.x - x, r.faf.y - y) < 2) leg = 1;
      const target = leg === -1 ? b : leg === 0 ? r.faf : r.thr;
      want = (Math.atan2(target.x - x, target.y - y) * 180) / Math.PI;
      if (leg === 1 && x <= r.thr.x) landed = true;
      tAlt = leg === -1 ? Math.min(alt, tAlt, BASE_ALT) : leg === 0 ? Math.min(alt, FAF_ALT) : Math.min(alt, FIELD_ELEV + 50 + Math.hypot(r.thr.x - x, r.thr.y - y) * 318);
      gs = leg === 1 ? Math.max(perf.vapp, gs - 1.2 * DT) : Math.max(leg === -1 ? 220 : 180, gs - 1.2 * DT);
    }
    let d = (((want - hdg) % 360) + 540) % 360 - 180;
    if (orbit) d = 3 * DT;
    hdg += Math.max(-3 * DT, Math.min(3 * DT, d));
    const rate = tAlt > alt ? perf.climb : perf.descent;
    const dAlt = Math.max(-(rate / 60) * DT, Math.min((rate / 60) * DT, tAlt - alt));
    alt += dAlt;
    const rad = (hdg * Math.PI) / 180;
    x += (Math.sin(rad) * gs * DT) / 3600;
    y += (Math.cos(rad) * gs * DT) / 3600;
  }
  return pts;
}

type PairCheck = { violates: boolean; worst: number };

function checkPair(a: MP[], b: MP[]): PairCheck {
  let worst = Infinity, violates = false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const p = a[i], q = b[i];
    if (!p.on || !q.on || pairExempt(p, q)) continue;
    const h = Math.hypot(p.x - q.x, p.y - q.y), v = Math.abs(p.alt - q.alt);
    const s = Math.max(h / horizontalMinimum(p, q), v / 1000);
    if (s < worst) worst = s;
    if (s < 1) violates = true;
  }
  return { violates, worst };
}

export type MonitorVerdict = { pass: boolean; reason?: string };

export class SafetyMonitor {
  private baseline = new Map<string, MP[]>();
  private rejections: { agent: AgentId; t: number }[] = [];
  suspendedUntil = new Map<AgentId, number>();
  rejectedTotal = new Map<AgentId, number>();
  escapes = 0;

  /** Called once per sweep with the current traffic picture. */
  begin(aircraft: Aircraft[]) {
    this.baseline.clear();
    for (const ac of aircraft) this.baseline.set(ac.callsign, monitorProject(ac));
  }

  check(adv: Advisory, aircraft: Map<string, Aircraft>, now: number): MonitorVerdict {
    const changed = new Map<string, MP[]>();
    for (const c of adv.action) {
      const ac = aircraft.get(c.flight);
      if (!ac) return { pass: false, reason: `unknown flight ${c.flight}` };
      if (ac.nordo) return { pass: false, reason: `${c.flight} is NORDO` };
      if (c.alt !== undefined && !c.approach && c.alt < terrainMsa(ac) && ac.phase !== 'approach') return { pass: false, reason: `altitude ${c.alt} below terrain minimum` };
      changed.set(c.flight, monitorProject(ac, c));
    }
    for (const [cs, traj] of changed) {
      const ac = aircraft.get(cs)!;
      if (traj.some((p) => p.on && p.alt < terrainMsa(p) - 100 && ac.phase === 'airborne' && !adv.action.some((a) => a.approach))) {
        return { pass: false, reason: `${cs} predicted below terrain minimum` };
      }
      for (const [other, otherBase] of this.baseline) {
        if (other === cs) continue;
        const otherTraj = changed.get(other) ?? otherBase;
        const withC = checkPair(traj, otherTraj);
        if (!withC.violates) continue;
        const without = checkPair(this.baseline.get(cs) ?? traj, otherBase);
        if (!without.violates || withC.worst < without.worst - 0.02) {
          return { pass: false, reason: `${cs} vs ${other}: ${without.violates ? 'worsens' : 'creates'} loss of separation` };
        }
      }
    }
    void now;
    return { pass: true };
  }

  /** Filters proposals; records rejections and suspends agents with repeated unsafe proposals. */
  filter(proposals: Advisory[], aircraft: Map<string, Aircraft>, now: number, log: (adv: Advisory, reason: string) => void): Advisory[] {
    const out: Advisory[] = [];
    for (const p of proposals) {
      if ((this.suspendedUntil.get(p.source) ?? -1) > now) continue;
      const v = this.check(p, aircraft, now);
      if (v.pass) { out.push(p); continue; }
      log(p, v.reason ?? 'unsafe');
      this.rejectedTotal.set(p.source, (this.rejectedTotal.get(p.source) ?? 0) + 1);
      this.rejections.push({ agent: p.source, t: now });
    }
    this.rejections = this.rejections.filter((r) => r.t > now - 60);
    for (const agent of new Set(this.rejections.map((r) => r.agent))) {
      if (this.rejections.filter((r) => r.agent === agent).length > 12) {
        this.suspendedUntil.set(agent, now + 120);
        this.rejections = this.rejections.filter((r) => r.agent !== agent);
      }
    }
    return out;
  }

  isSuspended(agent: AgentId, now: number) {
    return (this.suspendedUntil.get(agent) ?? -1) > now;
  }
}
