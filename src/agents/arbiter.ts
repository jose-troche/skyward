// Arbiter: dedupes proposals, applies the spec's precedence order, and delivers at most
// 3 active advisories per controller position. It cannot originate an action.
import type { Advisory, AgentId, PositionId } from '../shared/types';

export const MAX_PER_POSITION = 3;
const REJECT_COOLDOWN = 120; // s before a rejected advisory may be proposed again
const EXPIRE_COOLDOWN = 20;

export type ArbiterState = {
  pool: Advisory[]; // all live proposals (shown or queued)
  suppressed: Record<string, number>; // key -> until (sim s)
  serial: number;
};

export class Arbiter {
  constructor(public state: ArbiterState = { pool: [], suppressed: {}, serial: 0 }) {}

  /** Replace one agent's proposals with its latest set (keeping identity for unchanged keys). */
  submit(agent: AgentId, proposals: Advisory[], now: number) {
    const existing = new Map(this.state.pool.filter((a) => a.source === agent).map((a) => [a.key, a]));
    const others = this.state.pool.filter((a) => a.source !== agent);
    const next: Advisory[] = [];
    const seen = new Set<string>();
    for (const p of proposals) {
      if (seen.has(p.key)) continue; // dedupe
      seen.add(p.key);
      if ((this.state.suppressed[p.key] ?? -1) > now) continue;
      const old = existing.get(p.key);
      if (old) next.push({ ...p, id: old.id, createdAt: old.createdAt, expiresAt: old.expiresAt });
      else next.push({ ...p, id: p.id || `ADV${(++this.state.serial).toString().padStart(4, '0')}` });
    }
    this.state.pool = [...others, ...next];
  }

  /** Drop expired advisories; returns the dropped ones. */
  expire(now: number): Advisory[] {
    const expired = this.state.pool.filter((a) => a.expiresAt <= now);
    for (const a of expired) this.state.suppressed[a.key] = now + EXPIRE_COOLDOWN;
    this.state.pool = this.state.pool.filter((a) => a.expiresAt > now);
    for (const [k, until] of Object.entries(this.state.suppressed)) if (until <= now) delete this.state.suppressed[k];
    return expired;
  }

  remove(id: string, opts: { reject?: boolean; now: number }): Advisory | undefined {
    const adv = this.state.pool.find((a) => a.id === id);
    if (!adv) return undefined;
    this.state.pool = this.state.pool.filter((a) => a.id !== id);
    if (opts.reject) this.state.suppressed[adv.key] = opts.now + REJECT_COOLDOWN;
    // accepting/rejecting one ranked resolution retires its siblings
    if (adv.group) {
      for (const s of this.state.pool.filter((a) => a.group === adv.group)) this.state.suppressed[s.key] = opts.now + (opts.reject ? 0 : REJECT_COOLDOWN);
      if (!opts.reject) this.state.pool = this.state.pool.filter((a) => a.group !== adv.group);
    }
    return adv;
  }

  removeForFlight(callsign: string) {
    this.state.pool = this.state.pool.filter((a) => !a.flights.includes(callsign));
  }

  find(id: string): Advisory | undefined {
    return this.state.pool.find((a) => a.id === id);
  }

  /**
   * Precedence (spec section 4):
   *  1 safety-net alerts (never pass through the Arbiter), 2 separation, 3 controller instructions
   *  already issued, 4 emergencies, 5 flow, 6 efficiency.
   */
  deliver(ctx: {
    effective: (p: PositionId) => PositionId;
    recentControllerClearance: (callsign: string) => boolean;
    emergencies: Set<string>;
  }): Map<PositionId, Advisory[]> {
    const live = this.state.pool.map((a) => (a.flights.some((f) => ctx.emergencies.has(f)) && a.priority > 4 && a.source !== 'centerFlow' ? { ...a, priority: 4 as const } : a));
    // A flight with a separation resolution gets no lower-priority advice at the same time.
    const sepFlights = new Set(live.filter((a) => a.priority <= 2).flatMap((a) => a.action.map((c) => c.flight)));
    const filtered = live.filter((a) => {
      if (a.priority > 2 && a.action.some((c) => sepFlights.has(c.flight))) return false;
      // Precedence 3: a controller's own recent instruction outranks flow/efficiency advice.
      if (a.priority >= 5 && a.action.some((c) => ctx.recentControllerClearance(c.flight))) return false;
      // Flow advice never applies to an emergency aircraft.
      if (a.source === 'centerFlow' && a.flights.some((f) => ctx.emergencies.has(f))) return false;
      return true;
    });
    const byPos = new Map<PositionId, Advisory[]>();
    for (const a of filtered) {
      const pos = ctx.effective(a.position);
      const list = byPos.get(pos) ?? [];
      list.push({ ...a, position: pos });
      byPos.set(pos, list);
    }
    for (const [pos, list] of byPos) {
      list.sort((p, q) => p.priority - q.priority || p.createdAt - q.createdAt || p.id.localeCompare(q.id));
      byPos.set(pos, list.slice(0, MAX_PER_POSITION));
    }
    return byPos;
  }
}
