// The 10 acceptance scenarios (implementation plan, section 10), run headless with a scripted controller.
import { describe, expect, it } from 'vitest';
import { run, scenario, separation } from './harness';
import { terrainMsa, finalZone, departureZone, FIELD_ELEV, horizontalMinimum } from '../src/shared/airspace';
import { SWEEP_SEC } from '../src/sim/world';

describe('Scenario 1: head-on en route conflict', () => {
  it('advises at least 5 min before LOS and the accepted resolution keeps 5 NM / 1,000 ft', () => {
    let worst = Infinity;
    const r = run(scenario('01-head-on'), {
      onTick: (res) => {
        const s = separation(res.engine, 'DAL101', 'AAL202');
        if (s) worst = Math.min(worst, Math.max(s.h / 5, s.v / 1000));
      },
    });
    const first = r.engine.st.metrics.delivered.find((d) => d.source === 'separation');
    expect(first, 'a separation advisory was delivered').toBeTruthy();
    // Geometric LOS without resolution: 95 NM of closure at 900 kt.
    const losT = (95 / 900) * 3600;
    expect(losT - first!.t).toBeGreaterThanOrEqual(300);
    expect(r.events.some((e) => e.kind === 'advisory.accept')).toBe(true);
    expect(worst).toBeGreaterThanOrEqual(1);
  });
});

describe('Scenario 2: crossing conflict, one climbing', () => {
  it('shows an altitude or vector resolution and creates no secondary conflict', () => {
    const lossPairs = new Set<string>();
    const r = run(scenario('02-crossing-climb'), {
      onTick: (res) => {
        const ac = res.engine.world.aircraft;
        for (let i = 0; i < ac.length; i++) for (let j = i + 1; j < ac.length; j++) {
          const h = Math.hypot(ac[i].x - ac[j].x, ac[i].y - ac[j].y), v = Math.abs(ac[i].alt - ac[j].alt);
          if (h < horizontalMinimum(ac[i], ac[j]) && v < 1000) lossPairs.add(`${ac[i].callsign}-${ac[j].callsign}`);
        }
      },
    });
    const sep = r.engine.st.metrics.delivered.filter((d) => d.source === 'separation');
    expect(sep.length).toBeGreaterThan(0);
    expect(sep.some((d) => d.action.some((c) => c.alt !== undefined || c.hdg !== undefined))).toBe(true);
    expect([...lossPairs]).toEqual([]);
  });
});

describe('Scenario 3: agents off, conflict alert on', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`no advisory, SafetyNet CA about 2 min before LOS (seed ${seed})`, () => {
      let losT: number | undefined;
      const r = run(scenario('03-agents-off'), {
        seed,
        onTick: (res, frame) => {
          const s = separation(res.engine, 'DAL101', 'AAL202');
          if (losT === undefined && s && s.h < 5 && s.v < 1000) losT = frame.t;
        },
        until: () => losT !== undefined,
      });
      expect(r.engine.st.metrics.delivered.length).toBe(0);
      const ca = r.alerts.find((a) => a.alert.kind === 'CA');
      expect(ca).toBeTruthy();
      expect(losT).toBeDefined();
      const lead = losT! - ca!.t;
      expect(lead).toBeGreaterThanOrEqual(90);
      expect(lead).toBeLessThanOrEqual(150);
    });
  }
});

describe('Scenario 4: arrival surge', () => {
  it('keeps wake spacing and average runway time error under 30 s', () => {
    const r = run(scenario('04-arrival-surge'));
    const m = r.engine.st.metrics;
    expect(m.runwayErrors.length).toBeGreaterThanOrEqual(40);
    const avg = m.runwayErrors.reduce((s, e) => s + Math.abs(e.err), 0) / m.runwayErrors.length;
    expect(avg).toBeLessThan(30);
    const violations = m.spacing.filter((s) => s.distNm < s.required - 0.1);
    expect(violations).toEqual([]);
  }, 120_000);
});

describe('Scenario 5: terrain', () => {
  it('raises MSAW within one sweep of descending below the minimum safe altitude', () => {
    let belowTick: number | undefined;
    const r = run(scenario('05-terrain'), {
      onTick: (res, frame) => {
        const ac = res.engine.world.find('EDV505');
        if (belowTick === undefined && ac && !finalZone(ac) && !departureZone(ac) && ac.alt > FIELD_ELEV + 200 && ac.alt < terrainMsa(ac)) belowTick = frame.tick;
      },
    });
    expect(belowTick).toBeDefined();
    const msaw = r.alerts.find((a) => a.alert.kind === 'MSAW' && a.alert.flights.includes('EDV505'));
    expect(msaw).toBeTruthy();
    expect(msaw!.tick).toBeLessThanOrEqual(belowTick! + 1);
  });
});

describe('Scenario 6: runway incursion', () => {
  it('raises a runway alert within one sweep of the conflicting clearance', () => {
    const r = run(scenario('06-runway-incursion'));
    const clr = r.events.find((e) => e.kind === 'clearance' && (e.payload.clearance as { lineup?: string }).lineup);
    expect(clr).toBeTruthy();
    const rwy = r.alerts.find((a) => a.alert.kind === 'RWY');
    expect(rwy).toBeTruthy();
    expect(rwy!.tick).toBeLessThanOrEqual(clr!.tick + 1);
  });
});

describe('Scenario 7: emergency', () => {
  it('alerts all consoles and reprioritizes agents within 5 s', () => {
    const r = run(scenario('07-emergency'), { maxSec: 200 });
    const sq = r.events.find((e) => e.kind === 'squawk');
    expect(sq).toBeTruthy();
    const emerg = r.alerts.find((a) => a.alert.kind === 'EMERG' && a.alert.flights.includes('DAL707'));
    expect(emerg).toBeTruthy();
    expect(emerg!.tick).toBeLessThanOrEqual(sq!.tick + 1);
    const adv = r.engine.st.metrics.delivered.find((d) => d.flights.includes('DAL707') && d.t >= sq!.t);
    expect(adv).toBeTruthy();
    expect(adv!.t - sq!.t).toBeLessThanOrEqual(5);
  });
});

describe('Scenario 8: lost comms', () => {
  it('NORDO flight continues on its last clearance; other traffic is advised around it', () => {
    const track: { hdg: number; alt: number }[] = [];
    const r = run(scenario('08-lost-comms'), {
      onTick: (res) => {
        const a = res.engine.world.find('NKS808');
        if (a) track.push({ hdg: a.hdg, alt: a.alt });
      },
    });
    const delivered = r.engine.st.metrics.delivered.filter((d) => d.source === 'separation');
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.every((d) => d.action.every((c) => c.flight !== 'NKS808'))).toBe(true);
    expect(delivered.some((d) => d.action.some((c) => c.flight === 'FDX809'))).toBe(true);
    expect(track.every((p) => Math.abs(p.hdg - 45) < 0.01 && Math.abs(p.alt - 24000) < 1)).toBe(true);
  });
});

describe('Scenario 9: wrong readback', () => {
  it('alerts on readback mismatch before the aircraft reaches the wrong altitude', () => {
    const r = run(scenario('09-wrong-readback'));
    const rb = r.readbackAlerts.find((a) => a.alert.kind === 'READBACK');
    expect(rb).toBeTruthy();
    const clr = r.events.find((e) => e.kind === 'clearance');
    expect(rb!.t - clr!.t).toBeLessThanOrEqual(8 + SWEEP_SEC);
    // Altitude when the alert fired
    const frame = r.frames.find((f) => f.tick === rb!.tick);
    const alt = frame?.tracks.find((t) => t.callsign === 'ASA909')?.alt ?? 0;
    expect(alt).toBeGreaterThan(10000);
  });
});

describe('Scenario 10: multiplayer handoff', () => {
  it('proposes 3-5 min out, waits for the human receiver, then ownership moves', () => {
    const r = run(scenario('10-multiplayer-handoff'), {
      staffed: ['CTR-NW', 'APP'],
      until: (res) => res.events.some((e) => e.kind === 'handoff' && e.payload.state === 'proposed'),
    });
    const prop = r.events.find((e) => e.kind === 'handoff' && e.payload.state === 'proposed')!;
    expect(prop.payload.from).toBe('CTR-NW');
    expect(prop.payload.to).toBe('APP');
    expect(prop.payload.crossInSec as number).toBeGreaterThanOrEqual(180);
    expect(prop.payload.crossInSec as number).toBeLessThanOrEqual(320);
    // Not auto-accepted while a human holds APP
    for (let i = 0; i < 5; i++) r.engine.tick();
    expect(r.engine.world.find('JBU1010')!.owner).toBe('CTR-NW');
    expect(r.engine.acceptHandoff('JBU1010', { position: 'CTR-NW', name: 'wrong' }).ok).toBe(false);
    expect(r.engine.acceptHandoff('JBU1010', { position: 'APP', name: 'app' }).ok).toBe(true);
    expect(r.engine.world.find('JBU1010')!.owner).toBe('APP');
    const sweep = r.engine.drain().messages.filter((m) => m.type === 'sweep').pop();
    expect(sweep && sweep.type === 'sweep' && sweep.flights.find((f) => f.callsign === 'JBU1010')?.owner).toBe('APP');
  });
});
