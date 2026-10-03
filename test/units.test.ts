import { describe, expect, it } from 'vitest';
import { parseCommand, phraseology, readbackText, formatCommand } from '../src/shared/commands';
import { SafetyNets, conflictAlerts } from '../src/safety/nets';
import { Arbiter } from '../src/agents/arbiter';
import { geoSector, wakeSpacing, terrainMsa } from '../src/shared/airspace';
import type { Advisory, RawFrame, RawTrack } from '../src/shared/types';

describe('command line', () => {
  it('parses multi-instruction commands', () => {
    const p = parseCommand('dal123 h250 d060 s210');
    expect(p).toEqual({ ok: true, handoff: false, clearance: { flight: 'DAL123', hdg: 250, alt: 6000, spd: 210 } });
  });
  it('parses direct, approach, takeoff and handoff', () => {
    expect(parseCommand('AAL456 DCT NWARD')).toMatchObject({ ok: true, clearance: { direct: 'NWARD' } });
    expect(parseCommand('AAL456 ILS 27L')).toMatchObject({ ok: true, clearance: { approach: '27L' } });
    expect(parseCommand('AAL456 CTO 27L')).toMatchObject({ ok: true, clearance: { takeoff: '27L' } });
    expect(parseCommand('AAL456 HO')).toMatchObject({ ok: true, handoff: true });
  });
  it('rejects bad input', () => {
    expect(parseCommand('DAL123').ok).toBe(false);
    expect(parseCommand('DAL123 H999').ok).toBe(false);
    expect(parseCommand('DAL123 DCT NOWHERE').ok).toBe(false);
    expect(parseCommand('DAL123 XYZ').ok).toBe(false);
  });
  it('renders phraseology and readbacks', () => {
    expect(phraseology({ flight: 'DAL123', hdg: 250, alt: 6000 }, { currentAlt: 11000, currentHdg: 300 })).toBe('DAL123, turn left heading 250, descend and maintain 6,000');
    expect(phraseology({ flight: 'DAL123', alt: 24000 }, { currentAlt: 11000 })).toBe('DAL123, climb and maintain flight level 240');
    expect(readbackText({ flight: 'DAL123', alt: 6000 })).toBe('6,000, DAL123');
    expect(formatCommand({ flight: 'DAL123', alt: 6000 }, 11000)).toBe('DAL123 D060');
  });
});

describe('airspace', () => {
  it('maps positions', () => {
    expect(geoSector({ x: 0, y: 2 }, 2000)).toBe('TWR');
    expect(geoSector({ x: 10, y: 10 }, 8000)).toBe('APP');
    expect(geoSector({ x: -50, y: 20 }, 20000)).toBe('CTR-NW');
    expect(geoSector({ x: 50, y: -20 }, 20000)).toBe('CTR-SE');
  });
  it('has RECAT spacing and high terrain to the north', () => {
    expect(wakeSpacing('A', 'F')).toBe(8);
    expect(wakeSpacing('D', 'D')).toBe(3);
    expect(terrainMsa({ x: -10, y: 60 })).toBeGreaterThan(terrainMsa({ x: 0, y: -60 }));
  });
});

const track = (cs: string, x: number, y: number, alt: number, trk: number, gs = 450, extra: Partial<RawTrack> = {}): RawTrack => ({ id: cs, callsign: cs, x, y, alt, gs, trk, vs: 0, squawk: '1234', onGround: false, ...extra });

describe('safety nets', () => {
  it('raises CA with ~2 min look-ahead and clears with hysteresis', () => {
    const nets = new SafetyNets();
    // closing at 900 kt, 30 NM apart: LOS (5 NM) in 100 s
    const frame: RawFrame = { t: 0, tick: 0, tracks: [track('A', -60, 0, 24000, 90), track('B', -30, 0, 24000, 270)], runwayClearances: [] };
    expect(nets.process(frame).raised.map((a) => a.kind)).toEqual(['CA']);
    const apart: RawFrame = { t: 5, tick: 1, tracks: [track('A', -60, 0, 24000, 90), track('B', -30, 0, 30000, 270)], runwayClearances: [] };
    expect(nets.process(apart).cleared.length).toBe(0);
    expect(nets.process({ ...apart, tick: 2 }).cleared.length).toBe(1);
  });
  it('does not alert far-apart traffic', () => {
    const frame: RawFrame = { t: 0, tick: 0, tracks: [track('A', -90, 0, 24000, 90), track('B', 0, 0, 24000, 270)], runwayClearances: [] };
    expect(conflictAlerts(frame)).toEqual([]);
  });
  it('alerts emergency squawks', () => {
    const nets = new SafetyNets();
    const res = nets.process({ t: 0, tick: 0, tracks: [track('A', -60, 0, 24000, 90, 450, { squawk: '7700' })], runwayClearances: [] });
    expect(res.raised[0]).toMatchObject({ kind: 'EMERG', severity: 'warning' });
  });
});

describe('arbiter', () => {
  const adv = (key: string, priority: Advisory['priority'], flight: string, position: Advisory['position'] = 'APP'): Advisory => ({
    id: '', key, source: 'sequencer', position, flights: [flight], action: [{ flight, spd: 210 }], rationale: { rule: '', text: '', inputs: {} },
    predicted: { minSepNm: 9, delaySec: 0 }, confidence: 1, priority, authority: 1, createdAt: 0, expiresAt: 100, modelVersion: 't',
  });
  it('keeps at most 3 per position, in precedence order', () => {
    const a = new Arbiter();
    a.submit('sequencer', [adv('a', 6, 'A1'), adv('b', 5, 'B1'), adv('c', 5, 'C1'), adv('d', 4, 'D1')], 0);
    const out = a.deliver({ effective: (p) => p, recentControllerClearance: () => false, emergencies: new Set() }).get('APP')!;
    expect(out.map((x) => x.key)).toEqual(['d', 'b', 'c']);
  });
  it('suppresses rejected advisories and expires old ones', () => {
    const a = new Arbiter();
    a.submit('sequencer', [adv('a', 5, 'A1')], 0);
    const id = a.state.pool[0].id;
    a.remove(id, { reject: true, now: 1 });
    a.submit('sequencer', [adv('a', 5, 'A1')], 2);
    expect(a.state.pool.length).toBe(0);
    a.submit('sequencer', [adv('b', 5, 'B1')], 2);
    expect(a.expire(200).length).toBe(1);
  });
  it('drops flow advice for a flight the controller just worked', () => {
    const a = new Arbiter();
    a.submit('sequencer', [adv('a', 5, 'A1')], 0);
    const out = a.deliver({ effective: (p) => p, recentControllerClearance: (cs) => cs === 'A1', emergencies: new Set() });
    expect(out.get('APP') ?? []).toEqual([]);
  });
});
