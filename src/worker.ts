// SKYWARD Lite Worker: routes REST calls and WebSocket upgrades; does no simulation work.
// Static console assets are served by Workers Static Assets without invoking this code.
// SIMULATION, NOT FOR OPERATIONAL USE.
import type { Env } from './env';
import { SCENARIOS, getScenario } from '../scenarios';
import { POSITIONS, type Advisory, type PositionId, type TrafficLevel } from './shared/types';
import { formatCommand } from './shared/commands';

export { AirspaceDO } from './do/airspace';
export { SafetyNetDO } from './do/safetynet';
export { LobbyDO } from './do/lobby';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TRAFFIC: TrafficLevel[] = ['none', 'light', 'busy', 'surge'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function roomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const validCode = (c: string) => /^[A-Z0-9]{4,8}$/.test(c);

/** Workers AI neuron estimate for the configured small model (plan section 8). */
function neurons(inChars: number, outChars: number): number {
  return ((inChars / 4) * 4625 + (outChars / 4) * 30475) / 1e6;
}

async function generate(env: Env, system: string, user: string, maxTokens: number): Promise<string | undefined> {
  try {
    const res = (await env.AI.run(env.AI_MODEL as keyof AiModels, { messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: maxTokens } as never)) as { response?: string };
    const text = res?.response?.trim();
    const lobby = env.LOBBY.getByName('lobby');
    await lobby.recordUsage({ aiNeurons: neurons(system.length + user.length, text?.length ?? 0) });
    return text || undefined;
  } catch (e) {
    console.error('workers ai failed', e);
    return undefined;
  }
}

/** Deterministic validator: LLM text may never introduce numbers (headings, altitudes) absent from the advisory. */
function validExplanation(text: string, adv: Advisory): boolean {
  const allowed = new Set(JSON.stringify(adv).match(/\d+(\.\d+)?/g) ?? []);
  const nums = text.match(/\d+(\.\d+)?/g) ?? [];
  return nums.every((n) => allowed.has(n) || allowed.has(n.replace(/,/g, ''))) && text.length < 400;
}

async function explain(env: Env, body: { session?: string; advisoryId?: string }): Promise<Response> {
  if (!body.session || !validCode(body.session) || !body.advisoryId) return json({ error: 'session and advisoryId required' }, 400);
  const adv = await env.AIRSPACE.getByName(body.session).getAdvisory(body.advisoryId);
  if (!adv) return json({ error: 'Advisory not found' }, 404);
  const structured = {
    agent: adv.source, rule: adv.rationale.rule, action: adv.action.map((c) => formatCommand(c)).join('; '), flights: adv.flights,
    inputs: adv.rationale.inputs, predictedMinSepNm: adv.predicted.minSepNm, predictedDelaySec: adv.predicted.delaySec, draft: adv.rationale.text,
  };
  const text = await generate(
    env,
    'You explain air traffic control advisories to a controller in a training SIMULATION. Reply with exactly one plain-English sentence under 35 words. Use only facts in the JSON. Never invent instructions, headings, altitudes or numbers.',
    JSON.stringify(structured),
    80,
  );
  const sentence = text ? text.split(/(?<=[.!?])\s/)[0] : undefined;
  if (sentence && validExplanation(sentence, adv)) return json({ text: sentence, source: 'workers-ai', model: env.AI_MODEL });
  return json({ text: adv.rationale.text, source: 'template' });
}

async function brief(env: Env, body: { session?: string; position?: string }): Promise<Response> {
  if (!body.session || !validCode(body.session)) return json({ error: 'session required' }, 400);
  const position = (POSITIONS as string[]).includes(body.position ?? '') ? (body.position as PositionId) : ('APP' as PositionId);
  const ctx = await env.AIRSPACE.getByName(body.session).briefingContext(position);
  if (!ctx) return json({ error: 'Session not found' }, 404);
  const fallback = templateBrief(ctx);
  const text = await generate(
    env,
    'You write a position relief briefing for an air traffic controller taking over a position in a training SIMULATION. Use 4-7 short bullet lines: traffic, pending handoffs, active alerts/emergencies, open advisories, agent status, anything unusual from the last 10 minutes. Only use facts from the JSON.',
    JSON.stringify(ctx).slice(0, 7000),
    300,
  );
  return json({ text: text ?? fallback, source: text ? 'workers-ai' : 'template', model: text ? env.AI_MODEL : undefined, context: ctx });
}

function templateBrief(ctx: Record<string, unknown>): string {
  const traffic = (ctx.traffic as { callsign: string; alt: number; squawk: string }[]) ?? [];
  const adv = (ctx.advisories as { why: string }[]) ?? [];
  const ho = (ctx.pendingHandoffs as { flight: string; from: string; to: string }[]) ?? [];
  const agents = (ctx.agents as { id: string; on: boolean }[]) ?? [];
  const lines = [
    `• ${ctx.position}: ${traffic.length} aircraft${traffic.length ? ` (${traffic.slice(0, 8).map((t) => `${t.callsign} ${Math.round(t.alt / 100)}`).join(', ')})` : ''}.`,
    `• Emergencies: ${traffic.filter((t) => ['7700', '7600', '7500'].includes(t.squawk)).map((t) => `${t.callsign} ${t.squawk}`).join(', ') || 'none'}.`,
    `• Pending handoffs: ${ho.map((h) => `${h.flight} ${h.from}→${h.to}`).join(', ') || 'none'}.`,
    `• Open advisories: ${adv.map((a) => a.why).join(' | ') || 'none'}.`,
    `• Agents off: ${agents.filter((a) => !a.on).map((a) => a.id).join(', ') || 'none'}.`,
  ];
  return lines.join('\n');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const lobby = env.LOBBY.getByName('lobby');

    // WebSocket upgrades: two sockets per console
    let m = path.match(/^\/ws\/(airspace|safety)\/([A-Z0-9]+)$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const [, kind, code] = m;
      if (!validCode(code)) return new Response('Bad session code', { status: 400 });
      return kind === 'airspace' ? env.AIRSPACE.getByName(code).fetch(request) : env.SAFETYNET.getByName(code).fetch(request);
    }

    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404 });

    try {
      if (path === '/api/health') return json({ ok: true, notice: 'SIMULATION, NOT FOR OPERATIONAL USE' });

      if (path === '/api/scenarios' && request.method === 'GET') {
        return json(SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description, traffic: s.traffic, seed: s.seed, agentsOff: s.agentsOff ?? [] })));
      }

      if (path === '/api/sessions' && request.method === 'GET') return json(await lobby.listSessions());

      if (path === '/api/sessions' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { scenario?: string; seed?: number; traffic?: string };
        const sc = getScenario(body.scenario ?? 'free-light');
        if (!sc) return json({ error: 'Unknown scenario' }, 400);
        const seed = Number.isFinite(body.seed) ? Math.floor(Number(body.seed)) : sc.seed;
        const traffic = TRAFFIC.includes(body.traffic as TrafficLevel) ? (body.traffic as TrafficLevel) : sc.traffic;
        const code = roomCode();
        const gov = await lobby.createSession({ code, scenario: sc.id, scenarioName: sc.name, seed, traffic });
        if (!gov.ok) return json({ error: gov.reason, usage: gov.usage }, 429);
        const r = await env.AIRSPACE.getByName(code).init({ code, scenario: sc.id, seed, traffic, createdAt: Date.now() });
        if (!r.ok) return json({ error: r.error }, 500);
        return json({ code, scenario: sc.id, seed, traffic }, 201);
      }

      m = path.match(/^\/api\/sessions\/([A-Z0-9]+)\/replay$/);
      if (m && request.method === 'GET') {
        if (!validCode(m[1])) return json({ error: 'Bad session code' }, 400);
        const from = url.searchParams.has('from') ? Number(url.searchParams.get('from')) : undefined;
        const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : undefined;
        const data = await env.AIRSPACE.getByName(m[1]).getEvents(from, to);
        if (!data) return json({ error: 'Session not found' }, 404);
        await lobby.recordUsage({ workerRequests: 1, doRequests: 1 });
        return json(data);
      }

      if (path === '/api/explain' && request.method === 'POST') return explain(env, await request.json());
      if (path === '/api/brief' && request.method === 'POST') return brief(env, await request.json());

      if (path === '/api/usage' && request.method === 'GET') {
        await lobby.recordUsage({ workerRequests: 1, doRequests: 1 });
        return json(await lobby.usage());
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: 'Internal error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
