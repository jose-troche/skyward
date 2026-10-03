// Scenario library. JSON files are bundled into both the Worker and the console.
import type { Scenario } from '../src/sim/scenario';
import s01 from './01-head-on.json';
import s02 from './02-crossing-climb.json';
import s03 from './03-agents-off.json';
import s04 from './04-arrival-surge.json';
import s05 from './05-terrain.json';
import s06 from './06-runway-incursion.json';
import s07 from './07-emergency.json';
import s08 from './08-lost-comms.json';
import s09 from './09-wrong-readback.json';
import s10 from './10-multiplayer-handoff.json';
import light from './free-light.json';
import busy from './free-busy.json';

export const SCENARIOS: Scenario[] = [light, busy, s01, s02, s03, s04, s05, s06, s07, s08, s09, s10] as Scenario[];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
