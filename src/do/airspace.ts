// Airspace DO (one per session): radar-sweep alarm loop, the agent runtime (SessionEngine),
// the event log and snapshots in SQLite, and the traffic/advisory WebSocket.
// Uses the WebSocket Hibernation API and stops its alarm when nobody is connected.
import { DurableObject } from 'cloudflare:workers';
import { DO_GB, type Env, type UsageDelta } from '../env';
import { SessionEngine } from '../engine/session';
import { getScenario } from '../../scenarios';
import { parseCommand } from '../shared/commands';
import { SWEEP_SEC } from '../sim/world';
import {
  POSITIONS, TOGGLEABLE_AGENTS, type Advisory, type AgentId, type BusEvent, type ClientMessage, type ConsolePosition, type PositionId, type Presence,
  type ServerMessage, type TrafficLevel,
} from '../shared/types';

type Meta = { code: string; scenario: string; seed: number; traffic: TrafficLevel; createdAt: number };
type Attachment = { clientId: string; name: string; position: ConsolePosition };

const SNAPSHOT_EVERY = 30; // sim seconds
const REPORT_EVERY_MS = 60_000;

async function gzip(s: string): Promise<ArrayBuffer> {
  return new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
}
async function gunzip(buf: ArrayBuffer): Promise<string> {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

export class AirspaceDO extends DurableObject<Env> {
  private meta?: Meta;
  private engine?: SessionEngine;
  private lastSnapshotT = -Infinity;
  private lastSocketAt = Date.now();
  private lastReport = Date.now();
  private usage = { alarms: 0, rows: 0, wsIn: 0, rpc: 0, connections: 0, awakeSec: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS session (k TEXT PRIMARY KEY, v TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, tick INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, tick INTEGER NOT NULL, data BLOB NOT NULL);
      `);
      const row = ctx.storage.sql.exec<{ v: string }>("SELECT v FROM session WHERE k = 'meta'").toArray()[0];
      if (row) this.meta = JSON.parse(row.v);
    });
  }

  // ---------------------------------------------------------------- lifecycle
  async init(meta: Meta): Promise<{ ok: boolean; error?: string }> {
    if (this.meta) return { ok: true };
    const sc = getScenario(meta.scenario);
    if (!sc) return { ok: false, error: `Unknown scenario ${meta.scenario}` };
    this.meta = meta;
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO session (k, v) VALUES ('meta', ?)", JSON.stringify(meta));
    this.usage.rows++;
    this.engine = new SessionEngine(sc, { seed: meta.seed, traffic: meta.traffic });
    this.flush();
    await this.snapshot();
    return { ok: true };
  }

  private async ensureEngine(): Promise<SessionEngine | undefined> {
    if (this.engine) return this.engine;
    if (!this.meta) return undefined;
    const sc = getScenario(this.meta.scenario);
    if (!sc) return undefined;
    const snap = this.ctx.storage.sql.exec<{ data: ArrayBuffer; t: number }>('SELECT data, t FROM snapshots ORDER BY id DESC LIMIT 1').toArray()[0];
    if (snap) {
      this.engine = SessionEngine.restore(await gunzip(snap.data), sc);
      this.lastSnapshotT = snap.t;
    } else {
      this.engine = new SessionEngine(sc, { seed: this.meta.seed, traffic: this.meta.traffic });
    }
    this.engine.staffed = this.staffed();
    return this.engine;
  }

  private async snapshot() {
    if (!this.engine) return;
    const data = await gzip(this.engine.snapshot());
    this.ctx.storage.sql.exec('INSERT INTO snapshots (t, tick, data) VALUES (?, ?, ?)', this.engine.t, this.engine.world.tick, data);
    this.usage.rows++;
    this.lastSnapshotT = this.engine.t;
  }

  private intervalMs(): number {
    return (SWEEP_SEC * 1000) / (this.engine?.st.speed ?? 1);
  }

  private async ensureAlarm() {
    if (this.engine?.st.paused) return;
    const at = await this.ctx.storage.getAlarm();
    if (at === null) {
      await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
      this.usage.rows++;
    }
  }

  // ---------------------------------------------------------------- sockets
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { clientId: '?', name: 'unknown', position: 'OBS' };
  }

  private staffed(): Set<PositionId> {
    const s = new Set<PositionId>();
    for (const ws of this.sockets()) {
      const p = this.att(ws).position;
      if ((POSITIONS as string[]).includes(p)) s.add(p as PositionId);
    }
    return s;
  }

  private presence(): Presence[] {
    return this.sockets().map((ws) => this.att(ws));
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closing */ }
  }

  private broadcast(msgs: ServerMessage[]) {
    if (!msgs.length) return;
    const data = msgs.map((m) => JSON.stringify(m));
    for (const ws of this.sockets()) for (const d of data) {
      try { ws.send(d); } catch { /* closing */ }
    }
  }

  /** Writes engine log events to the append-only event table and broadcasts queued messages. */
  private flush() {
    if (!this.engine) return;
    const { messages, events } = this.engine.drain();
    for (const e of events) {
      this.ctx.storage.sql.exec('INSERT INTO events (t, tick, kind, payload) VALUES (?, ?, ?, ?)', e.t, e.tick, e.kind, JSON.stringify(e.payload));
    }
    this.usage.rows += events.length;
    this.broadcast(messages);
  }

  private sendInitialState(ws: WebSocket, engine: SessionEngine, clientId: string) {
    const sc = engine.scenario;
    this.send(ws, { v: 1, type: 'welcome', clientId, session: this.meta!.code, status: engine.simStatus(), scenarioName: sc.name });
    this.send(ws, engine.sweepMessage(true));
    for (const m of engine.allAdvisoryMessages()) this.send(ws, m);
    for (const h of engine.handoffList()) this.send(ws, { v: 1, type: 'handoff', handoff: h });
    for (const a of engine.activeReadbackAlerts()) this.send(ws, { v: 1, type: 'alert', alert: a });
    this.send(ws, engine.statusMessage());
    this.send(ws, { v: 1, type: 'presence', clients: this.presence() });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const engine = await this.ensureEngine();
    if (!engine) return new Response('No such session', { status: 404 });
    const url = new URL(request.url);
    const name = (url.searchParams.get('name') ?? 'controller').slice(0, 24).replace(/[^\w .-]/g, '') || 'controller';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const clientId = crypto.randomUUID().slice(0, 8);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clientId, name, position: 'OBS' } satisfies Attachment);
    this.usage.connections++;
    this.lastSocketAt = Date.now();
    this.sendInitialState(server, engine, clientId);
    this.broadcast([{ v: 1, type: 'presence', clients: this.presence() }]);
    await this.ensureAlarm();
    this.ctx.waitUntil(this.report());
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    this.usage.wsIn++;
    const engine = await this.ensureEngine();
    if (!engine) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.send(ws, { v: 1, type: 'error', message: 'Malformed message' });
    }
    const a = this.att(ws);
    const actor = { position: a.position, name: a.name };
    const fail = (message: string) => this.send(ws, { v: 1, type: 'error', message });
    const supOnly = () => { if (a.position !== 'SUP') { fail('Supervisor only'); return false; } return true; };

    switch (msg.type) {
      case 'hello':
        ws.serializeAttachment({ ...a, name: String(msg.name ?? a.name).slice(0, 24) });
        this.broadcast([{ v: 1, type: 'presence', clients: this.presence() }]);
        break;
      case 'claim': {
        const pos = msg.position;
        if (![...POSITIONS, 'SUP', 'OBS'].includes(pos)) return fail('Unknown position');
        if ((POSITIONS as string[]).includes(pos)) {
          const holder = this.sockets().find((s) => s !== ws && this.att(s).position === pos);
          if (holder) return fail(`${pos} is held by ${this.att(holder).name}`);
        }
        ws.serializeAttachment({ ...a, position: pos });
        engine.staffed = this.staffed();
        this.broadcast([{ v: 1, type: 'presence', clients: this.presence() }]);
        this.ctx.storage.sql.exec('INSERT INTO events (t, tick, kind, payload) VALUES (?, ?, ?, ?)', engine.t, engine.world.tick, 'claim', JSON.stringify({ name: a.name, position: pos }));
        this.usage.rows++;
        break;
      }
      case 'clearance': {
        const r = engine.issueClearance(msg.clearance, actor, 'controller');
        if (!r.ok) fail(r.error ?? 'Clearance refused');
        break;
      }
      case 'advisory.accept': {
        const r = engine.acceptAdvisory(msg.id, actor, msg.edited);
        if (!r.ok) fail(r.error ?? 'Accept failed');
        break;
      }
      case 'advisory.reject': {
        const r = engine.rejectAdvisory(msg.id, msg.reason, actor);
        if (!r.ok) fail(r.error ?? 'Reject failed');
        break;
      }
      case 'handoff.accept': {
        const r = engine.acceptHandoff(msg.flight, actor);
        if (!r.ok) fail(r.error ?? 'Handoff accept failed');
        break;
      }
      case 'agent.toggle':
        if (!supOnly()) return;
        if (!TOGGLEABLE_AGENTS.includes(msg.agent as AgentId)) return fail('Not a switchable agent');
        engine.toggleAgent(msg.agent, !!msg.on, actor);
        break;
      case 'alert.ack':
        this.ctx.storage.sql.exec('INSERT INTO events (t, tick, kind, payload) VALUES (?, ?, ?, ?)', engine.t, engine.world.tick, 'alert.ack', JSON.stringify({ id: msg.id, by: a.name }));
        this.usage.rows++;
        break;
      case 'sim.control':
        if (!supOnly()) return;
        await this.control(engine, msg, actor);
        break;
      default:
        return fail('Unknown message type');
    }
    this.flush();
  }

  private async control(engine: SessionEngine, msg: Extract<ClientMessage, { type: 'sim.control' }>, actor: { position: ConsolePosition; name: string }) {
    switch (msg.action) {
      case 'pause':
        engine.setPaused(true);
        await this.ctx.storage.deleteAlarm();
        await this.snapshot();
        break;
      case 'resume':
        engine.setPaused(false);
        await this.ensureAlarm();
        break;
      case 'speed':
        if (msg.speed === 1 || msg.speed === 2 || msg.speed === 4) engine.setSpeed(msg.speed);
        break;
      case 'traffic':
        if (msg.traffic) engine.setTraffic(msg.traffic, actor);
        break;
      case 'combine':
        if (msg.position && msg.into) engine.combine(msg.position, msg.into, actor);
        break;
      case 'split':
        if (msg.position) engine.split(msg.position, actor);
        break;
      case 'restart': {
        const sc = getScenario(msg.scenario ?? this.meta!.scenario);
        if (!sc) return;
        const seed = msg.seed ?? Math.floor(Math.random() * 1e6);
        this.meta = { ...this.meta!, scenario: sc.id, seed, traffic: sc.traffic };
        this.ctx.storage.sql.exec("INSERT OR REPLACE INTO session (k, v) VALUES ('meta', ?)", JSON.stringify(this.meta));
        this.flush();
        const speed = engine.st.speed;
        this.engine = new SessionEngine(sc, { seed, traffic: sc.traffic });
        this.engine.st.speed = speed;
        this.engine.staffed = this.staffed();
        this.flush();
        try { await this.env.SAFETYNET.getByName(this.meta.code).reset(); } catch { /* safety net resets on its own frames */ }
        for (const ws of this.sockets()) this.sendInitialState(ws, this.engine, this.att(ws).clientId);
        await this.snapshot();
        await this.ensureAlarm();
        this.ctx.waitUntil(this.report({ scenario: sc.id, scenarioName: sc.name, seed, traffic: sc.traffic }));
        return;
      }
    }
    this.ctx.storage.sql.exec('INSERT INTO events (t, tick, kind, payload) VALUES (?, ?, ?, ?)', engine.t, engine.world.tick, 'sim.control', JSON.stringify({ ...msg, by: actor.name }));
    this.usage.rows++;
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch { /* already closed */ }
    this.lastSocketAt = Date.now();
    const remaining = this.sockets().filter((s) => s !== ws);
    if (this.engine) this.engine.staffed = new Set(remaining.map((s) => this.att(s).position).filter((p): p is PositionId => (POSITIONS as string[]).includes(p)));
    this.broadcast([{ v: 1, type: 'presence', clients: remaining.map((s) => this.att(s)) }]);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011);
  }

  // ---------------------------------------------------------------- radar sweep
  override async alarm(): Promise<void> {
    const engine = await this.ensureEngine();
    if (!engine) return;
    this.usage.alarms++;
    if (engine.st.paused) return;
    this.usage.awakeSec += this.intervalMs() / 1000;
    const frame = engine.tick();
    if (frame && this.meta) {
      // Independent path: the raw frame goes to the SafetyNet DO before anything else is sent.
      try {
        const r = await this.env.SAFETYNET.getByName(this.meta.code).ingest(frame);
        this.usage.rpc++;
        this.usage.rows += r.rowsWritten;
      } catch (e) {
        console.error('safety net ingest failed', e);
      }
    }
    this.flush();
    if (engine.t - this.lastSnapshotT >= SNAPSHOT_EVERY) await this.snapshot();

    const connected = this.sockets().length > 0;
    if (connected) this.lastSocketAt = Date.now();
    const idleMs = Date.now() - this.lastSocketAt;
    if (connected || idleMs < Number(this.env.IDLE_PAUSE_MS ?? 600_000)) {
      await this.ctx.storage.setAlarm(Date.now() + this.intervalMs());
      this.usage.rows++;
      if (Date.now() - this.lastReport > REPORT_EVERY_MS) this.ctx.waitUntil(this.report());
    } else {
      // Auto-pause: nobody connected for IDLE_PAUSE_MS.
      await this.snapshot();
      await this.report();
    }
  }

  private async report(extra: { scenario?: string; scenarioName?: string; seed?: number; traffic?: string } = {}) {
    if (!this.meta) return;
    const u = this.usage;
    const delta: UsageDelta = {
      doRequests: u.alarms + u.rpc + Math.ceil(u.wsIn / 20) + u.connections,
      doRowsWritten: u.rows,
      doDurationGbS: u.awakeSec * DO_GB * 2, // Airspace + SafetyNet objects awake together
    };
    this.usage = { alarms: 0, rows: 0, wsIn: 0, rpc: 0, connections: 0, awakeSec: 0 };
    this.lastReport = Date.now();
    try {
      await this.env.LOBBY.getByName('lobby').touch(this.meta.code, { controllers: this.staffed().size + this.sockets().filter((s) => this.att(s).position === 'SUP').length, paused: !!this.engine?.st.paused, ...extra }, delta);
    } catch (e) {
      console.error('lobby report failed', e);
    }
  }

  // ---------------------------------------------------------------- RPC for the Worker
  async getAdvisory(id: string): Promise<Advisory | undefined> {
    return (await this.ensureEngine())?.getAdvisory(id);
  }

  async getEvents(from?: number, to?: number): Promise<{ scenario: string; seed: number; tick: number; events: BusEvent[] } | undefined> {
    if (!this.meta) return undefined;
    const tick = (await this.ensureEngine())?.world.tick ?? 0;
    const startRow = this.ctx.storage.sql.exec<{ seq: number }>("SELECT seq FROM events WHERE kind = 'session.start' ORDER BY seq DESC LIMIT 1").toArray()[0];
    const startSeq = startRow?.seq ?? 0;
    const rows = this.ctx.storage.sql
      .exec<{ seq: number; t: number; tick: number; kind: string; payload: string }>(
        'SELECT seq, t, tick, kind, payload FROM events WHERE seq >= ? AND t >= ? AND t <= ? ORDER BY seq LIMIT 20000',
        startSeq, from ?? 0, to ?? 1e12,
      )
      .toArray();
    return { scenario: this.meta.scenario, seed: this.meta.seed, tick, events: rows.map((r) => ({ seq: r.seq, t: r.t, tick: r.tick, kind: r.kind, payload: JSON.parse(r.payload) })) };
  }

  async briefingContext(position: PositionId): Promise<Record<string, unknown> | undefined> {
    const engine = await this.ensureEngine();
    if (!engine || !this.meta) return undefined;
    const since = engine.t - 600;
    const events = this.ctx.storage.sql
      .exec<{ t: number; kind: string; payload: string }>("SELECT t, kind, payload FROM events WHERE t >= ? AND kind IN ('clearance','advisory.accept','advisory.reject','handoff','alert','squawk','landed','agent.toggle') ORDER BY seq DESC LIMIT 60", since)
      .toArray()
      .reverse()
      .map((r) => ({ t: Math.round(r.t), kind: r.kind, ...JSON.parse(r.payload) }));
    const eff = engine.effective;
    const owned = engine.flights().filter((f) => eff(f.owner) === position || position === ('SUP' as PositionId));
    let alerts: unknown[] = [];
    try { alerts = await this.env.SAFETYNET.getByName(this.meta.code).activeAlerts(); } catch { /* ignore */ }
    return {
      position, simTime: Math.round(engine.t), scenario: engine.scenario.name,
      traffic: owned.map((f) => ({ callsign: f.callsign, type: f.type, alt: f.alt, cleared: f.cleared, squawk: f.squawk, kind: f.kind, phase: f.phase, runway: f.runway })),
      advisories: engine.advisoriesFor(position).map((a) => ({ flights: a.flights, action: a.action, why: a.rationale.text })),
      pendingHandoffs: engine.handoffList().filter((h) => eff(h.to) === position || eff(h.from) === position),
      alerts, recentEvents: events,
      agents: engine.agentStatus().filter((a) => !a.stub).map((a) => ({ id: a.id, on: a.enabled && !a.suspended })),
    };
  }
}
