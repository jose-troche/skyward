// Deterministic replay: scenario + seed + logged controller actions => identical world state.
// Used by the replay test and by the console's replay viewer (runs in the browser).
import type { BusEvent, Clearance, Flight, PositionId, TrafficLevel } from '../shared/types';
import { World, toFlight } from '../sim/world';
import type { Scenario } from '../sim/scenario';

export type ReplayFrame = { tick: number; t: number; flights: Flight[]; hash: string; events: BusEvent[] };

export function sessionEpoch(events: BusEvent[]): BusEvent[] {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === 'session.start') { start = i; break; }
  return start >= 0 ? events.slice(start) : events;
}

type Payload = { tick?: number; clearance?: Clearance; level?: TrafficLevel; seed?: number; traffic?: TrafficLevel; flight?: string; to?: PositionId; state?: string };

/** Replays an event log; calls onFrame after every sweep up to maxTick. */
export function replay(scenario: Scenario, allEvents: BusEvent[], maxTick: number, onFrame?: (f: ReplayFrame) => void): World {
  const events = sessionEpoch(allEvents);
  const start = events[0]?.payload as Payload | undefined;
  const world = World.fromScenario(scenario, start?.seed ?? scenario.seed, start?.traffic ?? scenario.traffic);
  const byTick = new Map<number, BusEvent[]>();
  for (const e of events) {
    const tick = e.tick ?? 0;
    const list = byTick.get(tick) ?? [];
    list.push(e);
    byTick.set(tick, list);
  }
  const apply = (tick: number) => {
    for (const e of byTick.get(tick) ?? []) {
      const p = e.payload as Payload;
      if (e.kind === 'clearance' && p.clearance) world.issueClearance(p.clearance);
      else if (e.kind === 'traffic' && p.level) world.setTraffic(p.level);
      else if (e.kind === 'handoff' && p.state === 'accepted' && p.flight && p.to) world.setOwner(p.flight, p.to);
    }
  };
  apply(0);
  onFrame?.({ tick: 0, t: 0, flights: world.aircraft.map((a) => toFlight(a)), hash: world.hash(), events: byTick.get(0) ?? [] });
  while (world.tick < maxTick) {
    world.step();
    apply(world.tick);
    onFrame?.({ tick: world.tick, t: world.t, flights: world.aircraft.map((a) => toFlight(a)), hash: world.hash(), events: byTick.get(world.tick) ?? [] });
  }
  return world;
}
