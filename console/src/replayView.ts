// Replay viewer: re-simulates the session in the browser from its seed + event log
// (the same deterministic engine the server runs) and scrubs second by second.
import { replay, type ReplayFrame } from '../../src/engine/replay';
import { getScenario } from '../../scenarios';
import type { BusEvent, Flight } from '../../src/shared/types';
import { api } from './api';
import { Scope } from './scope';
import { clear, fmtClock, h, toast } from './util';

export function mountReplay(root: HTMLElement, code: string): () => void {
  let frames: { tick: number; t: number; flights: Flight[]; hash: string; events: BusEvent[] }[] = [];
  let idx = 0;
  let playing: number | undefined;
  let selected: string | undefined;
  const history = new Map<string, { x: number; y: number }[]>();

  const canvas = h('canvas', { 'data-testid': 'replay-scope' });
  const slider = h('input', { type: 'range', min: '0', max: '0', value: '0', 'data-testid': 'replay-slider', 'aria-label': 'Replay position', oninput: () => show(Number(slider.value)) });
  const clock = h('span', { class: 'clock mono', 'data-testid': 'replay-clock' }, '00:00:00');
  const hash = h('span', { class: 'chip mono', title: 'World state fingerprint' }, '');
  const playBtn = h('button', { class: 'primary small', 'data-testid': 'replay-play', onclick: () => toggle() }, 'Play');
  const speedSel = h('select', { 'aria-label': 'Replay speed' }, [1, 4, 16].map((s) => h('option', { value: String(s) }, `x${s}`)));
  const evList = h('div', { class: 'replay-events mono', 'data-testid': 'replay-events' });
  const status = h('span', { class: 'muted', 'data-testid': 'replay-status' }, 'Loading event log…');

  clear(root);
  root.append(
    h('header', { class: 'banner' }, h('span', { class: 'brand' }, 'SKY', h('span', {}, 'WARD'), ' Replay'), h('span', { class: 'chip mono' }, code), status, h('span', { class: 'spacer' }),
      h('a', { href: `#/s/${code}`, class: 'chip' }, 'Open live console'), h('a', { href: '#/', class: 'chip' }, 'Lobby')),
    h('div', { class: 'scope-wrap', style: 'flex:1' }, canvas),
    h('div', { class: 'replay-bar' }, playBtn, speedSel, slider, clock, hash),
    evList,
  );

  const scope = new Scope(canvas, {
    flights: () => frames[idx]?.flights ?? [],
    history: (id) => history.get(id),
    position: () => 'SUP',
    effective: (p) => p,
    selected: () => selected,
    conflictPairs: () => [],
    alertFlights: () => new Set(),
    inbound: () => new Set(),
  }, { onSelect: (cs) => { selected = cs; scope.invalidate(); } });

  function show(i: number) {
    idx = Math.max(0, Math.min(frames.length - 1, i));
    slider.value = String(idx);
    const f = frames[idx];
    if (!f) return;
    clock.textContent = fmtClock(f.t);
    hash.textContent = `#${f.hash}`;
    history.clear();
    for (let k = Math.max(0, idx - 5); k <= idx; k++) for (const fl of frames[k].flights) {
      const list = history.get(fl.id) ?? [];
      list.push(fl.pos);
      history.set(fl.id, list);
    }
    clear(evList);
    const recent = frames.slice(Math.max(0, idx - 12), idx + 1).flatMap((fr) => fr.events.map((e) => ({ e, t: fr.t })));
    for (const { e } of recent.slice(-30).reverse()) evList.append(h('div', {}, `${fmtClock(e.t)} ${e.kind} ${JSON.stringify(e.payload).slice(0, 140)}`));
    scope.invalidate();
  }

  function toggle() {
    if (playing) { clearInterval(playing); playing = undefined; playBtn.textContent = 'Play'; return; }
    playBtn.textContent = 'Pause';
    playing = window.setInterval(() => {
      if (idx >= frames.length - 1) return toggle();
      show(idx + Number(speedSel.value) > frames.length - 1 ? frames.length - 1 : idx + Math.max(1, Number(speedSel.value) / 4));
    }, 250);
  }

  api.replay(code).then((data) => {
    const sc = getScenario(data.scenario);
    if (!sc) { status.textContent = `Unknown scenario ${data.scenario}`; return; }
    const lastTick = Math.max(data.tick ?? 0, ...data.events.map((e) => e.tick), 1);
    const maxTick = Math.min(lastTick, 4000);
    frames = [];
    replay(sc, data.events, maxTick, (f: ReplayFrame) => frames.push(f));
    slider.max = String(frames.length - 1);
    status.textContent = `${sc.name} · seed ${data.seed} · ${data.events.length} events · ${frames.length} sweeps re-simulated`;
    show(0);
  }).catch((e) => { status.textContent = (e as Error).message; toast((e as Error).message); });

  return () => { if (playing) clearInterval(playing); };
}
