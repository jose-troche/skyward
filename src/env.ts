import type { AirspaceDO } from './do/airspace';
import type { SafetyNetDO } from './do/safetynet';
import type { LobbyDO } from './do/lobby';

export type Budgets = {
  doRequests: number;
  doRowsWritten: number;
  doDurationGbS: number;
  workerRequests: number;
  aiNeurons: number;
};

export interface Env {
  AIRSPACE: DurableObjectNamespace<AirspaceDO>;
  SAFETYNET: DurableObjectNamespace<SafetyNetDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
  AI: Ai;
  BUDGETS: Budgets;
  GOVERNOR_THRESHOLD: number;
  AI_MODEL: string;
  IDLE_PAUSE_MS: number;
}

export type UsageDelta = Partial<Budgets>;

export const DO_GB = 0.125; // Durable Objects are billed at 128 MB while active
