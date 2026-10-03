// Headless scripted-controller harness: runs a SessionEngine plus the independent SafetyNets
// exactly as the two Durable Objects do, without Cloudflare.
import { SessionEngine, type LogEvent } from '../src/engine/session';
import { SafetyNets } from '../src/safety/nets';
import type { Alert, BusEvent, PositionId, RawFrame } from '../src/shared/types';
import type { Scenario } from '../src/sim/scenario';
import { getScenario } from '../scenarios';

export type AlertRecord = { t: number; tick: number; alert: Alert };

export type RunResult = {
  engine: SessionEngine;
  alerts: AlertRecord[];
  readbackAlerts: AlertRecord[];
  events: LogEvent[];
  frames: RawFrame[];
};

export function scenario(id: string): Scenario {
  const s = getScenario(id);
  if (!s) throw new Error(`no scenario ${id}`);
  return JSON.parse(JSON.stringify(s));
}

export function run(
  sc: Scenario,
  opts: { maxSec?: number; seed?: number; staffed?: PositionId[]; until?: (r: RunResult) => boolean; onTick?: (r: RunResult, frame: RawFrame) => void } = {},
): RunResult {
  const engine = new SessionEngine(sc, { seed: opts.seed });
  engine.staffed = new Set(opts.staffed ?? []);
  const nets = new SafetyNets();
  const r: RunResult = { engine, alerts: [], readbackAlerts: [], events: [], frames: [] };
  r.events.push(...engine.drain().events);
  const maxSec = opts.maxSec ?? sc.durationSec;
  while (engine.t < maxSec) {
    const frame = engine.tick();
    if (!frame) break;
    r.frames.push(frame);
    if (r.frames.length > 400) r.frames.shift();
    const res = nets.process(frame);
    for (const a of res.raised) r.alerts.push({ t: frame.t, tick: frame.tick, alert: a });
    const { messages, events } = engine.drain();
    r.events.push(...events);
    for (const m of messages) if (m.type === 'alert' && !m.cleared) r.readbackAlerts.push({ t: frame.t, tick: frame.tick, alert: m.alert });
    opts.onTick?.(r, frame);
    if (opts.until?.(r)) break;
  }
  return r;
}

export function toBusEvents(events: LogEvent[]): BusEvent[] {
  return events.map((e, i) => ({ seq: i + 1, t: e.t, tick: e.tick, kind: e.kind, payload: e.payload }));
}

/** Actual (truth) loss of separation between two aircraft in the engine's world. */
export function separation(engine: SessionEngine, a: string, b: string): { h: number; v: number } | undefined {
  const A = engine.world.find(a), B = engine.world.find(b);
  if (!A || !B) return undefined;
  return { h: Math.hypot(A.x - B.x, A.y - B.y), v: Math.abs(A.alt - B.alt) };
}
