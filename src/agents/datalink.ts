// Datalink agent: renders accepted clearances as phraseology (CPDLC-style draft) and checks the
// simulated pilot readback against what was issued (FR-RBK-01).
import { formatCommand, phraseology, readbackMismatch, sayAlt } from '../shared/commands';
import type { Alert, Clearance } from '../shared/types';
import type { Readback } from '../sim/world';

export class DatalinkAgent {
  readonly id = 'datalink' as const;

  render(c: Clearance, ctx: { currentAlt?: number; currentHdg?: number }, enabled: boolean): string {
    return enabled ? phraseology(c, ctx) : formatCommand(c, ctx.currentAlt);
  }

  check(rb: Readback, serial: number): Alert | undefined {
    const bad = readbackMismatch(rb.issued, rb.flown);
    if (!bad.length) return undefined;
    const what = bad.map((k) => {
      const i = rb.issued[k as keyof Clearance], f = rb.flown[k as keyof Clearance];
      if (k === 'alt') return `altitude: issued ${sayAlt(i as number)}, read back ${sayAlt(f as number)}`;
      if (k === 'hdg') return `heading: issued ${i}, read back ${f}`;
      return `${k}: issued ${i}, read back ${f}`;
    });
    return { id: `READBACK:${rb.callsign}#${serial}`, kind: 'READBACK', flights: [rb.callsign], severity: 'warning', at: rb.t, text: `READBACK ${rb.callsign} ${what.join('; ')}` };
  }
}
