// Non-functional acceptance (implementation plan, section 10): replay determinism and
// "0 unsafe advisories reach a console across 1,000 randomized fast-time runs".
import { describe, expect, it } from 'vitest';
import { run, scenario, toBusEvents } from './harness';
import { replay } from '../src/engine/replay';
import { SessionEngine } from '../src/engine/session';
import { World } from '../src/sim/world';
import { horizontalMinimum, FIELD_ELEV } from '../src/shared/airspace';
import { makeRng, range, int, pick } from '../src/sim/rng';
import type { Scenario, ScenarioAircraft } from '../src/sim/scenario';
import type { Clearance } from '../src/shared/types';

describe('Replay', () => {
  it('replays a session to identical state from its event log and seed', () => {
    const sc = scenario('free-light');
    const r = run(sc, { maxSec: 1500 });
    const clearances = r.events.filter((e) => e.kind === 'clearance').length;
    expect(clearances).toBeGreaterThan(5);
    const world = replay(sc, toBusEvents(r.events), r.engine.world.tick);
    expect(world.hash()).toBe(r.engine.world.hash());
    expect(world.aircraft.length).toBe(r.engine.world.aircraft.length);
  });

  it('a snapshot restored mid-session continues identically', () => {
    const sc = scenario('free-busy');
    const a = new SessionEngine(sc);
    for (let i = 0; i < 150; i++) a.tick();
    const b = SessionEngine.restore(a.snapshot(), sc);
    for (let i = 0; i < 100; i++) { a.tick(); b.tick(); }
    expect(b.world.hash()).toBe(a.world.hash());
  });

  it('a scenario restart starts a new replay epoch', () => {
    const sc = scenario('01-head-on');
    const r = run(sc, { maxSec: 60 });
    const events = toBusEvents([...r.events, { tick: 0, t: 0, kind: 'session.start', payload: { scenario: sc.id, seed: 99, traffic: 'none' } }]);
    const w = replay(sc, events, 3);
    expect(w.state.seed).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Fast-time Safety Monitor validation
// ---------------------------------------------------------------------------
const JETS = ['B738', 'A320', 'A321', 'B739', 'B77W', 'B763', 'A332', 'CRJ9', 'E175', 'CL35', 'GLF5'];

function randomScenario(seed: number): Scenario {
  const r = makeRng(seed);
  const n = int(r, 5, 9);
  const aircraft: ScenarioAircraft[] = [];
  for (let i = 0; i < n; i++) {
    const bearing = range(r, 0, 360);
    const radius = range(r, 45, 95);
    const x = radius * Math.sin((bearing * Math.PI) / 180), y = radius * Math.cos((bearing * Math.PI) / 180);
    // head roughly toward a point near the centre so paths cross
    const tx = range(r, -30, 30), ty = range(r, -30, 30);
    const hdg = Math.round(((Math.atan2(tx - x, ty - y) * 180) / Math.PI + 360) % 360) || 360;
    const alt = int(r, 18, 30) * 1000;
    const climb = range(r, 0, 1) < 0.25 ? alt + pick(r, [-4000, -2000, 2000, 4000]) : alt;
    aircraft.push({ callsign: `TST${seed % 1000}${i}`, type: pick(r, JETS), kind: 'overflight', x, y, alt, hdg, spd: int(r, 380, 470), clearedAlt: climb });
  }
  return { id: `fast-${seed}`, name: 'fast-time', description: '', seed, traffic: 'none', wind: [], durationSec: 200, aircraft, events: [], expect: {} };
}

type Pair = { violates: boolean; worst: number };

function truthCheck(base: World, clearance: Clearance, steps: number): Map<string, Pair> {
  const w = World.fromJSON(base.toJSON());
  w.issueClearance(clearance);
  const ac = w.find(clearance.flight)!;
  for (const p of ac.pending) p.flown = p.issued; // the check assumes a correct readback
  const out = new Map<string, Pair>();
  for (let i = 0; i < steps; i++) {
    w.step();
    const me = w.find(clearance.flight);
    if (!me) break;
    for (const o of w.aircraft) {
      if (o === me || o.alt < FIELD_ELEV + 300 || me.alt < FIELD_ELEV + 300) continue;
      const h = Math.hypot(o.x - me.x, o.y - me.y), v = Math.abs(o.alt - me.alt);
      const s = Math.max(h / horizontalMinimum(o, me), v / 1000);
      const cur = out.get(o.callsign) ?? { violates: false, worst: Infinity };
      cur.worst = Math.min(cur.worst, s);
      if (s < 1) cur.violates = true;
      out.set(o.callsign, cur);
    }
  }
  return out;
}

describe('Safety Monitor fast-time validation', () => {
  const RUNS = Number(process.env.FAST_TIME_RUNS ?? 1000);
  it(`0 unsafe advisories reach a console across ${RUNS} randomized fast-time runs`, () => {
    let delivered = 0, escapes = 0, conflicts = 0;
    const escapeLog: string[] = [];
    for (let seed = 1; seed <= RUNS; seed++) {
      const sc = randomScenario(seed * 7 + 3);
      const engine = new SessionEngine(sc);
      let seen = engine.st.metrics.delivered.length;
      for (let tick = 0; tick < 25; tick++) {
        // Deliveries happen inside tick(); the truth check runs from the state the advisory saw.
        engine.tick();
        conflicts += engine.conflicts().length ? 1 : 0;
        const fresh = engine.st.metrics.delivered.slice(seen);
        seen = engine.st.metrics.delivered.length;
        if (!fresh.length) continue;
        for (const d of fresh) {
          if (d.source !== 'separation') continue;
          delivered++;
          for (const c of d.action) {
            const withC = truthCheck(engine.world, c, 60);
            const without = truthCheck(engine.world, { flight: c.flight }, 60);
            for (const [other, p] of withC) {
              const b = without.get(other) ?? { violates: false, worst: Infinity };
              if (p.violates && (!b.violates || p.worst < b.worst - 0.05)) {
                escapes++;
                escapeLog.push(`seed ${seed} ${JSON.stringify(c)} vs ${other}: ${p.worst.toFixed(2)} (baseline ${b.worst.toFixed(2)})`);
              }
            }
          }
        }
      }
    }
    console.log(`fast-time: ${RUNS} runs, ${conflicts} conflict sweeps, ${delivered} separation advisories delivered, ${escapes} escapes`);
    if (escapeLog.length) console.log(escapeLog.slice(0, 10).join('\n'));
    expect(delivered).toBeGreaterThan(RUNS / 10);
    expect(escapes).toBe(0);
  }, 600_000);
});
