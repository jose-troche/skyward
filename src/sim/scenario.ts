// Scenario file schema (JSON files in /scenarios).
import type { AgentId, Clearance, FlightKind, FlightPhase, PositionId, TrafficLevel } from '../shared/types';

export type WindLayer = { alt: number; dir: number; spd: number }; // dir = from, degrees true

export type ScenarioAircraft = {
  callsign: string;
  type: string;
  kind: FlightKind;
  x: number;
  y: number;
  alt: number;
  hdg: number;
  spd: number;
  clearedAlt?: number;
  clearedHdg?: number;
  route?: string[];
  runway?: string;
  origin?: string;
  dest?: string;
  requestedAlt?: number;
  squawk?: string;
  phase?: FlightPhase;
  approach?: string; // already cleared for this approach
  owner?: PositionId;
};

export type ScenarioEvent =
  | { at: number; kind: 'squawk'; callsign: string; code: string }
  | { at: number; kind: 'wrongReadback'; callsign: string; alt?: number }
  | { at: number; kind: 'engineOut'; callsign: string }
  | { at: number; kind: 'pilotRequest'; callsign: string; text: string }
  | { at: number; kind: 'clearance'; clearance: Clearance; position: PositionId };

export type Scenario = {
  id: string;
  name: string;
  description: string;
  seed: number;
  traffic: TrafficLevel;
  departuresPerHour?: number;
  wind: WindLayer[];
  durationSec: number;
  agentsOff?: AgentId[];
  aircraft: ScenarioAircraft[];
  events: ScenarioEvent[];
  expect: Record<string, unknown>;
};

export const TRAFFIC_RATES: Record<TrafficLevel, { arrivalsPerHour: number; departuresPerHour: number }> = {
  none: { arrivalsPerHour: 0, departuresPerHour: 0 },
  light: { arrivalsPerHour: 20, departuresPerHour: 8 },
  busy: { arrivalsPerHour: 45, departuresPerHour: 12 },
  surge: { arrivalsPerHour: 70, departuresPerHour: 6 },
};
