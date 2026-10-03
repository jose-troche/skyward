// Deterministic controller command language and phraseology.
//   DAL123 H250        fly heading 250
//   DAL123 D060 / C120 descend / climb and maintain 6,000 / 12,000 (hundreds of feet)
//   DAL123 A080        altitude 8,000 (either direction)
//   DAL123 S210        speed 210 knots
//   DAL123 DCT NWARD   proceed direct NWARD
//   DAL123 ILS 27L     cleared ILS runway 27L approach
//   DAL123 LUAW 27L    line up and wait runway 27L
//   DAL123 CTO 27L     cleared for takeoff runway 27L
//   DAL123 RES         resume own navigation
//   DAL123 HO          accept inbound handoff
// Several instructions may follow one callsign: "DAL123 H250 D060 S210".
import type { Clearance } from './types';
import { RUNWAYS, FIXES } from './airspace';

export type ParsedCommand = { ok: true; clearance: Clearance; handoff: boolean } | { ok: false; error: string };

export function parseCommand(input: string): ParsedCommand {
  const tokens = input.trim().toUpperCase().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { ok: false, error: 'Expected: CALLSIGN INSTRUCTION…' };
  const [callsign, ...rest] = tokens;
  if (!/^[A-Z]{2,4}\d{1,4}[A-Z]?$/.test(callsign)) return { ok: false, error: `Bad callsign ${callsign}` };
  const c: Clearance = { flight: callsign };
  let handoff = false;
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    let m: RegExpMatchArray | null;
    if ((m = tok.match(/^H(\d{1,3})$/))) {
      const h = Number(m[1]);
      if (h < 1 || h > 360) return { ok: false, error: `Bad heading ${m[1]}` };
      c.hdg = h;
    } else if ((m = tok.match(/^[DCA](\d{2,3})$/))) {
      const alt = Number(m[1]) * 100;
      if (alt < 1000 || alt > 45000) return { ok: false, error: `Bad altitude ${m[1]}` };
      c.alt = alt;
    } else if ((m = tok.match(/^S(\d{3})$/))) {
      const s = Number(m[1]);
      if (s < 100 || s > 500) return { ok: false, error: `Bad speed ${m[1]}` };
      c.spd = s;
    } else if (tok === 'DCT' || tok === 'DIR') {
      const fix = rest[++i];
      if (!fix || !FIXES[fix]) return { ok: false, error: `Unknown fix ${fix ?? ''}` };
      c.direct = fix;
    } else if (tok === 'ILS' || tok === 'APP' || tok === 'LUAW' || tok === 'CTO') {
      const rwy = rest[++i];
      if (!rwy || !RUNWAYS[rwy]) return { ok: false, error: `Unknown runway ${rwy ?? ''}` };
      if (tok === 'LUAW') c.lineup = rwy;
      else if (tok === 'CTO') c.takeoff = rwy;
      else c.approach = rwy;
    } else if ((m = tok.match(/^(?:ILS|I)(\d{2}[LRC]?)$/)) && RUNWAYS[m[1]]) {
      c.approach = m[1];
    } else if (tok === 'RES') {
      c.resume = true;
    } else if (tok === 'HO') {
      handoff = true;
    } else {
      return { ok: false, error: `Unknown instruction ${tok}` };
    }
  }
  if (!handoff && !hasInstruction(c)) return { ok: false, error: 'No instruction' };
  return { ok: true, clearance: c, handoff };
}

export function hasInstruction(c: Clearance): boolean {
  return c.hdg !== undefined || c.alt !== undefined || c.spd !== undefined || !!c.direct || !!c.approach || !!c.lineup || !!c.takeoff || !!c.resume;
}

/** Short command form, e.g. "DAL123 H250 D060". */
export function formatCommand(c: Clearance, currentAlt?: number): string {
  const parts = [c.flight];
  if (c.hdg !== undefined) parts.push(`H${String(c.hdg).padStart(3, '0')}`);
  if (c.alt !== undefined) {
    const letter = currentAlt === undefined ? 'A' : c.alt < currentAlt ? 'D' : 'C';
    parts.push(`${letter}${String(Math.round(c.alt / 100)).padStart(3, '0')}`);
  }
  if (c.spd !== undefined) parts.push(`S${c.spd}`);
  if (c.direct) parts.push(`DCT ${c.direct}`);
  if (c.approach) parts.push(`ILS ${c.approach}`);
  if (c.lineup) parts.push(`LUAW ${c.lineup}`);
  if (c.takeoff) parts.push(`CTO ${c.takeoff}`);
  if (c.resume) parts.push('RES');
  return parts.join(' ');
}

export function sayAlt(alt: number): string {
  if (alt >= 18000) return `flight level ${Math.round(alt / 100)}`;
  return `${alt.toLocaleString('en-US')}`;
}

export function sayHdg(h: number): string {
  return String(h).padStart(3, '0');
}

/** Controller phraseology for a clearance. */
export function phraseology(c: Clearance, ctx: { currentAlt?: number; currentHdg?: number } = {}): string {
  const parts: string[] = [];
  if (c.hdg !== undefined) {
    let dir = 'fly';
    if (ctx.currentHdg !== undefined) {
      const d = ((c.hdg - ctx.currentHdg + 540) % 360) - 180;
      if (Math.abs(d) >= 5) dir = d > 0 ? 'turn right' : 'turn left';
    }
    parts.push(`${dir} heading ${sayHdg(c.hdg)}`);
  }
  if (c.alt !== undefined) {
    const verb = ctx.currentAlt === undefined ? 'maintain' : c.alt < ctx.currentAlt - 100 ? 'descend and maintain' : c.alt > ctx.currentAlt + 100 ? 'climb and maintain' : 'maintain';
    parts.push(`${verb} ${sayAlt(c.alt)}`);
  }
  if (c.spd !== undefined) parts.push(`${ctx.currentAlt !== undefined ? 'adjust' : 'maintain'} speed ${c.spd} knots`);
  if (c.direct) parts.push(`proceed direct ${c.direct}`);
  if (c.approach) parts.push(`cleared ILS runway ${c.approach} approach`);
  if (c.lineup) parts.push(`runway ${c.lineup}, line up and wait`);
  if (c.takeoff) parts.push(`runway ${c.takeoff}, cleared for takeoff`);
  if (c.resume) parts.push('resume own navigation');
  return `${c.flight}, ${parts.join(', ')}`;
}

/** Pilot readback text. */
export function readbackText(c: Clearance): string {
  const parts: string[] = [];
  if (c.hdg !== undefined) parts.push(`heading ${sayHdg(c.hdg)}`);
  if (c.alt !== undefined) parts.push(sayAlt(c.alt));
  if (c.spd !== undefined) parts.push(`speed ${c.spd}`);
  if (c.direct) parts.push(`direct ${c.direct}`);
  if (c.approach) parts.push(`cleared ILS ${c.approach}`);
  if (c.lineup) parts.push(`line up and wait ${c.lineup}`);
  if (c.takeoff) parts.push(`cleared for takeoff ${c.takeoff}`);
  if (c.resume) parts.push('resume own nav');
  return `${parts.join(', ')}, ${c.flight}`;
}

/** Compare an issued clearance with what was read back. Returns mismatched fields. */
export function readbackMismatch(issued: Clearance, readback: Clearance): string[] {
  const out: string[] = [];
  for (const k of ['hdg', 'alt', 'spd', 'direct', 'approach', 'lineup', 'takeoff'] as const) {
    if (issued[k] !== undefined && issued[k] !== readback[k]) out.push(k);
  }
  return out;
}
