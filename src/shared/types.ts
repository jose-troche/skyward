// Core SKYWARD Lite types (implementation plan, section 7).
// SIMULATION, NOT FOR OPERATIONAL USE.

export const SCHEMA_VERSION = 1;

export type PositionId = 'CTR-NW' | 'CTR-SE' | 'APP' | 'TWR';
export type ConsolePosition = PositionId | 'SUP' | 'OBS';
export const POSITIONS: PositionId[] = ['CTR-NW', 'CTR-SE', 'APP', 'TWR'];

export type AgentId =
  | 'separation'
  | 'centerFlow'
  | 'sequencer'
  | 'sector'
  | 'workload'
  | 'datalink'
  | 'trajectory'
  // Stubs from the full roster, not implemented in v1.
  | 'nationalFlow'
  | 'surface'
  | 'oceanic'
  | 'weather';

export const TOGGLEABLE_AGENTS: AgentId[] = ['trajectory', 'separation', 'centerFlow', 'sequencer', 'sector', 'workload', 'datalink'];
export const STUB_AGENTS: AgentId[] = ['nationalFlow', 'surface', 'oceanic', 'weather'];

export type Wake = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type Clearance = {
  flight: string; // callsign
  hdg?: number;
  alt?: number;
  spd?: number;
  direct?: string;
  approach?: string; // runway id, e.g. '27L'
  lineup?: string; // runway id
  takeoff?: string; // runway id
  resume?: boolean; // resume own navigation (cancel vectors)
};

export type FlightPhase = 'holding-short' | 'lineup' | 'takeoff' | 'airborne' | 'approach' | 'landed';
export type FlightKind = 'arrival' | 'departure' | 'overflight';

export type Flight = {
  id: string;
  callsign: string;
  type: string;
  wake: Wake;
  pos: { x: number; y: number }; // NM east / north of the airport reference point
  alt: number; // ft
  gs: number; // kt
  trk: number; // deg true
  vs: number; // fpm
  squawk: string;
  owner: PositionId;
  cleared: { alt?: number; hdg?: number; spd?: number; direct?: string; approach?: string };
  plan: { origin: string; dest: string; route: string[] };
  kind: FlightKind;
  phase: FlightPhase;
  runway?: string;
  seq?: number; // arrival sequence number from the Terminal Sequencer
  sta?: number; // scheduled time of arrival at the threshold (sim seconds)
  nordo?: boolean;
  coast?: boolean; // track coasting (radar dropout)
};

export type Advisory = {
  id: string;
  key: string; // stable dedupe key
  group?: string; // advisories resolving the same problem; accepting one drops its siblings
  source: AgentId;
  position: PositionId;
  flights: string[];
  action: Clearance[];
  rationale: { rule: string; text: string; inputs: Record<string, number> };
  predicted: { minSepNm: number; delaySec: number };
  confidence: number;
  priority: 1 | 2 | 3 | 4 | 5 | 6;
  authority: 0 | 1 | 2;
  createdAt: number; // sim seconds
  expiresAt: number; // sim seconds
  modelVersion: string;
};

export type AlertKind = 'CA' | 'MSAW' | 'RWY' | 'EMERG' | 'READBACK';
export type Alert = {
  id: string;
  kind: AlertKind;
  flights: string[];
  severity: 'caution' | 'warning';
  at: number; // sim seconds
  text: string;
};

export type BusEvent = { seq: number; t: number; tick: number; kind: string; payload: unknown }; // append-only log

export type HandoffState = 'proposed' | 'accepted' | 'rejected';
export type Handoff = { flight: string; from: PositionId; to: PositionId; state: HandoffState; at: number; crossInSec: number };

export type CommsLine = { t: number; from: string; to: string; text: string; kind: 'clearance' | 'readback' | 'pilot' | 'system' };

export type Presence = { clientId: string; name: string; position: ConsolePosition };

export type WorkloadScore = { position: PositionId; score: number; aircraft: number; conflicts: number; pending: number };

export type AgentStatus = { id: AgentId; enabled: boolean; suspended: boolean; stub: boolean; lastRunMs: number; rejected: number; error?: string };

export type SimStatus = {
  paused: boolean;
  speed: 1 | 2 | 4;
  t: number;
  tick: number;
  scenario: string;
  seed: number;
  trafficLevel: TrafficLevel;
  combined: Partial<Record<PositionId, PositionId>>;
};

export type TrafficLevel = 'none' | 'light' | 'busy' | 'surge';

// Raw surveillance frame published by the Track agent to the independent safety nets.
export type RawTrack = {
  id: string;
  callsign: string;
  x: number;
  y: number;
  alt: number;
  gs: number;
  trk: number;
  vs: number;
  squawk: string;
  onGround: boolean;
};
export type RunwayClearance = { flight: string; runway: string; kind: 'lineup' | 'takeoff' | 'land' };
export type RawFrame = { t: number; tick: number; tracks: RawTrack[]; runwayClearances: RunwayClearance[] };

// ---- WebSocket protocol ----

export type ServerMessage =
  | { v: 1; type: 'welcome'; clientId: string; session: string; status: SimStatus; scenarioName: string }
  | { v: 1; type: 'sweep'; t: number; tick: number; full: boolean; flights: Flight[]; removed: string[]; sentAt: number }
  | { v: 1; type: 'advisories'; position: PositionId; advisories: Advisory[] }
  | { v: 1; type: 'alert'; alert: Alert; cleared?: boolean }
  | { v: 1; type: 'alerts'; alerts: Alert[] }
  | { v: 1; type: 'handoff'; handoff: Handoff }
  | { v: 1; type: 'comms'; line: CommsLine }
  | { v: 1; type: 'presence'; clients: Presence[] }
  | { v: 1; type: 'status'; status: SimStatus; agents: AgentStatus[]; workload: WorkloadScore[]; recommendations: string[] }
  | { v: 1; type: 'error'; message: string };

export type ClientMessage =
  | { v: 1; type: 'hello'; name: string }
  | { v: 1; type: 'claim'; position: ConsolePosition }
  | { v: 1; type: 'clearance'; clearance: Clearance }
  | { v: 1; type: 'advisory.accept'; id: string; edited?: Clearance[] }
  | { v: 1; type: 'advisory.reject'; id: string; reason: RejectReason }
  | { v: 1; type: 'handoff.accept'; flight: string }
  | { v: 1; type: 'agent.toggle'; agent: AgentId; on: boolean }
  | { v: 1; type: 'sim.control'; action: 'pause' | 'resume' | 'speed' | 'restart' | 'traffic' | 'combine' | 'split'; speed?: 1 | 2 | 4; traffic?: TrafficLevel; position?: PositionId; into?: PositionId; seed?: number; scenario?: string }
  | { v: 1; type: 'alert.ack'; id: string };

export type RejectReason = 'UNSAFE' | 'WORKLOAD' | 'TRAFFIC' | 'PILOT' | 'PREFER-OTHER' | 'OTHER';
export const REJECT_REASONS: RejectReason[] = ['UNSAFE', 'WORKLOAD', 'TRAFFIC', 'PILOT', 'PREFER-OTHER', 'OTHER'];
