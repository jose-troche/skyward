// SessionEngine: one simulated airspace session. Hosts the Sim World, Track agent and the
// planning agents (each isolated by try/catch), the Safety Monitor and the Arbiter.
// Pure TypeScript with no Cloudflare APIs: the Airspace DO wraps it, and Vitest drives it headless.
import { RUNWAYS, finalZone, geoSector, wakeSpacing } from '../shared/airspace';
import { dist } from '../shared/geo';
import { formatCommand } from '../shared/commands';
import {
  POSITIONS, STUB_AGENTS, TOGGLEABLE_AGENTS, type Advisory, type AgentId, type AgentStatus, type Alert, type Clearance, type CommsLine,
  type ConsolePosition, type Flight, type Handoff, type PositionId, type RawFrame, type RejectReason, type ServerMessage, type SimStatus, type TrafficLevel,
} from '../shared/types';
import { World, rawFrame, toFlight, type Aircraft, type WorldState } from '../sim/world';
import { makeRng, next, type RngState } from '../sim/rng';
import type { Scenario } from '../sim/scenario';
import { TrajectoryAgent, predict, type Trajectory } from '../agents/trajectory';
import { SeparationAgent, type Conflict } from '../agents/separation';
import { SafetyMonitor } from '../agents/safetyMonitor';
import { Arbiter, type ArbiterState } from '../agents/arbiter';
import { CenterFlowAgent } from '../agents/centerFlow';
import { SequencerAgent } from '../agents/sequencer';
import { SectorAgent, SILENT_CONSENT, frequencyChange } from '../agents/sector';
import { WorkloadAgent } from '../agents/workload';
import { DatalinkAgent } from '../agents/datalink';

export type LogEvent = { tick: number; t: number; kind: string; payload: Record<string, unknown> };
export type Actor = { position: ConsolePosition | 'AUTO' | 'SCENARIO'; name: string };

export type EngineState = {
  world: WorldState;
  scenarioName: string;
  arbiter: ArbiterState;
  handoffs: Record<string, Handoff>;
  enabled: Record<string, boolean>;
  frozenSta: Record<string, number>;
  sta: Record<string, number>;
  seq: Record<string, number>;
  readbackAlerts: Record<string, { alert: Alert; issued: Clearance; reissued: boolean }>;
  lastRun: { flow: number; seq: number; workload: number };
  lastTakeoffT: number;
  paused: boolean;
  speed: 1 | 2 | 4;
  combined: Partial<Record<PositionId, PositionId>>;
  autoUnstaffed: boolean;
  noise: RngState;
  serial: number;
  shownAt: Record<string, number>;
  metrics: {
    runwayErrors: { callsign: string; err: number }[];
    spacing: { leader: string; follower: string; runway: string; distNm: number; required: number }[];
    delivered: { id: string; t: number; source: AgentId; flights: string[]; action: Clearance[]; minSepNm: number }[];
    monitorRejections: number;
  };
};

const FLOW_PERIOD = 30;
const WORKLOAD_PERIOD = 60;
const CONTROLLER_PRECEDENCE_SEC = 60;

export class SessionEngine {
  st: EngineState;
  world: World;
  scenario: Scenario;
  arbiter: Arbiter;
  staffed = new Set<PositionId>();
  outbox: ServerMessage[] = [];
  log: LogEvent[] = [];
  frames: RawFrame[] = [];

  private trajectory = new TrajectoryAgent();
  separation = new SeparationAgent();
  monitor = new SafetyMonitor();
  private flow = new CenterFlowAgent();
  private sequencer = new SequencerAgent();
  private sector = new SectorAgent();
  workload = new WorkloadAgent();
  private datalink = new DatalinkAgent();
  private trajs = new Map<string, Trajectory>();
  private agentRuntime: Record<string, { ms: number; error?: string }> = {};
  private lastDelivered = new Map<PositionId, string>();
  private lastSent = new Map<string, string>();
  private lastPublished = new Map<string, Flight>();
  private recent: Advisory[] = [];
  private delivered = new Map<PositionId, Advisory[]>();

  constructor(scenario: Scenario, opts: { seed?: number; traffic?: TrafficLevel; state?: EngineState } = {}) {
    this.scenario = scenario;
    if (opts.state) {
      this.st = opts.state;
      this.world = new World(this.st.world);
    } else {
      this.world = World.fromScenario(scenario, opts.seed ?? scenario.seed, opts.traffic ?? scenario.traffic);
      this.st = SessionEngine.freshState(scenario, this.world);
      this.logEvent('session.start', { scenario: scenario.id, seed: this.world.state.seed, traffic: this.world.state.traffic });
    }
    this.arbiter = new Arbiter(this.st.arbiter);
  }

  private static freshState(scenario: Scenario, world: World): EngineState {
    const enabled: Record<string, boolean> = {};
    for (const a of TOGGLEABLE_AGENTS) enabled[a] = !(scenario.agentsOff ?? []).includes(a);
    return {
      world: world.state, scenarioName: scenario.name, arbiter: { pool: [], suppressed: {}, serial: 0 }, handoffs: {}, enabled,
      frozenSta: {}, sta: {}, seq: {}, readbackAlerts: {}, lastRun: { flow: -Infinity, seq: -Infinity, workload: -Infinity }, lastTakeoffT: -Infinity,
      paused: false, speed: 1, combined: {}, autoUnstaffed: true, noise: makeRng(world.state.seed + 101), serial: 0, shownAt: {},
      metrics: { runwayErrors: [], spacing: [], delivered: [], monitorRejections: 0 },
    };
  }

  static restore(json: string, scenario: Scenario): SessionEngine {
    const state = JSON.parse(json) as EngineState;
    // JSON turns -Infinity into null
    state.lastRun = { flow: state.lastRun.flow ?? -1e9, seq: state.lastRun.seq ?? -1e9, workload: state.lastRun.workload ?? -1e9 };
    state.lastTakeoffT = state.lastTakeoffT ?? -1e9;
    return new SessionEngine(scenario, { state });
  }

  snapshot(): string {
    this.st.world = this.world.state;
    this.st.arbiter = this.arbiter.state;
    return JSON.stringify(this.st);
  }

  get t() { return this.world.t; }

  // ------------------------------------------------------------------ helpers
  effective = (p: PositionId): PositionId => this.st.combined[p] ?? p;
  private ownerOf = (cs: string): PositionId => this.world.find(cs)?.owner ?? 'APP';
  private isHuman(p: PositionId) { return this.staffed.has(this.effective(p)); }
  private emergencies(): Set<string> {
    return new Set(this.world.aircraft.filter((a) => a.squawk === '7700' || a.squawk === '7500').map((a) => a.callsign));
  }

  private logEvent(kind: string, payload: Record<string, unknown>) {
    this.log.push({ tick: this.world.tick, t: this.world.t, kind, payload });
  }

  private comms(line: Omit<CommsLine, 't'>) {
    this.outbox.push({ v: 1, type: 'comms', line: { ...line, t: this.world.t } });
  }

  drain(): { messages: ServerMessage[]; events: LogEvent[] } {
    const out = { messages: this.outbox, events: this.log };
    this.outbox = [];
    this.log = [];
    return out;
  }

  // ------------------------------------------------------------------ tick
  tick(): RawFrame | undefined {
    if (this.st.paused) return undefined;
    const res = this.world.step();
    const now = this.world.t;

    for (const l of res.comms) this.outbox.push({ v: 1, type: 'comms', line: l });
    for (const s of res.squawks) this.logEvent('squawk', s);
    for (const cs of res.landed) this.onLanded(cs);
    for (const cs of [...res.landed, ...res.exited]) {
      this.arbiter.removeForFlight(cs);
      delete this.st.handoffs[cs];
      delete this.st.frozenSta[cs];
      if (this.st.readbackAlerts[cs]) this.clearReadback(cs);
    }

    // Track agent: raw surveillance frame for the independent safety nets (published before planning runs).
    const frame = rawFrame(this.world, this.st.noise);
    this.frames.push(frame);
    if (this.frames.length > 2) this.frames.shift();

    for (const sc of res.scenarioClearances) {
      this.issueClearance(sc.clearance, { position: 'SCENARIO', name: `scripted ${sc.position}` }, 'scenario');
    }

    // Readback check (Datalink)
    for (const rb of res.readbacks) {
      if (!this.st.enabled.datalink) continue;
      const alert = this.datalink.check(rb, ++this.st.serial);
      if (alert) {
        this.st.readbackAlerts[rb.callsign] = { alert, issued: rb.issued, reissued: false };
        this.outbox.push({ v: 1, type: 'alert', alert });
        this.logEvent('alert', { alert });
      } else if (this.st.readbackAlerts[rb.callsign] && (rb.issued.alt !== undefined || rb.issued.hdg !== undefined)) {
        this.clearReadback(rb.callsign);
      }
    }
    for (const [cs, r] of Object.entries(this.st.readbackAlerts)) if (now - r.alert.at > 90) this.clearReadback(cs);

    this.runAgents(res.squawks.length > 0);
    this.processHandoffs();
    this.autoControl();
    this.publishAdvisories();
    this.outbox.push(this.sweepMessage(false));
    this.outbox.push(this.statusMessage());
    return frame;
  }

  private clearReadback(cs: string) {
    const r = this.st.readbackAlerts[cs];
    if (!r) return;
    delete this.st.readbackAlerts[cs];
    this.outbox.push({ v: 1, type: 'alert', alert: r.alert, cleared: true });
  }

  private onLanded(cs: string) {
    const rec = this.world.state.landed[this.world.state.landed.length - 1];
    const sta = this.st.frozenSta[cs];
    if (sta !== undefined) this.st.metrics.runwayErrors.push({ callsign: cs, err: rec.t - sta });
    // Wake spacing at the threshold: distance to the next aircraft on the same final.
    const thr = RUNWAYS[rec.runway]?.thr;
    if (thr) {
      const followers = this.world.aircraft.filter((a) => a.callsign !== cs && a.phase === 'approach' && a.runway === rec.runway && finalZone(a) === rec.runway);
      followers.sort((p, q) => dist(p, thr) - dist(q, thr));
      const f = followers[0];
      if (f) this.st.metrics.spacing.push({ leader: cs, follower: f.callsign, runway: rec.runway, distNm: dist(f, thr), required: wakeSpacing(rec.wake, f.wake) });
    }
    this.logEvent('landed', { callsign: cs, runway: rec.runway, sta: sta ?? null });
  }

  private safe(agent: AgentId, fn: () => void) {
    if (!this.st.enabled[agent]) { this.agentRuntime[agent] = { ms: 0 }; return; }
    if (this.monitor.isSuspended(agent, this.world.t)) { this.arbiter.submit(agent, [], this.world.t); return; }
    const t0 = Date.now();
    try {
      fn();
      this.agentRuntime[agent] = { ms: Date.now() - t0 };
    } catch (e) {
      // Agent isolation: a crash removes that agent's advice only.
      this.agentRuntime[agent] = { ms: Date.now() - t0, error: String((e as Error)?.message ?? e) };
      this.arbiter.submit(agent, [], this.world.t);
    }
  }

  runAgents(force = false) {
    const now = this.world.t;
    const aircraft = this.world.aircraft;
    const map = new Map(aircraft.map((a) => [a.callsign, a]));
    const emergencies = this.emergencies();
    this.monitor.begin(aircraft);
    const filter = (props: Advisory[]) => this.monitor.filter(props, map, now, (adv, reason) => {
      this.st.metrics.monitorRejections++;
      this.logEvent('monitor.reject', { source: adv.source, key: adv.key, reason });
    });

    this.trajs = new Map();
    this.safe('trajectory', () => { this.trajs = this.trajectory.run(aircraft, this.world.state.wind, now); });
    const haveTraj = this.trajs.size > 0 || aircraft.length === 0;

    for (const a of TOGGLEABLE_AGENTS) if (!this.st.enabled[a]) this.arbiter.submit(a, [], now);

    if (haveTraj) {
      this.safe('separation', () => {
        const props = this.separation.run({
          aircraft: map, trajs: this.trajs, wind: this.world.state.wind, now, owner: this.ownerOf,
          existing: this.arbiter.state.pool.filter((a) => a.source === 'separation'),
        });
        this.arbiter.submit('separation', filter(props), now);
      });
      if (!this.st.enabled.separation) this.separation.lastConflicts = [];
      if (force || now - this.st.lastRun.flow >= FLOW_PERIOD) {
        this.st.lastRun.flow = now;
        this.safe('centerFlow', () => {
          const props = this.flow.run({ aircraft, trajs: this.trajs, now, frozenSta: this.st.frozenSta, owner: this.ownerOf, emergencies });
          this.st.sta = this.flow.sta;
          this.arbiter.submit('centerFlow', filter(props), now);
        });
      }
      if (force || now - this.st.lastRun.seq >= FLOW_PERIOD) {
        this.st.lastRun.seq = now;
        this.safe('sequencer', () => {
          const props = this.sequencer.run({ aircraft, trajs: this.trajs, wind: this.world.state.wind, now, frozenSta: this.st.frozenSta, sta: this.st.sta, owner: this.ownerOf, emergencies, lastTakeoffT: this.st.lastTakeoffT });
          this.st.seq = this.sequencer.sequence;
          this.arbiter.submit('sequencer', filter(props), now);
        });
      }
    } else {
      for (const a of ['separation', 'centerFlow', 'sequencer'] as AgentId[]) this.arbiter.submit(a, [], now);
    }

    if (this.st.enabled.sector && haveTraj) {
      this.safe('sector', () => {
        const changed = this.sector.draftHandoffs({ aircraft, trajs: this.trajs, now, handoffs: this.st.handoffs, emergencies });
        for (const h of changed) {
          this.outbox.push({ v: 1, type: 'handoff', handoff: h });
          if (h.state === 'proposed') this.logEvent('handoff', { ...h });
        }
        this.arbiter.submit('sector', filter(this.sector.advise({ aircraft, trajs: this.trajs, now, handoffs: this.st.handoffs, emergencies }, this.ownerOf)), now);
      });
    } else {
      // Legacy fallback ("fail to today"): automatic handoff when the flight crosses the boundary.
      for (const ac of aircraft) {
        const g = geoSector(ac, ac.alt);
        if (g !== ac.owner && ac.phase !== 'holding-short' && ac.phase !== 'lineup') this.transfer(ac, g, { position: 'AUTO', name: 'legacy auto-handoff' });
      }
    }

    if (force || now - this.st.lastRun.workload >= WORKLOAD_PERIOD) {
      this.st.lastRun.workload = now;
      this.safe('workload', () => this.workload.run({ aircraft, conflicts: this.separation.lastConflicts, advisories: this.arbiter.state.pool, handoffs: this.st.handoffs, combined: this.st.combined }));
    }

    for (const e of this.arbiter.expire(now)) this.logEvent('advisory.expired', { id: e.id, key: e.key });
  }

  private processHandoffs() {
    const now = this.world.t;
    for (const h of Object.values(this.st.handoffs)) {
      if (h.state !== 'proposed') continue;
      const ac = this.world.find(h.flight);
      if (!ac) { delete this.st.handoffs[h.flight]; continue; }
      if (this.effective(h.from) === this.effective(h.to)) { this.transfer(ac, h.to, { position: 'AUTO', name: 'combined position' }); continue; }
      // Authority level 2: silent consent when the receiving position has no human controller.
      if (!this.isHuman(h.to) && this.st.autoUnstaffed && now - h.at >= SILENT_CONSENT) this.transfer(ac, h.to, { position: 'AUTO', name: 'silent consent' });
    }
  }

  private transfer(ac: Aircraft, to: PositionId, by: Actor) {
    const from = ac.owner;
    ac.owner = to;
    const h: Handoff = { flight: ac.callsign, from, to, state: 'accepted', at: this.world.t, crossInSec: 0 };
    delete this.st.handoffs[ac.callsign];
    this.outbox.push({ v: 1, type: 'handoff', handoff: h });
    this.comms({ from, to: ac.callsign, text: frequencyChange(ac.callsign, to), kind: 'clearance' });
    this.logEvent('handoff', { ...h, by: by.name, byPosition: by.position });
    // Advisories follow the flight to its new owner.
    for (const a of this.arbiter.state.pool) if (a.flights[0] === ac.callsign) a.position = to;
  }

  private autoControl() {
    if (!this.st.autoUnstaffed) return;
    const now = this.world.t;
    for (const pos of POSITIONS) {
      if (this.effective(pos) !== pos || this.isHuman(pos)) continue;
      const list = this.delivered.get(pos) ?? [];
      const ready = list.find((a) => (this.st.shownAt[a.id] ?? now) <= now - 4);
      if (ready) this.acceptAdvisory(ready.id, { position: 'AUTO', name: `auto ${pos}` });
    }
    // Scripted controllers correct wrong readbacks on positions nobody is working.
    for (const [cs, r] of Object.entries(this.st.readbackAlerts)) {
      if (r.reissued || this.isHuman(this.ownerOf(cs))) continue;
      r.reissued = true;
      this.issueClearance(r.issued, { position: 'AUTO', name: `auto ${this.ownerOf(cs)}` }, 'auto');
    }
  }

  // ------------------------------------------------------------------ actions
  private canControl(by: Actor, cs: string): boolean {
    if (by.position === 'SUP' || by.position === 'AUTO' || by.position === 'SCENARIO') return true;
    if (by.position === 'OBS') return false;
    return this.effective(this.ownerOf(cs)) === by.position;
  }

  issueClearance(c: Clearance, by: Actor, source: 'controller' | 'advisory' | 'scenario' | 'auto' = 'controller', advisoryId?: string): { ok: boolean; error?: string } {
    const ac = this.world.find(c.flight);
    if (!ac) return { ok: false, error: `No flight ${c.flight}` };
    if (!this.canControl(by, ac.callsign)) return { ok: false, error: `${ac.callsign} is owned by ${this.effective(ac.owner)}` };
    const ctx = { currentAlt: ac.alt, currentHdg: ac.hdg };
    const res = this.world.issueClearance({ ...c, flight: ac.callsign });
    if (!res.ok) return res;
    if (source === 'controller' || source === 'scenario') ac.lastControllerClearanceT = this.world.t;
    this.logEvent('clearance', { clearance: { ...c, flight: ac.callsign }, source, by: by.name, position: by.position, advisoryId: advisoryId ?? null });
    const pos = by.position === 'AUTO' || by.position === 'SCENARIO' || by.position === 'SUP' || by.position === 'OBS' ? this.effective(ac.owner) : by.position;
    this.comms({ from: pos, to: ac.callsign, text: this.datalink.render({ ...c, flight: ac.callsign }, ctx, !!this.st.enabled.datalink), kind: 'clearance' });
    if (ac.nordo) this.comms({ from: ac.callsign, to: pos, text: `(no response from ${ac.callsign})`, kind: 'system' });
    if (c.approach) {
      const p = predict(ac, this.world.state.wind, this.world.t);
      if (p.landT) this.st.frozenSta[ac.callsign] = p.landT;
    }
    if (c.takeoff) this.st.lastTakeoffT = this.world.t;
    return { ok: true };
  }

  acceptAdvisory(id: string, by: Actor, edited?: Clearance[]): { ok: boolean; error?: string } {
    const adv = this.arbiter.find(id);
    if (!adv) return { ok: false, error: 'Advisory no longer active' };
    if (by.position !== 'AUTO' && by.position !== 'SUP' && this.effective(adv.position) !== by.position) return { ok: false, error: `Advisory belongs to ${this.effective(adv.position)}` };
    this.arbiter.remove(id, { now: this.world.t });
    this.remember(adv);
    for (const c of edited?.length ? edited : adv.action) this.issueClearance(c, by, 'advisory', id);
    this.logEvent('advisory.accept', { id, key: adv.key, source: adv.source, edited: !!edited?.length, by: by.name, position: by.position });
    this.publishAdvisories();
    return { ok: true };
  }

  rejectAdvisory(id: string, reason: RejectReason, by: Actor): { ok: boolean; error?: string } {
    const adv = this.arbiter.find(id);
    if (!adv) return { ok: false, error: 'Advisory no longer active' };
    this.arbiter.remove(id, { reject: true, now: this.world.t });
    this.remember(adv);
    this.logEvent('advisory.reject', { id, key: adv.key, source: adv.source, reason, by: by.name, position: by.position });
    this.publishAdvisories();
    return { ok: true };
  }

  acceptHandoff(cs: string, by: Actor): { ok: boolean; error?: string } {
    const ac = this.world.find(cs);
    const h = ac && this.st.handoffs[ac.callsign];
    if (!ac || !h) return { ok: false, error: `No pending handoff for ${cs}` };
    if (by.position !== 'SUP' && by.position !== 'AUTO' && this.effective(h.to) !== by.position) return { ok: false, error: `Handoff is for ${h.to}` };
    this.transfer(ac, h.to, by);
    this.outbox.push(this.sweepMessage(false, true));
    return { ok: true };
  }

  toggleAgent(agent: AgentId, on: boolean, by: Actor) {
    if (!TOGGLEABLE_AGENTS.includes(agent)) return;
    this.st.enabled[agent] = on;
    if (!on) this.arbiter.submit(agent, [], this.world.t);
    if (on && (agent === 'centerFlow' || agent === 'sequencer')) this.st.lastRun.flow = this.st.lastRun.seq = -1e9;
    this.logEvent('agent.toggle', { agent, on, by: by.name });
    this.comms({ from: 'SYSTEM', to: 'ALL', text: `${agent} agent switched ${on ? 'ON' : 'OFF'} by ${by.name}`, kind: 'system' });
    this.publishAdvisories();
    this.outbox.push(this.statusMessage());
  }

  setTraffic(level: TrafficLevel, by: Actor) {
    this.world.setTraffic(level);
    this.logEvent('traffic', { level, by: by.name });
    this.outbox.push(this.statusMessage());
  }

  combine(position: PositionId, into: PositionId, by: Actor) {
    if (position === into) return;
    for (const [p, i] of Object.entries(this.st.combined)) if (i === position) this.st.combined[p as PositionId] = into;
    this.st.combined[position] = into;
    this.logEvent('combine', { position, into, by: by.name });
    this.publishAdvisories(true);
    this.outbox.push(this.statusMessage());
  }

  split(position: PositionId, by: Actor) {
    delete this.st.combined[position];
    this.logEvent('split', { position, by: by.name });
    this.publishAdvisories(true);
    this.outbox.push(this.statusMessage());
  }

  setPaused(paused: boolean) { this.st.paused = paused; this.outbox.push(this.statusMessage()); }
  setSpeed(speed: 1 | 2 | 4) { this.st.speed = speed; this.outbox.push(this.statusMessage()); }

  // ------------------------------------------------------------------ outputs
  private remember(a: Advisory) {
    this.recent.push(a);
    if (this.recent.length > 100) this.recent.shift();
  }

  getAdvisory(id: string): Advisory | undefined {
    return this.arbiter.find(id) ?? this.recent.find((a) => a.id === id);
  }

  advisoriesFor(p: PositionId): Advisory[] {
    return this.delivered.get(p) ?? [];
  }

  publishAdvisories(force = false) {
    const now = this.world.t;
    this.delivered = this.arbiter.deliver({
      effective: this.effective,
      recentControllerClearance: (cs) => {
        const ac = this.world.find(cs);
        return !!ac?.lastControllerClearanceT && now - ac.lastControllerClearanceT < CONTROLLER_PRECEDENCE_SEC;
      },
      emergencies: this.emergencies(),
    });
    for (const pos of POSITIONS) {
      const list = this.delivered.get(pos) ?? [];
      for (const a of list) {
        if (this.st.shownAt[a.id] === undefined) {
          this.st.shownAt[a.id] = now;
          this.remember(a);
          this.st.metrics.delivered.push({ id: a.id, t: now, source: a.source, flights: a.flights, action: a.action, minSepNm: a.predicted.minSepNm });
          if (this.st.metrics.delivered.length > 2000) this.st.metrics.delivered.shift();
        }
      }
      const key = JSON.stringify(list.map((a) => [a.id, a.position, a.priority, a.expiresAt]));
      if (force || this.lastDelivered.get(pos) !== key) {
        this.lastDelivered.set(pos, key);
        this.outbox.push({ v: 1, type: 'advisories', position: pos, advisories: list });
      }
    }
    const live = new Set(this.arbiter.state.pool.map((a) => a.id));
    for (const id of Object.keys(this.st.shownAt)) if (!live.has(id)) delete this.st.shownAt[id];
  }

  /** Current advisory lists for every position (sent to newly connected consoles). */
  allAdvisoryMessages(): ServerMessage[] {
    return POSITIONS.map((p) => ({ v: 1, type: 'advisories', position: p, advisories: this.delivered.get(p) ?? [] }) as ServerMessage);
  }

  flights(): Flight[] {
    return this.world.aircraft.map((a) => toFlight(a, { seq: this.st.seq[a.callsign], sta: this.st.sta[a.callsign] ?? this.st.frozenSta[a.callsign] }));
  }

  /** Sweep message. Track agent adds occasional dropouts (target coasts on its last position). */
  sweepMessage(full: boolean, noAdvance = false): ServerMessage {
    const flights = this.flights().map((f) => {
      const prev = this.lastPublished.get(f.id);
      if (!noAdvance && !full && prev && f.phase !== 'holding-short' && next(this.st.noise) < 0.01) return { ...prev, coast: true, owner: f.owner, cleared: f.cleared };
      return f;
    });
    if (full) return { v: 1, type: 'sweep', t: this.world.t, tick: this.world.tick, full: true, flights, removed: [], sentAt: Date.now() };
    const changed: Flight[] = [];
    const ids = new Set<string>();
    for (const f of flights) {
      ids.add(f.id);
      const s = JSON.stringify(f);
      if (this.lastSent.get(f.id) !== s) { changed.push(f); this.lastSent.set(f.id, s); }
      this.lastPublished.set(f.id, f);
    }
    const removed = [...this.lastSent.keys()].filter((id) => !ids.has(id));
    for (const id of removed) { this.lastSent.delete(id); this.lastPublished.delete(id); }
    return { v: 1, type: 'sweep', t: this.world.t, tick: this.world.tick, full: false, flights: changed, removed, sentAt: Date.now() };
  }

  simStatus(): SimStatus {
    return { paused: this.st.paused, speed: this.st.speed, t: this.world.t, tick: this.world.tick, scenario: this.scenario.id, seed: this.world.state.seed, trafficLevel: this.world.state.traffic, combined: this.st.combined };
  }

  agentStatus(): AgentStatus[] {
    const now = this.world.t;
    return [
      ...TOGGLEABLE_AGENTS.map((id) => ({
        id, enabled: !!this.st.enabled[id], suspended: this.monitor.isSuspended(id, now), stub: false,
        lastRunMs: this.agentRuntime[id]?.ms ?? 0, rejected: this.monitor.rejectedTotal.get(id) ?? 0, error: this.agentRuntime[id]?.error,
      })),
      ...STUB_AGENTS.map((id) => ({ id, enabled: false, suspended: false, stub: true, lastRunMs: 0, rejected: 0 })),
    ];
  }

  statusMessage(): ServerMessage {
    return { v: 1, type: 'status', status: this.simStatus(), agents: this.agentStatus(), workload: this.workload.scores, recommendations: this.workload.recommendations };
  }

  activeReadbackAlerts(): Alert[] {
    return Object.values(this.st.readbackAlerts).map((r) => r.alert);
  }

  handoffList(): Handoff[] {
    return Object.values(this.st.handoffs);
  }

  conflicts(): Conflict[] {
    return this.separation.lastConflicts;
  }

  describe(c: Clearance): string {
    return formatCommand(c);
  }
}
