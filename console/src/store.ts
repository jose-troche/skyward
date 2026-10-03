// Client-side picture of the session, fed by the two WebSockets.
import type {
  Advisory, AgentStatus, Alert, CommsLine, ConsolePosition, Flight, Handoff, PositionId, Presence, ServerMessage, SimStatus, WorkloadScore,
} from '../../src/shared/types';

export type ClientAlert = Alert & { source: 'safety' | 'airspace'; acked: boolean };
export type Change = 'sweep' | 'advisories' | 'alerts' | 'handoffs' | 'comms' | 'presence' | 'status' | 'selection' | 'connection';

export class Store {
  session = '';
  clientId = '';
  name = '';
  position: ConsolePosition = 'OBS';
  scenarioName = '';
  flights = new Map<string, Flight>();
  history = new Map<string, { x: number; y: number }[]>();
  advisories = new Map<PositionId, Advisory[]>();
  alerts = new Map<string, ClientAlert>();
  handoffs = new Map<string, Handoff>();
  comms: CommsLine[] = [];
  presence: Presence[] = [];
  status?: SimStatus;
  agents: AgentStatus[] = [];
  workload: WorkloadScore[] = [];
  recommendations: string[] = [];
  simT = 0;
  tick = 0;
  lastSweepAt = 0;
  latencyMs = 0;
  selected?: string;
  connected = { airspace: false, safety: false };
  explanations = new Map<string, string>();
  private listeners = new Set<(c: Change) => void>();

  on(fn: (c: Change) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(c: Change) {
    for (const l of this.listeners) l(c);
  }

  /** Sim time interpolated between sweeps (for countdowns only; the scope never interpolates). */
  simNow(): number {
    const speed = this.status?.paused ? 0 : this.status?.speed ?? 1;
    return this.simT + ((Date.now() - this.lastSweepAt) / 1000) * speed;
  }

  effective(p: PositionId): PositionId {
    return this.status?.combined?.[p] ?? p;
  }

  byCallsign(cs: string): Flight | undefined {
    for (const f of this.flights.values()) if (f.callsign === cs) return f;
    return undefined;
  }

  myAdvisories(): Advisory[] {
    if (this.position === 'SUP' || this.position === 'OBS') return [...this.advisories.values()].flat();
    return this.advisories.get(this.position) ?? [];
  }

  conflictPairs(): [string, string][] {
    return [...this.alerts.values()].filter((a) => a.kind === 'CA').map((a) => [a.flights[0], a.flights[1]]);
  }

  apply(m: ServerMessage, source: 'airspace' | 'safety') {
    switch (m.type) {
      case 'welcome':
        this.clientId = m.clientId;
        this.status = m.status;
        this.scenarioName = m.scenarioName;
        this.flights.clear();
        this.history.clear();
        this.handoffs.clear();
        for (const [id, a] of this.alerts) if (a.source === 'airspace') this.alerts.delete(id);
        this.emit('status');
        break;
      case 'sweep': {
        if (m.full) this.flights.clear();
        for (const f of m.flights) {
          this.flights.set(f.id, f);
          if (!m.full) {
            const h = this.history.get(f.id) ?? [];
            h.push({ ...f.pos });
            if (h.length > 6) h.shift();
            this.history.set(f.id, h);
          }
        }
        for (const id of m.removed) { this.flights.delete(id); this.history.delete(id); }
        this.simT = m.t;
        this.tick = m.tick;
        this.lastSweepAt = Date.now();
        this.latencyMs = Math.max(0, Date.now() - m.sentAt);
        this.emit('sweep');
        break;
      }
      case 'advisories':
        this.advisories.set(m.position, m.advisories);
        this.emit('advisories');
        break;
      case 'alert':
        if (m.cleared) this.alerts.delete(m.alert.id);
        else this.alerts.set(m.alert.id, { ...m.alert, source, acked: this.alerts.get(m.alert.id)?.acked ?? false });
        this.emit('alerts');
        break;
      case 'alerts':
        for (const [id, a] of this.alerts) if (a.source === source) this.alerts.delete(id);
        for (const a of m.alerts) this.alerts.set(a.id, { ...a, source, acked: false });
        this.emit('alerts');
        break;
      case 'handoff':
        if (m.handoff.state === 'proposed') this.handoffs.set(m.handoff.flight, m.handoff);
        else {
          this.handoffs.delete(m.handoff.flight);
          const f = this.byCallsign(m.handoff.flight);
          if (f && m.handoff.state === 'accepted') f.owner = m.handoff.to;
          this.emit('sweep');
        }
        this.emit('handoffs');
        break;
      case 'comms':
        this.comms.push(m.line);
        if (this.comms.length > 300) this.comms.splice(0, this.comms.length - 300);
        this.emit('comms');
        break;
      case 'presence':
        this.presence = m.clients;
        this.emit('presence');
        break;
      case 'status':
        this.status = m.status;
        this.agents = m.agents;
        this.workload = m.workload;
        this.recommendations = m.recommendations;
        this.emit('status');
        break;
      case 'error':
        break;
    }
  }
}
