// Lobby DO (singleton): room codes, session list, daily usage counters and the usage governor.
import { DurableObject } from 'cloudflare:workers';
import type { Budgets, Env, UsageDelta } from '../env';

export type SessionInfo = {
  code: string;
  scenario: string;
  scenarioName: string;
  seed: number;
  traffic: string;
  createdAt: number;
  lastActive: number;
  controllers: number;
  paused: boolean;
  live: boolean;
};

export type UsageReport = {
  day: string;
  resetsAt: string;
  threshold: number;
  accepting: boolean;
  metrics: Record<keyof Budgets, { used: number; limit: number; pct: number }>;
};

const METRICS: (keyof Budgets)[] = ['doRequests', 'doRowsWritten', 'doDurationGbS', 'workerRequests', 'aiNeurons'];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class LobbyDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          code TEXT PRIMARY KEY, scenario TEXT NOT NULL, scenario_name TEXT NOT NULL, seed INTEGER NOT NULL,
          traffic TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
          controllers INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (day, metric));
      `);
    });
  }

  private add(delta: UsageDelta) {
    const day = today();
    for (const [k, v] of Object.entries(delta)) {
      if (!v) continue;
      this.ctx.storage.sql.exec(
        'INSERT INTO usage (day, metric, value) VALUES (?, ?, ?) ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value',
        day, k, v,
      );
    }
  }

  usage(): UsageReport {
    const day = today();
    const rows = this.ctx.storage.sql.exec<{ metric: string; value: number }>('SELECT metric, value FROM usage WHERE day = ?', day).toArray();
    const used = Object.fromEntries(rows.map((r) => [r.metric, r.value])) as Partial<Budgets>;
    const budgets = this.env.BUDGETS;
    const threshold = Number(this.env.GOVERNOR_THRESHOLD ?? 0.8);
    const metrics = Object.fromEntries(
      METRICS.map((m) => {
        const u = Math.round((used[m] ?? 0) * 100) / 100;
        return [m, { used: u, limit: budgets[m], pct: budgets[m] ? u / budgets[m] : 0 }];
      }),
    ) as UsageReport['metrics'];
    const tomorrow = new Date(`${day}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return { day, resetsAt: tomorrow.toISOString(), threshold, accepting: METRICS.every((m) => metrics[m].pct < threshold), metrics };
  }

  /** Records consumption (Worker request counting piggybacks on every lobby call). */
  recordUsage(delta: UsageDelta): void {
    this.add(delta);
  }

  /** Governor: refuses a new session when any daily budget is at the threshold. */
  createSession(s: { code: string; scenario: string; scenarioName: string; seed: number; traffic: string }): { ok: true } | { ok: false; reason: string; usage: UsageReport } {
    this.add({ workerRequests: 1, doRequests: 1, doRowsWritten: 1 });
    const usage = this.usage();
    if (!usage.accepting) {
      const over = Object.entries(usage.metrics).filter(([, m]) => m.pct >= usage.threshold).map(([k]) => k);
      return { ok: false, reason: `Daily free-tier budget at ${Math.round(usage.threshold * 100)}% for ${over.join(', ')}; try again after ${usage.resetsAt}`, usage };
    }
    const now = Date.now();
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO sessions (code, scenario, scenario_name, seed, traffic, created_at, last_active, controllers, paused) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)',
      s.code, s.scenario, s.scenarioName, s.seed, s.traffic, now, now,
    );
    return { ok: true };
  }

  touch(code: string, info: { controllers: number; paused: boolean; scenario?: string; scenarioName?: string; seed?: number; traffic?: string }, delta: UsageDelta = {}): void {
    this.add({ ...delta, doRequests: (delta.doRequests ?? 0) + 1 });
    this.ctx.storage.sql.exec('UPDATE sessions SET last_active = ?, controllers = ?, paused = ? WHERE code = ?', Date.now(), info.controllers, info.paused ? 1 : 0, code);
    if (info.scenario) {
      this.ctx.storage.sql.exec('UPDATE sessions SET scenario = ?, scenario_name = ?, seed = ?, traffic = ? WHERE code = ?', info.scenario, info.scenarioName ?? info.scenario, info.seed ?? 0, info.traffic ?? 'none', code);
    }
  }

  listSessions(): SessionInfo[] {
    this.add({ workerRequests: 1, doRequests: 1 });
    const since = Date.now() - 24 * 3600_000;
    const rows = this.ctx.storage.sql
      .exec<{ code: string; scenario: string; scenario_name: string; seed: number; traffic: string; created_at: number; last_active: number; controllers: number; paused: number }>(
        'SELECT * FROM sessions WHERE last_active > ? ORDER BY last_active DESC LIMIT 50', since,
      )
      .toArray();
    return rows.map((r) => ({
      code: r.code, scenario: r.scenario, scenarioName: r.scenario_name, seed: r.seed, traffic: r.traffic, createdAt: r.created_at,
      lastActive: r.last_active, controllers: r.controllers, paused: !!r.paused, live: Date.now() - r.last_active < 3 * 60_000 && r.controllers > 0,
    }));
  }

  hasSession(code: string): boolean {
    return this.ctx.storage.sql.exec('SELECT code FROM sessions WHERE code = ?', code).toArray().length > 0;
  }
}
