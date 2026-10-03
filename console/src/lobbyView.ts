import { api, type ScenarioInfo, type Usage } from './api';
import { clear, h, storage, toast } from './util';

const METRIC_LABEL: Record<string, string> = {
  doRequests: 'DO requests', doRowsWritten: 'DO rows written', doDurationGbS: 'DO duration (GB-s)', workerRequests: 'Worker requests', aiNeurons: 'Workers AI neurons',
};

export function mountLobby(root: HTMLElement, onJoin: (code: string, name: string) => void): () => void {
  let scenarios: ScenarioInfo[] = [];
  const name = h('input', { 'data-testid': 'name-input', value: storage.get('skyward.name') ?? `ctl-${Math.floor(Math.random() * 900 + 100)}`, maxlength: '24', 'aria-label': 'Your name' });
  const scenarioSel = h('select', { 'data-testid': 'scenario-select', 'aria-label': 'Scenario', onchange: () => describe() });
  const desc = h('div', { class: 'scenario-desc', 'data-testid': 'scenario-desc' });
  const seed = h('input', { type: 'number', placeholder: 'scenario default', 'data-testid': 'seed-input', 'aria-label': 'Seed' });
  const traffic = h('select', { 'data-testid': 'traffic-select', 'aria-label': 'Traffic level' }, h('option', { value: '' }, 'scenario default'), ['none', 'light', 'busy', 'surge'].map((t) => h('option', { value: t }, t)));
  const createBtn = h('button', { class: 'primary', 'data-testid': 'create-session', onclick: create }, 'Create session');
  const joinCode = h('input', { placeholder: 'ROOM CODE', 'data-testid': 'join-code', maxlength: '8', style: 'text-transform:uppercase', 'aria-label': 'Room code' });
  const sessionsEl = h('div', { class: 'sessions', 'data-testid': 'session-list' });
  const usageEl = h('div', { 'data-testid': 'usage' });

  const remember = () => storage.set('skyward.name', name.value.trim() || 'controller');

  function describe() {
    const s = scenarios.find((x) => x.id === scenarioSel.value);
    desc.textContent = s ? `${s.description}${s.agentsOff.length ? ` (agents off: ${s.agentsOff.join(', ')})` : ''}` : '';
  }

  async function create() {
    remember();
    createBtn.disabled = true;
    try {
      const r = await api.createSession({ scenario: scenarioSel.value, seed: seed.value ? Number(seed.value) : undefined, traffic: traffic.value || undefined });
      onJoin(r.code, name.value.trim());
    } catch (e) {
      toast((e as Error).message, 6000);
    } finally {
      createBtn.disabled = false;
    }
  }

  function join(code: string) {
    remember();
    const c = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(c)) return toast('Enter a valid room code');
    onJoin(c, name.value.trim());
  }

  function renderUsage(u: Usage) {
    clear(usageEl);
    usageEl.append(h('div', { class: 'muted', style: 'margin-bottom:8px;font-size:12px' }, `UTC day ${u.day} · resets ${new Date(u.resetsAt).toUTCString().slice(17, 22)} UTC · governor refuses new sessions at ${Math.round(u.threshold * 100)}% · ${u.accepting ? 'accepting sessions' : 'NOT accepting sessions'}`));
    for (const [k, m] of Object.entries(u.metrics)) {
      const pct = Math.min(100, m.pct * 100);
      usageEl.append(h('div', { class: 'usage-row', 'data-testid': `usage-${k}` },
        h('span', {}, METRIC_LABEL[k] ?? k),
        h('div', { class: `usage-bar ${m.pct >= u.threshold * 0.8 ? 'hot' : ''}` }, h('div', { style: `width:${pct}%` })),
        h('span', { class: 'mono' }, `${m.used.toLocaleString('en-US', { maximumFractionDigits: 1 })} / ${m.limit.toLocaleString('en-US')}`)));
    }
  }

  async function refresh() {
    try {
      const list = await api.sessions();
      clear(sessionsEl);
      if (!list.length) sessionsEl.append(h('div', { class: 'muted' }, 'No sessions in the last 24 hours.'));
      for (const s of list) {
        sessionsEl.append(h('div', { class: 'session-row', 'data-testid': 'session-row' },
          h('span', { class: 'code mono' }, s.code),
          h('span', {}, s.scenarioName, h('br'), h('span', { class: 'muted', style: 'font-size:12px' }, `${s.live ? `● live · ${s.controllers} controller(s)` : 'idle'} · seed ${s.seed} · ${new Date(s.lastActive).toLocaleTimeString()}`)),
          h('span', { class: 'spacer' }),
          h('a', { href: `#/replay/${s.code}`, class: 'chip' }, 'Replay'),
          h('button', { class: 'small', onclick: () => join(s.code) }, 'Join')));
      }
    } catch (e) {
      clear(sessionsEl);
      sessionsEl.append(h('div', { class: 'muted' }, `Sessions unavailable: ${(e as Error).message}`));
    }
    try { renderUsage(await api.usage()); } catch { /* ignore */ }
  }

  clear(root);
  root.append(h('div', { class: 'lobby', 'data-testid': 'lobby' }, h('div', { class: 'lobby-inner' },
    h('div', { class: 'hero' },
      h('h1', {}, 'SKY', h('span', {}, 'WARD'), ' Lite'),
      h('p', { class: 'muted', style: 'max-width:760px' },
        'A multi-agent air traffic control prototype: planning agents propose, a Safety Monitor checks, an Arbiter merges, a human controller accepts or rejects, and the simulated aircraft obey. Independent safety nets keep alerting even with every agent switched off. Fictionalized Atlanta airspace (one TRACON, two en route sectors). ',
        h('strong', {}, 'Simulation only: never usable for real air traffic control.'))),
    h('div', { class: 'card' }, h('h2', {}, 'New session'),
      h('div', { class: 'field' }, h('label', {}, 'Your name'), name),
      h('div', { class: 'field' }, h('label', {}, 'Scenario'), scenarioSel, desc),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', {}, 'Seed'), seed), h('div', { class: 'field' }, h('label', {}, 'Traffic'), traffic)),
      createBtn),
    h('div', { class: 'card' }, h('h2', {}, 'Join a session'),
      h('div', { class: 'row' }, joinCode, h('button', { 'data-testid': 'join-session', onclick: () => join(joinCode.value) }, 'Join')),
      h('h2', { style: 'margin-top:16px' }, 'Recent sessions'), sessionsEl),
    h('div', { class: 'card', style: 'grid-column:1/-1' }, h('h2', {}, "Today's free-tier usage"), usageEl),
  )));

  api.scenarios().then((s) => {
    scenarios = s;
    for (const sc of s) scenarioSel.append(h('option', { value: sc.id }, sc.name));
    describe();
  }).catch((e) => toast(e.message));
  refresh();
  const timer = setInterval(refresh, 15000);
  return () => clearInterval(timer);
}
