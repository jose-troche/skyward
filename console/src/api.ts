import type { BusEvent } from '../../src/shared/types';

export type ScenarioInfo = { id: string; name: string; description: string; traffic: string; seed: number; agentsOff: string[] };
export type SessionInfo = { code: string; scenario: string; scenarioName: string; seed: number; traffic: string; createdAt: number; lastActive: number; controllers: number; paused: boolean; live: boolean };
export type Usage = { day: string; resetsAt: string; threshold: number; accepting: boolean; metrics: Record<string, { used: number; limit: number; pct: number }> };

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  scenarios: () => call<ScenarioInfo[]>('/api/scenarios'),
  sessions: () => call<SessionInfo[]>('/api/sessions'),
  createSession: (body: { scenario: string; seed?: number; traffic?: string }) => call<{ code: string }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }),
  usage: () => call<Usage>('/api/usage'),
  explain: (session: string, advisoryId: string) => call<{ text: string; source: string }>('/api/explain', { method: 'POST', body: JSON.stringify({ session, advisoryId }) }),
  brief: (session: string, position: string) => call<{ text: string; source: string }>('/api/brief', { method: 'POST', body: JSON.stringify({ session, position }) }),
  replay: (session: string) => call<{ scenario: string; seed: number; tick?: number; events: BusEvent[] }>(`/api/sessions/${session}/replay`),
};
