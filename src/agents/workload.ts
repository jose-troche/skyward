// Workload agent (every 60 s): simple per-position score; suggests splitting or combining positions.
import { POSITIONS, type Advisory, type Handoff, type PositionId, type WorkloadScore } from '../shared/types';
import type { Aircraft } from '../sim/world';
import type { Conflict } from './separation';

export type WorkloadInput = {
  aircraft: Aircraft[];
  conflicts: Conflict[];
  advisories: Advisory[];
  handoffs: Record<string, Handoff>;
  combined: Partial<Record<PositionId, PositionId>>;
};

export class WorkloadAgent {
  readonly id = 'workload' as const;
  scores: WorkloadScore[] = [];
  recommendations: string[] = [];

  run(inp: WorkloadInput) {
    const eff = (p: PositionId) => inp.combined[p] ?? p;
    const owner = new Map(inp.aircraft.map((a) => [a.callsign, a.owner]));
    this.scores = POSITIONS.map((position) => {
      const aircraft = inp.aircraft.filter((a) => eff(a.owner) === position).length;
      const conflicts = inp.conflicts.filter((c) => eff(owner.get(c.a) ?? 'APP') === position || eff(owner.get(c.b) ?? 'APP') === position).length;
      const pending = inp.advisories.filter((a) => eff(a.position) === position).length + Object.values(inp.handoffs).filter((h) => h.state === 'proposed' && eff(h.to) === position).length;
      return { position, aircraft, conflicts, pending, score: aircraft + 3 * conflicts + pending };
    });
    const rec: string[] = [];
    for (const [from, into] of Object.entries(inp.combined) as [PositionId, PositionId][]) {
      const s = this.scores.find((x) => x.position === into)!;
      if (s.score > 14) rec.push(`Split ${from} from ${into} (score ${s.score}) within 15 min`);
    }
    const nw = this.scores.find((s) => s.position === 'CTR-NW')!, se = this.scores.find((s) => s.position === 'CTR-SE')!;
    if (!inp.combined['CTR-SE'] && !inp.combined['CTR-NW'] && nw.score + se.score < 6) rec.push(`Combine CTR-SE into CTR-NW (combined score ${nw.score + se.score})`);
    const app = this.scores.find((s) => s.position === 'APP')!;
    if (app.score > 16) rec.push(`APP workload high (${app.score}); consider a final/feeder split`);
    this.recommendations = rec;
  }
}
