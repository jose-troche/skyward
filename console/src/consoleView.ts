// Operational console: scope on the left, decisions on the right, comms along the bottom.
import { FIXES, RUNWAYS } from '../../src/shared/airspace';
import { formatCommand, parseCommand } from '../../src/shared/commands';
import {
  POSITIONS, REJECT_REASONS, type Advisory, type AgentId, type Clearance, type ConsolePosition, type Flight, type PositionId, type RejectReason, type TrafficLevel,
} from '../../src/shared/types';
import { api, type ScenarioInfo } from './api';
import { Connection } from './net';
import { Scope } from './scope';
import { Store } from './store';
import { clear, fmtClock, h, storage, altLabel } from './util';

const ALL_POSITIONS: ConsolePosition[] = [...POSITIONS, 'SUP', 'OBS'];
const POSITION_LABEL: Record<ConsolePosition, string> = { 'CTR-NW': 'CTR-NW · Center NW', 'CTR-SE': 'CTR-SE · Center SE', APP: 'APP · Approach', TWR: 'TWR · Tower', SUP: 'SUP · Supervisor', OBS: 'OBS · Observer' };
const AGENT_LABEL: Record<string, string> = {
  trajectory: 'Trajectory', separation: 'Separation Assurance', centerFlow: 'Center Flow', sequencer: 'Terminal Sequencer', sector: 'Sector agents',
  workload: 'Workload', datalink: 'Datalink', nationalFlow: 'National Flow (stub)', surface: 'Surface (stub)', oceanic: 'Oceanic (stub)', weather: 'Weather (stub)',
};

export function mountConsole(root: HTMLElement, code: string, name: string): () => void {
  const store = new Store();
  store.session = code;
  store.name = name;
  let editing: { advId: string } | undefined;
  let supOpen = true;
  let scenarios: ScenarioInfo[] = [];
  api.scenarios().then((s) => { scenarios = s; renderSupervisor(); }).catch(() => {});

  const wanted = (storage.get(`skyward.pos.${code}`) as ConsolePosition | null) ?? 'OBS';
  const conn = new Connection(store, () => {
    conn.send({ v: 1, type: 'hello', name });
    if (store.position !== 'OBS' || wanted !== 'OBS') conn.send({ v: 1, type: 'claim', position: store.position !== 'OBS' ? store.position : wanted });
  });

  // ------------------------------------------------------------ layout
  const posSelect = h('select', { 'data-testid': 'position-select', 'aria-label': 'Position', onchange: () => claim(posSelect.value as ConsolePosition) },
    ALL_POSITIONS.map((p) => h('option', { value: p }, POSITION_LABEL[p])));
  const clock = h('span', { class: 'clock mono', 'data-testid': 'sim-clock' }, '00:00:00');
  const speedChip = h('span', { class: 'chip mono', 'data-testid': 'speed-chip' }, 'x1');
  const latency = h('span', { class: 'chip mono', 'data-testid': 'latency', title: 'Sweep latency: alarm fired to message received' }, '— ms');
  const connChip = h('span', { class: 'chip', 'data-testid': 'connection' }, 'connecting…');
  const presenceEl = h('span', { class: 'row', 'data-testid': 'presence' });
  const scenarioEl = h('span', { class: 'muted', 'data-testid': 'scenario-name' });
  const supBtn = h('button', { class: 'small hidden', 'data-testid': 'sup-toggle', onclick: () => { supOpen = !supOpen; renderSupervisor(); } }, 'Supervisor');
  const themeBtn = h('button', { class: 'small', 'data-testid': 'theme-toggle', onclick: toggleTheme }, 'Theme');
  const briefBtn = h('button', { class: 'small', 'data-testid': 'brief-btn', onclick: showBrief }, 'Relief brief');
  const banner = h('header', { class: 'banner' },
    h('span', { class: 'brand' }, 'SKY', h('span', {}, 'WARD'), ' Lite'),
    h('span', { class: 'chip mono', 'data-testid': 'session-code', title: 'Room code: share it to work another position' }, code),
    scenarioEl, posSelect, clock, speedChip, latency, connChip, presenceEl,
    h('span', { class: 'spacer' }),
    supBtn, briefBtn,
    h('a', { href: `#/replay/${code}`, class: 'chip' }, 'Replay'),
    themeBtn,
    h('a', { href: '#/', class: 'chip', 'data-testid': 'leave' }, 'Leave'),
  );
  const alertBar = h('div', { class: 'alertbar', 'data-testid': 'alert-bar', role: 'alert' });

  const canvas = h('canvas', { 'data-testid': 'scope', 'aria-label': 'Radar scope' });
  const measureBtn = h('button', { class: 'small', 'data-testid': 'measure-toggle', onclick: () => { scope.measureMode = !scope.measureMode; measureBtn.classList.toggle('on', scope.measureMode); } }, 'Measure');
  const terrainBtn = h('button', { class: 'small on', onclick: () => { scope.showTerrain = !scope.showTerrain; terrainBtn.classList.toggle('on', scope.showTerrain); scope.invalidate(); } }, 'Terrain');
  const supPanel = h('div', { class: 'sup hidden', 'data-testid': 'supervisor' });
  const scopeWrap = h('div', { class: 'scope-wrap' }, canvas,
    h('div', { class: 'scope-tools' },
      h('button', { class: 'small', onclick: () => scope.zoom(1.3), 'aria-label': 'Zoom in' }, '+'),
      h('button', { class: 'small', onclick: () => scope.zoom(1 / 1.3), 'aria-label': 'Zoom out' }, '−'),
      h('button', { class: 'small', onclick: () => scope.reset() }, 'Reset'),
      measureBtn, terrainBtn),
    h('div', { class: 'scope-legend' }, 'drag: pan · wheel: zoom · click: select · right-click: clearance · shift-drag: measure · drag data block to move'),
    supPanel);

  const advList = h('div', { class: 'adv-list', 'data-testid': 'advisories' });
  const stripList = h('div', { class: 'strips', 'data-testid': 'strips' });
  const advCount = h('span', { class: 'chip' }, '0');
  const side = h('aside', { class: 'side' },
    h('section', {}, h('h3', {}, 'Advisories', advCount, h('span', { class: 'spacer' }), h('span', { class: 'muted' }, 'max 3')), advList),
    h('section', { style: 'flex:1' }, h('h3', {}, 'Flight strips'), stripList));

  const log = h('div', { class: 'comms-log mono', 'data-testid': 'comms-log' });
  const cmdErr = h('span', { class: 'err', 'data-testid': 'command-error' });
  const editChip = h('span', { class: 'edit-chip hidden' });
  const cmd = h('input', { 'data-testid': 'command-input', placeholder: 'DAL123 H250 D060 S210 · DCT NWARD · ILS 27L · CTO 27L · HO', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Command line' });
  const history: string[] = [];
  let histIdx = -1;
  cmd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCommand();
    else if (e.key === 'Escape') { cmd.value = ''; setEditing(undefined); }
    else if (e.key === 'ArrowUp' && history.length) { histIdx = Math.min(history.length - 1, histIdx + 1); cmd.value = history[history.length - 1 - histIdx]; e.preventDefault(); }
    else if (e.key === 'ArrowDown') { histIdx = Math.max(-1, histIdx - 1); cmd.value = histIdx < 0 ? '' : history[history.length - 1 - histIdx]; e.preventDefault(); }
  });
  const comms = h('section', { class: 'comms' }, log,
    h('div', { class: 'cmdline' }, editChip, cmd, h('button', { class: 'primary', 'data-testid': 'command-send', onclick: submitCommand }, 'Send'), cmdErr));

  const workspace = h('div', { class: 'workspace' }, scopeWrap, side, comms);
  clear(root);
  root.append(banner, alertBar, workspace);

  const scope = new Scope(canvas, {
    flights: () => [...store.flights.values()],
    history: (id) => store.history.get(id),
    position: () => store.position,
    effective: (p) => store.effective(p),
    selected: () => store.selected,
    conflictPairs: () => store.conflictPairs(),
    alertFlights: () => new Set([...store.alerts.values()].filter((a) => a.kind !== 'EMERG').flatMap((a) => a.flights)),
    inbound: () => new Set([...store.handoffs.values()].filter((hd) => isMine(hd.to)).map((hd) => hd.flight)),
  }, {
    onSelect: (cs) => select(cs),
    onContext: (cs, x, y) => openMenu(cs, x, y),
  });
  (window as unknown as { __skyward: unknown }).__skyward = { store, scope, conn };

  // ------------------------------------------------------------ helpers
  function isMine(p: PositionId) {
    return store.position === 'SUP' || (store.position !== 'OBS' && store.effective(p) === store.position);
  }

  function claim(p: ConsolePosition) {
    store.position = p;
    storage.set(`skyward.pos.${code}`, p);
    conn.send({ v: 1, type: 'claim', position: p });
    supOpen = p === 'SUP';
    renderAll();
  }

  function select(cs?: string) {
    store.selected = cs;
    store.emit('selection');
  }

  function sendClearance(c: Clearance) {
    conn.send({ v: 1, type: 'clearance', clearance: c });
  }

  function setEditing(e?: { advId: string }) {
    editing = e;
    editChip.textContent = e ? `EDIT ${e.advId}` : '';
    editChip.classList.toggle('hidden', !e);
  }

  function submitCommand() {
    const text = cmd.value.trim();
    if (!text) return;
    const p = parseCommand(text);
    if (!p.ok) { cmdErr.textContent = p.error; return; }
    cmdErr.textContent = '';
    history.push(text); histIdx = -1;
    if (editing) {
      conn.send({ v: 1, type: 'advisory.accept', id: editing.advId, edited: [p.clearance] });
      setEditing(undefined);
    } else if (p.handoff) {
      conn.send({ v: 1, type: 'handoff.accept', flight: p.clearance.flight });
      const rest = { ...p.clearance };
      if (Object.keys(rest).length > 1) sendClearance(rest);
    } else {
      sendClearance(p.clearance);
    }
    cmd.value = '';
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', cur);
    storage.set('skyward.theme', cur);
    scope.readColors();
  }

  async function showBrief() {
    const pos = (POSITIONS as string[]).includes(store.position) ? store.position : 'APP';
    const body = h('pre', { 'data-testid': 'brief-text' }, 'Generating briefing…');
    const back = h('div', { class: 'modal-back', onclick: (e: Event) => { if (e.target === back) back.remove(); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-label': 'Relief briefing' },
        h('div', { class: 'row' }, h('strong', {}, `Position relief briefing · ${pos}`), h('span', { class: 'spacer' }), h('button', { class: 'small', onclick: () => back.remove() }, 'Close')),
        body));
    document.body.append(back);
    try {
      const r = await api.brief(code, pos);
      body.textContent = `${r.text}\n\n— ${r.source === 'workers-ai' ? 'Workers AI (LLM text, advisory only)' : 'deterministic template'}`;
    } catch (e) {
      body.textContent = `Briefing unavailable: ${(e as Error).message}`;
    }
  }

  // ------------------------------------------------------------ context menu (right-click target)
  let menuEl: HTMLElement | undefined;
  function closeMenu() { menuEl?.remove(); menuEl = undefined; }
  document.addEventListener('pointerdown', onDocDown);
  function onDocDown(e: Event) { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); }

  function openMenu(cs: string, x: number, y: number) {
    closeMenu();
    const f = store.byCallsign(cs);
    if (!f) return;
    select(cs);
    const go = (c: Omit<Clearance, 'flight'>) => { sendClearance({ flight: cs, ...c }); closeMenu(); };
    const btn = (label: string, c: Omit<Clearance, 'flight'>, testid?: string) => h('button', { class: 'small', onclick: () => go(c), 'data-testid': testid }, label);
    const hdg = Math.round(f.trk / 5) * 5;
    const norm = (v: number) => ((v % 360) + 360) % 360 || 360;
    const alt = f.cleared.alt ?? Math.round(f.alt / 1000) * 1000;
    const inbound = store.handoffs.get(cs);
    menuEl = h('div', { class: 'menu', 'data-testid': 'clearance-menu', style: `left:${Math.min(x, innerWidth - 310)}px; top:${Math.min(y, innerHeight - 320)}px` },
      h('div', { class: 'title mono' }, `${cs} · ${f.type} · ${altLabel(f.alt)} · ${f.squawk}`),
      f.phase === 'holding-short' || f.phase === 'lineup'
        ? h('div', { class: 'grp' }, h('span', {}, 'Runway'), btn('LUAW 27L', { lineup: '27L' }), btn('CTO 27L', { takeoff: '27L' }, 'menu-cto'))
        : [
          h('div', { class: 'grp' }, h('span', {}, 'Heading'), ...[-30, -20, -10, 10, 20, 30].map((d) => btn(`${d > 0 ? 'R' : 'L'}${String(norm(hdg + d)).padStart(3, '0')}`, { hdg: norm(hdg + d) }))),
          h('div', { class: 'grp' }, h('span', {}, 'Altitude'), ...[-2000, -1000, 1000, 2000].map((d) => btn(altLabel(alt + d), { alt: alt + d }))),
          h('div', { class: 'grp' }, h('span', {}, 'Speed'), ...[180, 210, 250, 280].map((s) => btn(String(s), { spd: s }))),
          h('div', { class: 'grp' }, h('span', {}, 'Direct'), ...Object.values(FIXES).filter((fx) => fx.kind !== 'enroute').map((fx) => btn(fx.name, { direct: fx.name }))),
          h('div', { class: 'grp' }, h('span', {}, 'Approach'), ...Object.keys(RUNWAYS).map((r) => btn(`ILS ${r}`, { approach: r })), btn('Resume', { resume: true })),
        ],
      inbound && isMine(inbound.to) ? h('button', { class: 'primary small', onclick: () => { conn.send({ v: 1, type: 'handoff.accept', flight: cs }); closeMenu(); } }, `Accept handoff from ${inbound.from}`) : null,
      h('button', { class: 'small', onclick: () => { cmd.value = `${cs} `; cmd.focus(); closeMenu(); } }, 'Type command…'),
    );
    document.body.append(menuEl);
  }

  // ------------------------------------------------------------ renderers
  function renderBanner() {
    posSelect.value = store.position;
    for (const opt of Array.from(posSelect.options)) {
      const holder = store.presence.find((p) => p.position === opt.value && p.clientId !== store.clientId);
      opt.disabled = !!holder && (POSITIONS as string[]).includes(opt.value);
      opt.textContent = `${POSITION_LABEL[opt.value as ConsolePosition]}${holder && (POSITIONS as string[]).includes(opt.value) ? ` (${holder.name})` : ''}`;
    }
    scenarioEl.textContent = store.scenarioName;
    const st = store.status;
    speedChip.textContent = st?.paused ? 'PAUSED' : `x${st?.speed ?? 1}`;
    speedChip.className = `chip mono ${st?.paused ? 'warn' : ''}`;
    const up = store.connected.airspace && store.connected.safety;
    connChip.textContent = up ? 'linked' : !store.connected.safety ? 'safety net offline' : 'airspace offline';
    connChip.className = `chip ${up ? 'ok' : 'warn'}`;
    clear(presenceEl);
    for (const p of store.presence.filter((x) => x.position !== 'OBS')) presenceEl.append(h('span', { class: 'chip', title: p.name }, `${p.position}: ${p.name}`));
    supBtn.classList.toggle('hidden', store.position !== 'SUP');
  }

  function renderClock() {
    clock.textContent = fmtClock(store.simT);
    latency.textContent = `${store.latencyMs} ms`;
  }

  function renderAlerts() {
    clear(alertBar);
    const alerts = [...store.alerts.values()].sort((a, b) => (a.severity === b.severity ? a.at - b.at : a.severity === 'warning' ? -1 : 1));
    if (!alerts.length) alertBar.append(h('span', { class: 'none' }, 'No safety-net alerts'));
    for (const a of alerts) {
      alertBar.append(h('span', {
        class: `alert ${a.severity} ${a.kind} ${a.acked ? 'acked' : ''}`, 'data-testid': `alert-${a.kind}`, 'data-flights': a.flights.join(','),
        onclick: () => { for (const f of a.flights) scope.flash(f); select(a.flights[0]); },
      }, `${a.kind} · ${a.text}`, a.acked ? null : h('button', {
        'data-testid': 'alert-ack', onclick: (e: Event) => { e.stopPropagation(); a.acked = true; conn.ackAlert(a.id, a.source); renderAlerts(); },
      }, 'ACK')));
    }
    scope.invalidate();
    renderAdvisories();
  }

  function renderAdvisories() {
    clear(advList);
    const list = store.myAdvisories();
    advCount.textContent = String(list.length);
    if (store.position === 'OBS') advList.append(h('div', { class: 'adv-empty' }, 'Observer: pick a position to work advisories.'));
    else if (!list.length) advList.append(h('div', { class: 'adv-empty', 'data-testid': 'no-advisories' }, 'No advisories for this position.'));
    const alertFlights = new Set([...store.alerts.values()].filter((a) => a.kind === 'CA' || a.kind === 'MSAW').flatMap((a) => a.flights));
    for (const a of list) advList.append(advisoryCard(a, a.flights.some((f) => alertFlights.has(f)) && a.priority <= 2));
    tickCountdowns();
  }

  function advisoryCard(a: Advisory, resolves: boolean): HTMLElement {
    const explain = h('div', { class: 'explain hidden', 'data-testid': 'adv-explanation' }, store.explanations.get(a.id) ?? '');
    if (store.explanations.has(a.id)) explain.classList.remove('hidden');
    const reason = h('select', { class: 'small', 'data-testid': 'adv-reason', 'aria-label': 'Reject reason' }, REJECT_REASONS.map((r) => h('option', { value: r }, r)));
    const f = store.byCallsign(a.action[0]?.flight ?? '');
    const canAct = store.position === 'SUP' || store.effective(a.position) === store.position;
    return h('div', { class: `adv ${resolves ? 'resolves' : ''}`, 'data-testid': 'advisory', 'data-id': a.id, 'data-source': a.source, 'data-expires': String(a.expiresAt), 'data-created': String(a.createdAt) },
      h('div', { class: 'head' },
        h('span', { class: `prio p${a.priority}`, title: 'Precedence (1 = highest)' }, `P${a.priority}`),
        h('span', {}, AGENT_LABEL[a.source] ?? a.source),
        store.position === 'SUP' ? h('span', { class: 'pos-tag' }, a.position) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted mono', 'data-countdown': '' }, '')),
      h('div', { class: 'cmd mono', 'data-testid': 'adv-command' }, a.action.map((c) => formatCommand(c, f?.alt)).join(' · ')),
      h('div', { class: 'why' }, a.rationale.text),
      h('div', { class: 'muted', style: 'font-size:11px' }, `predicted min sep ${a.predicted.minSepNm >= 99 ? '—' : `${a.predicted.minSepNm} NM`} · delay ${a.predicted.delaySec} s · ${Math.round(a.confidence * 100)}% · L${a.authority} · ${a.modelVersion}`),
      h('div', { class: 'expiry' }, h('div', { 'data-bar': '' })),
      explain,
      h('div', { class: 'actions' },
        h('button', { class: 'primary small', 'data-testid': 'adv-accept', disabled: !canAct, onclick: () => conn.send({ v: 1, type: 'advisory.accept', id: a.id }) }, 'Accept'),
        h('button', { class: 'small', 'data-testid': 'adv-edit', disabled: !canAct, onclick: () => { setEditing({ advId: a.id }); cmd.value = formatCommand(a.action[0], f?.alt); cmd.focus(); } }, 'Edit'),
        reason,
        h('button', { class: 'small danger', 'data-testid': 'adv-reject', disabled: !canAct, onclick: () => conn.send({ v: 1, type: 'advisory.reject', id: a.id, reason: reason.value as RejectReason }) }, 'Reject'),
        h('button', {
          class: 'small', 'data-testid': 'adv-why', onclick: async () => {
            explain.classList.remove('hidden');
            explain.textContent = 'Explaining…';
            try {
              const r = await api.explain(code, a.id);
              const text = `${r.text}${r.source === 'workers-ai' ? ' (AI)' : ''}`;
              store.explanations.set(a.id, text);
              explain.textContent = text;
            } catch (e) { explain.textContent = (e as Error).message; }
          },
        }, 'Why?')));
  }

  function tickCountdowns() {
    const now = store.simNow();
    const speed = store.status?.speed ?? 1;
    for (const el of Array.from(advList.querySelectorAll<HTMLElement>('[data-testid=advisory]'))) {
      const exp = Number(el.dataset.expires), created = Number(el.dataset.created);
      const left = exp - now;
      if (left <= 0) { el.remove(); continue; }
      el.classList.toggle('fading', left < 15);
      const cd = el.querySelector<HTMLElement>('[data-countdown]');
      if (cd) cd.textContent = `${Math.ceil(left / speed)} s`;
      const bar = el.querySelector<HTMLElement>('[data-bar]');
      if (bar) bar.style.width = `${Math.max(0, Math.min(100, (left / Math.max(1, exp - created)) * 100))}%`;
    }
  }

  const stripOrderKey = `skyward.strips.${code}`;
  let stripOrder: string[] = JSON.parse(storage.get(stripOrderKey) ?? '[]');
  function renderStrips() {
    clear(stripList);
    const inbound = [...store.handoffs.values()].filter((hd) => isMine(hd.to));
    const inboundSet = new Set(inbound.map((hd) => hd.flight));
    let flights = [...store.flights.values()].filter((f) => (store.position !== 'OBS' && isMine(f.owner)) || inboundSet.has(f.callsign));
    if (store.position === 'OBS') flights = [...store.flights.values()];
    const rank = (f: Flight) => {
      const i = stripOrder.indexOf(f.callsign);
      return i >= 0 ? i : 1000 + (f.seq ?? 500);
    };
    flights.sort((a, b) => rank(a) - rank(b) || a.callsign.localeCompare(b.callsign));
    if (!flights.length) stripList.append(h('div', { class: 'adv-empty' }, store.position === 'OBS' ? 'No traffic.' : 'No owned or inbound flights.'));
    for (const f of flights) {
      const hd = store.handoffs.get(f.callsign);
      const isIn = inboundSet.has(f.callsign);
      const emergency = ['7700', '7600', '7500'].includes(f.squawk);
      const strip = h('div', {
        class: `strip ${f.kind} ${isIn ? 'inbound' : ''} ${store.selected === f.callsign ? 'selected' : ''} ${emergency ? 'emergency' : ''}`,
        draggable: 'true', 'data-testid': 'strip', 'data-callsign': f.callsign, 'data-owner': f.owner,
        onclick: () => { select(f.callsign); scope.flash(f.callsign); },
        ondragstart: (e: DragEvent) => { e.dataTransfer?.setData('text/plain', f.callsign); strip.classList.add('dragging'); },
        ondragend: () => strip.classList.remove('dragging'),
        ondragover: (e: DragEvent) => e.preventDefault(),
        ondrop: (e: DragEvent) => {
          e.preventDefault();
          const from = e.dataTransfer?.getData('text/plain');
          if (!from || from === f.callsign) return;
          const order = flights.map((x) => x.callsign).filter((c) => c !== from);
          order.splice(order.indexOf(f.callsign), 0, from);
          stripOrder = order;
          storage.set(stripOrderKey, JSON.stringify(order));
          renderStrips();
        },
      },
        h('div', {}, h('span', { class: 'cs mono' }, f.callsign), ` ${f.type}/${f.wake}`, f.seq ? h('span', { class: 'chip', style: 'margin-left:6px' }, `#${f.seq} ${f.runway ?? ''}`) : null),
        h('div', { class: 'mono' }, `${altLabel(f.alt)}${f.cleared.alt !== undefined ? `→${altLabel(f.cleared.alt)}` : ''}`),
        h('div', { class: 'muted' }, `${f.plan.origin}→${f.plan.dest} ${f.plan.route.join(' ')}${f.cleared.hdg ? ` H${f.cleared.hdg}` : ''}${f.cleared.approach ? ` ILS${f.cleared.approach}` : ''}`),
        h('div', { class: 'mono muted' }, `${f.squawk}${f.sta ? ` STA ${fmtClock(f.sta).slice(3)}` : ''}${f.nordo ? ' NORDO' : ''}`),
        isIn && hd ? h('div', { style: 'grid-column:1/-1' }, h('button', {
          class: 'primary small', 'data-testid': 'handoff-accept', onclick: (e: Event) => { e.stopPropagation(); conn.send({ v: 1, type: 'handoff.accept', flight: f.callsign }); },
        }, `Accept handoff from ${hd.from}${hd.crossInSec ? ` (boundary in ${Math.round(hd.crossInSec / 60)} min)` : ''}`)) : null,
        !isIn && hd && isMine(hd.from) ? h('div', { style: 'grid-column:1/-1', class: 'muted' }, `Handoff to ${hd.to} proposed…`) : null,
      );
      stripList.append(strip);
    }
  }

  function renderComms() {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    clear(log);
    for (const l of store.comms.slice(-120)) {
      const mine = l.from === store.position || l.to === store.position;
      log.append(h('div', { class: `line ${l.kind} ${mine ? 'mine' : ''}`, 'data-testid': 'comms-line' }, `${fmtClock(l.t)} ${l.from}→${l.to}: ${l.text}`));
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function renderSupervisor() {
    const show = store.position === 'SUP' && supOpen;
    supPanel.classList.toggle('hidden', !show);
    if (!show) return;
    clear(supPanel);
    const st = store.status;
    const send = (action: 'pause' | 'resume' | 'speed' | 'restart' | 'traffic' | 'combine' | 'split', extra: Record<string, unknown> = {}) =>
      conn.send({ v: 1, type: 'sim.control', action, ...extra } as never);
    const traffic = h('select', { 'data-testid': 'sup-traffic', onchange: () => send('traffic', { traffic: traffic.value as TrafficLevel }) },
      (['none', 'light', 'busy', 'surge'] as TrafficLevel[]).map((t) => h('option', { value: t, selected: st?.trafficLevel === t }, t)));
    const scenarioSel = h('select', { 'data-testid': 'sup-scenario' }, scenarios.map((s) => h('option', { value: s.id, selected: s.id === st?.scenario }, s.name)));
    const seed = h('input', { type: 'number', value: String(st?.seed ?? ''), style: 'width:90px', 'aria-label': 'Seed' });
    const combineFrom = h('select', {}, POSITIONS.map((p) => h('option', { value: p }, p)));
    const combineInto = h('select', {}, POSITIONS.map((p) => h('option', { value: p, selected: p === 'CTR-NW' }, p)));
    supPanel.append(
      h('div', { class: 'row' }, h('strong', {}, 'Supervisor'), h('span', { class: 'spacer' }), h('button', { class: 'small', onclick: () => { supOpen = false; renderSupervisor(); } }, 'Hide')),
      h('div', {}, h('h4', {}, 'Simulation'),
        h('div', { class: 'row' },
          st?.paused ? h('button', { class: 'primary small', 'data-testid': 'sup-resume', onclick: () => send('resume') }, 'Resume') : h('button', { class: 'small', 'data-testid': 'sup-pause', onclick: () => send('pause') }, 'Pause'),
          ...([1, 2, 4] as const).map((s) => h('button', { class: `small ${st?.speed === s ? 'primary' : ''}`, 'data-testid': `sup-speed-${s}`, onclick: () => send('speed', { speed: s }) }, `x${s}`)),
          h('span', { class: 'muted' }, 'traffic'), traffic),
        h('div', { class: 'row', style: 'margin-top:6px' }, scenarioSel, seed,
          h('button', { class: 'small', 'data-testid': 'sup-restart', onclick: () => send('restart', { scenario: scenarioSel.value, seed: seed.value ? Number(seed.value) : undefined }) }, 'Restart'))),
      h('div', {}, h('h4', {}, 'Positions & workload'),
        h('table', {}, h('tr', {}, h('th', {}, 'Pos'), h('th', {}, 'Controller'), h('th', {}, 'Score'), h('th', {}, 'A/C'), h('th', {}, 'Conf'), h('th', {}, 'Pend'), h('th', {}, '')),
          POSITIONS.map((p) => {
            const w = store.workload.find((x) => x.position === p);
            const holder = store.presence.find((x) => x.position === p);
            const into = st?.combined?.[p];
            return h('tr', { 'data-testid': `sup-pos-${p}` }, h('td', {}, p), h('td', {}, holder?.name ?? (into ? `→ ${into}` : h('span', { class: 'muted' }, 'auto'))),
              h('td', {}, String(w?.score ?? 0)), h('td', {}, String(w?.aircraft ?? 0)), h('td', {}, String(w?.conflicts ?? 0)), h('td', {}, String(w?.pending ?? 0)),
              h('td', {}, into ? h('button', { class: 'small', onclick: () => send('split', { position: p }) }, 'Split') : null));
          })),
        h('div', { class: 'row', style: 'margin-top:6px' }, h('span', { class: 'muted' }, 'Combine'), combineFrom, h('span', { class: 'muted' }, 'into'), combineInto,
          h('button', { class: 'small', onclick: () => send('combine', { position: combineFrom.value, into: combineInto.value }) }, 'Combine')),
        store.recommendations.length ? h('div', { 'data-testid': 'sup-recommendations' }, store.recommendations.map((r) => h('div', { class: 'chip warn', style: 'margin-top:4px' }, r))) : null),
      h('div', {}, h('h4', {}, 'Agents (switch off to see degradation)'),
        store.agents.map((a) => h('div', { class: 'agent-row', 'data-testid': `agent-${a.id}` },
          h('button', {
            class: `toggle ${a.enabled ? 'on' : ''}`, disabled: a.stub, 'aria-label': `${AGENT_LABEL[a.id]} ${a.enabled ? 'on' : 'off'}`, 'data-testid': `agent-toggle-${a.id}`,
            onclick: () => conn.send({ v: 1, type: 'agent.toggle', agent: a.id as AgentId, on: !a.enabled }),
          }),
          h('span', {}, AGENT_LABEL[a.id] ?? a.id),
          h('span', { class: 'spacer' }),
          h('span', { class: 'state muted mono' }, a.stub ? 'v2' : a.error ? `error` : a.suspended ? 'SUSPENDED' : a.enabled ? `${a.lastRunMs} ms${a.rejected ? ` · ${a.rejected} dropped` : ''}` : 'off')))),
    );
  }

  function renderAll() {
    renderBanner(); renderClock(); renderAlerts(); renderStrips(); renderComms(); renderSupervisor();
  }

  const off = store.on((c) => {
    if (c === 'sweep') { renderClock(); renderStrips(); scope.invalidate(); }
    else if (c === 'advisories') renderAdvisories();
    else if (c === 'alerts') renderAlerts();
    else if (c === 'handoffs') { renderStrips(); scope.invalidate(); }
    else if (c === 'comms') renderComms();
    else if (c === 'presence' || c === 'connection') { renderBanner(); renderSupervisor(); }
    else if (c === 'status') { renderBanner(); renderSupervisor(); }
    else if (c === 'selection') { renderStrips(); scope.invalidate(); }
  });
  const timer = setInterval(tickCountdowns, 500);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === '/' && document.activeElement !== cmd) { e.preventDefault(); cmd.focus(); }
    if (e.key === 'Escape') closeMenu();
  };
  document.addEventListener('keydown', onKey);
  store.position = wanted;
  renderAll();

  return () => {
    off(); clearInterval(timer); conn.close(); closeMenu();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDocDown);
  };
}

