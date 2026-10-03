// SafetyNet DO: independent alerting on its own Durable Object and its own console WebSocket.
// It only receives raw surveillance frames; if the Airspace DO's agent runtime is switched off
// or fails, conflict, terrain, runway and emergency alerts still reach every console.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { SafetyNets } from '../safety/nets';
import type { Alert, RawFrame, ServerMessage } from '../shared/types';

export class SafetyNetDO extends DurableObject<Env> {
  private nets = new SafetyNets();
  private rows = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t REAL NOT NULL, tick INTEGER NOT NULL, state TEXT NOT NULL,
        kind TEXT NOT NULL, alert_id TEXT NOT NULL, payload TEXT NOT NULL
      )`);
    });
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch { /* socket closing */ }
    }
  }

  private log(frame: RawFrame, state: string, a: Alert) {
    this.ctx.storage.sql.exec('INSERT INTO alerts (t, tick, state, kind, alert_id, payload) VALUES (?, ?, ?, ?, ?, ?)', frame.t, frame.tick, state, a.kind, a.id, JSON.stringify(a));
    this.rows++;
  }

  /** RPC from the Airspace DO's Track agent, once per radar sweep. */
  ingest(frame: RawFrame): { active: number; rowsWritten: number } {
    const res = this.nets.process(frame);
    for (const a of res.raised) { this.log(frame, 'raised', a); this.broadcast({ v: 1, type: 'alert', alert: a }); }
    for (const a of res.updated) this.broadcast({ v: 1, type: 'alert', alert: a });
    for (const a of res.cleared) { this.log(frame, 'cleared', a); this.broadcast({ v: 1, type: 'alert', alert: a, cleared: true }); }
    const rowsWritten = this.rows;
    this.rows = 0;
    return { active: res.active.length, rowsWritten };
  }

  reset(): void {
    this.nets.reset();
    this.broadcast({ v: 1, type: 'alerts', alerts: [] });
  }

  activeAlerts(): Alert[] {
    return this.nets.active();
  }

  recentAlerts(sinceT: number): { t: number; state: string; alert: Alert }[] {
    return this.ctx.storage.sql
      .exec<{ t: number; state: string; payload: string }>('SELECT t, state, payload FROM alerts WHERE t >= ? ORDER BY id LIMIT 200', sinceT)
      .toArray()
      .map((r) => ({ t: r.t, state: r.state, alert: JSON.parse(r.payload) as Alert }));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server); // Hibernation API: no billing while idle
    server.send(JSON.stringify({ v: 1, type: 'alerts', alerts: this.nets.active() } satisfies ServerMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
      if (msg?.type === 'alert.ack' && typeof msg.id === 'string') {
        this.ctx.storage.sql.exec('INSERT INTO alerts (t, tick, state, kind, alert_id, payload) VALUES (?, ?, ?, ?, ?, ?)', Date.now() / 1000, -1, 'ack', 'ACK', msg.id, '{}');
      }
    } catch {
      ws.send(JSON.stringify({ v: 1, type: 'error', message: 'bad message' }));
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 ? 1000 : code, 'closing'); } catch { /* already closed */ }
  }
}
