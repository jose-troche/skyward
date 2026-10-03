// Radar scope on Canvas 2D from bundled vector data (no tile server).
// Redraws on each sweep; selection, hover, pan, zoom and data-block drags redraw locally.
import { FIXES, RUNWAYS, TERRAIN, TERRAIN_CELL, TERRAIN_MIN, TERRAIN_N, sectorBoundaries } from '../../src/shared/airspace';
import type { ConsolePosition, Flight, PositionId } from '../../src/shared/types';
import { altLabel } from './util';

export type ScopeModel = {
  flights(): Flight[];
  history(id: string): { x: number; y: number }[] | undefined;
  position(): ConsolePosition;
  effective(p: PositionId): PositionId;
  selected(): string | undefined;
  conflictPairs(): [string, string][];
  alertFlights(): Set<string>;
  inbound(): Set<string>;
};

type Colors = Record<'scope' | 'ring' | 'boundary' | 'runway' | 'fix' | 'terrain' | 'own' | 'other' | 'selected' | 'handoff' | 'warning' | 'caution' | 'emerg' | 'muted', string>;

export class Scope {
  private ctx: CanvasRenderingContext2D;
  private view = { x: 0, y: 8, scale: 4 }; // NM at canvas centre, px per NM
  private offsets = new Map<string, { dx: number; dy: number }>();
  private colors!: Colors;
  private dirty = true;
  private flashing = new Map<string, number>();
  private drag?: { kind: 'pan' | 'block' | 'measure'; cs?: string; sx: number; sy: number; vx: number; vy: number; ox?: number; oy?: number; moved: boolean };
  private measure?: { a: { x: number; y: number }; b: { x: number; y: number } };
  measureMode = false;
  showTerrain = true;
  private w = 0;
  private hgt = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private model: ScopeModel,
    private cb: { onSelect?: (cs?: string) => void; onContext?: (cs: string, x: number, y: number) => void } = {},
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.readColors();
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.offsetX, e.offsetY); }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const f = this.hit(e.offsetX, e.offsetY);
      if (f) this.cb.onContext?.(f.callsign, e.clientX, e.clientY);
    });
    const loop = () => {
      if (this.dirty || this.flashing.size) this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    this.resize();
  }

  readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n: string) => cs.getPropertyValue(`--${n}`).trim();
    this.colors = {
      scope: v('scope'), ring: v('ring'), boundary: v('boundary'), runway: v('runway'), fix: v('fix'), terrain: v('terrain'), own: v('own'), other: v('other'),
      selected: v('selected'), handoff: v('handoff'), warning: v('warning'), caution: v('caution'), emerg: v('emerg'), muted: v('muted'),
    };
    this.invalidate();
  }

  invalidate() { this.dirty = true; }

  flash(cs: string) {
    this.flashing.set(cs, Date.now() + 3000);
    const f = this.model.flights().find((x) => x.callsign === cs);
    if (f && !this.onScreen(f.pos)) { this.view.x = f.pos.x; this.view.y = f.pos.y; }
    this.invalidate();
  }

  zoom(f: number) { this.zoomAt(f, this.w / 2, this.hgt / 2); }

  reset() { this.view = { x: 0, y: 0, scale: Math.min(this.w, this.hgt) / 150 || 4 }; this.invalidate(); }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const first = this.w === 0;
    this.w = r.width; this.hgt = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (first && r.width > 0) this.reset();
    this.invalidate();
  }

  private toScreen(p: { x: number; y: number }) {
    return { x: this.w / 2 + (p.x - this.view.x) * this.view.scale, y: this.hgt / 2 - (p.y - this.view.y) * this.view.scale };
  }

  private toNm(sx: number, sy: number) {
    return { x: this.view.x + (sx - this.w / 2) / this.view.scale, y: this.view.y - (sy - this.hgt / 2) / this.view.scale };
  }

  private onScreen(p: { x: number; y: number }) {
    const s = this.toScreen(p);
    return s.x > 0 && s.y > 0 && s.x < this.w && s.y < this.hgt;
  }

  /** Client (page) coordinates of a target; used by the UI tests. */
  screenOf(cs: string): { x: number; y: number } | undefined {
    const f = this.model.flights().find((x) => x.callsign === cs);
    if (!f) return undefined;
    const s = this.toScreen(f.pos);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + s.x, y: r.top + s.y };
  }

  private zoomAt(f: number, sx: number, sy: number) {
    const before = this.toNm(sx, sy);
    this.view.scale = Math.min(60, Math.max(0.8, this.view.scale * f));
    const after = this.toNm(sx, sy);
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.invalidate();
  }

  private blockOffset(cs: string) {
    return this.offsets.get(cs) ?? { dx: 14, dy: -16 };
  }

  private hit(sx: number, sy: number): Flight | undefined {
    let best: Flight | undefined, bd = 12;
    for (const f of this.model.flights()) {
      const s = this.toScreen(f.pos);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d < bd) { bd = d; best = f; }
    }
    return best;
  }

  private hitBlock(sx: number, sy: number): Flight | undefined {
    for (const f of this.model.flights()) {
      const s = this.toScreen(f.pos);
      const o = this.blockOffset(f.callsign);
      const bx = s.x + o.dx, by = s.y + o.dy - 11;
      if (sx >= bx && sx <= bx + 70 && sy >= by && sy <= by + 40) return f;
    }
    return undefined;
  }

  private down(e: PointerEvent) {
    if (e.button !== 0) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sx = e.offsetX, sy = e.offsetY;
    if (this.measureMode || e.shiftKey) {
      const p = this.toNm(sx, sy);
      this.measure = { a: p, b: p };
      this.drag = { kind: 'measure', sx, sy, vx: 0, vy: 0, moved: false };
      return;
    }
    const block = this.hit(sx, sy) ? undefined : this.hitBlock(sx, sy);
    if (block) {
      const o = this.blockOffset(block.callsign);
      this.drag = { kind: 'block', cs: block.callsign, sx, sy, vx: 0, vy: 0, ox: o.dx, oy: o.dy, moved: false };
      return;
    }
    this.drag = { kind: 'pan', sx, sy, vx: this.view.x, vy: this.view.y, moved: false };
  }

  private move(e: PointerEvent) {
    const d = this.drag;
    if (!d) return;
    const dx = e.offsetX - d.sx, dy = e.offsetY - d.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    if (d.kind === 'pan' && d.moved) { this.view.x = d.vx - dx / this.view.scale; this.view.y = d.vy + dy / this.view.scale; }
    if (d.kind === 'block' && d.cs) this.offsets.set(d.cs, { dx: (d.ox ?? 0) + dx, dy: (d.oy ?? 0) + dy });
    if (d.kind === 'measure' && this.measure) this.measure.b = this.toNm(e.offsetX, e.offsetY);
    this.invalidate();
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = undefined;
    if (!d) return;
    if (!d.moved && d.kind !== 'measure') {
      const f = this.hit(e.offsetX, e.offsetY) ?? (d.kind === 'block' ? this.model.flights().find((x) => x.callsign === d.cs) : undefined);
      this.cb.onSelect?.(f?.callsign);
    }
    if (d.kind === 'measure' && !d.moved) this.measure = undefined;
    this.invalidate();
  }

  draw() {
    this.dirty = false;
    const { ctx, colors: c } = this;
    const now = Date.now();
    for (const [cs, until] of this.flashing) if (until < now) this.flashing.delete(cs);
    ctx.fillStyle = c.scope;
    ctx.fillRect(0, 0, this.w, this.hgt);

    // terrain cells (minimum safe altitude >= 5,000 ft)
    if (this.showTerrain) {
      for (let cy = 0; cy < TERRAIN_N; cy++) for (let cx = 0; cx < TERRAIN_N; cx++) {
        const msa = TERRAIN[cy][cx];
        if (msa < 5000) continue;
        const p = this.toScreen({ x: TERRAIN_MIN + cx * TERRAIN_CELL, y: TERRAIN_MIN + (cy + 1) * TERRAIN_CELL });
        const s = TERRAIN_CELL * this.view.scale;
        ctx.fillStyle = c.terrain;
        ctx.fillRect(p.x, p.y, s, s);
        if (msa >= 8000) ctx.fillRect(p.x, p.y, s, s);
        if (this.view.scale > 3) {
          ctx.fillStyle = c.muted;
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(String(msa / 100), p.x + 3, p.y + 12);
        }
      }
    }

    // range rings every 10 NM
    const o = this.toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = c.ring;
    ctx.lineWidth = 1;
    for (let r = 10; r <= 110; r += 10) {
      ctx.beginPath();
      ctx.arc(o.x, o.y, r * this.view.scale, 0, Math.PI * 2);
      ctx.stroke();
    }

    // sector boundaries
    ctx.strokeStyle = c.boundary;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 4]);
    for (const line of sectorBoundaries()) {
      ctx.beginPath();
      line.forEach((p, i) => { const s = this.toScreen(p); if (i) ctx.lineTo(s.x, s.y); else ctx.moveTo(s.x, s.y); });
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = c.muted;
    ctx.font = '11px ui-sans-serif, system-ui';
    for (const [label, p] of [['CTR-NW', { x: -70, y: 70 }], ['CTR-SE', { x: 70, y: -70 }], ['APP', { x: -20, y: 28 }]] as const) {
      const s = this.toScreen(p);
      ctx.fillText(label, s.x, s.y);
    }

    // runways + extended centrelines
    for (const rwy of Object.values(RUNWAYS)) {
      const a = this.toScreen(rwy.thr), b = this.toScreen(rwy.end), f = this.toScreen({ x: rwy.thr.x + 10, y: rwy.thr.y });
      ctx.strokeStyle = c.fix;
      ctx.setLineDash([2, 6]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(f.x, f.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = c.runway;
      ctx.lineWidth = Math.max(2, this.view.scale * 0.15);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineWidth = 1;
      if (this.view.scale > 6) { ctx.fillStyle = c.muted; ctx.fillText(rwy.id, a.x + 4, a.y + (rwy.id.endsWith('L') ? 12 : -4)); }
    }

    // fixes
    ctx.font = '10px ui-monospace, monospace';
    for (const fx of Object.values(FIXES)) {
      const s = this.toScreen(fx.pos);
      ctx.strokeStyle = c.fix;
      ctx.beginPath(); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x + 4, s.y + 3); ctx.lineTo(s.x - 4, s.y + 3); ctx.closePath(); ctx.stroke();
      ctx.fillStyle = c.fix;
      ctx.fillText(fx.name, s.x + 6, s.y + 3);
    }

    const flights = this.model.flights();
    const pos = this.model.position();
    const sel = this.model.selected();
    const alertSet = this.model.alertFlights();
    const inbound = this.model.inbound();
    const byCs = new Map(flights.map((f) => [f.callsign, f]));

    // conflict pairs: red dashed line for as long as the safety net holds the alert
    ctx.strokeStyle = c.warning;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    for (const [a, b] of this.model.conflictPairs()) {
      const fa = byCs.get(a), fb = byCs.get(b);
      if (!fa || !fb) continue;
      const sa = this.toScreen(fa.pos), sb = this.toScreen(fb.pos);
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    const blink = Math.floor(now / 400) % 2 === 0;
    for (const f of flights) {
      const s = this.toScreen(f.pos);
      const mine = pos !== 'OBS' && (pos === 'SUP' || this.model.effective(f.owner) === pos);
      const emergency = ['7700', '7600', '7500'].includes(f.squawk);
      let color = mine ? c.own : c.other;
      if (inbound.has(f.callsign)) color = c.handoff;
      if (sel === f.callsign) color = c.selected;
      if (alertSet.has(f.callsign)) color = c.warning;
      if (emergency) color = c.emerg;
      if (this.flashing.has(f.callsign) && blink) color = c.selected;

      // history trail
      const hist = this.model.history(f.id) ?? [];
      ctx.fillStyle = color;
      hist.slice(0, -1).forEach((p, i) => {
        const hs = this.toScreen(p);
        ctx.globalAlpha = 0.15 + (i / hist.length) * 0.4;
        ctx.fillRect(hs.x - 1.5, hs.y - 1.5, 3, 3);
      });
      ctx.globalAlpha = 1;

      // target symbol
      ctx.strokeStyle = color;
      ctx.lineWidth = mine ? 1.8 : 1.2;
      const r = 4;
      if (f.phase === 'holding-short' || f.phase === 'lineup') {
        ctx.strokeRect(s.x - 2.5, s.y - 2.5, 5, 5);
      } else if (f.coast) {
        ctx.setLineDash([2, 2]);
        ctx.strokeRect(s.x - r, s.y - r, r * 2, r * 2);
        ctx.setLineDash([]);
      } else {
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.stroke();
      }
      // velocity leader: 1 minute
      if (f.gs > 30) {
        const rad = (f.trk * Math.PI) / 180, len = (f.gs / 60) * this.view.scale;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + Math.sin(rad) * len, s.y - Math.cos(rad) * len); ctx.stroke();
      }
      if ((sel === f.callsign || this.flashing.has(f.callsign)) && !emergency) {
        ctx.strokeStyle = c.selected;
        ctx.beginPath(); ctx.arc(s.x, s.y, 9, 0, Math.PI * 2); ctx.stroke();
      }

      // data block: callsign / altitude (hundreds) + cleared + ground speed / type when selected
      const off = this.blockOffset(f.callsign);
      const bx = s.x + off.dx, by = s.y + off.dy;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(s.x + 3, s.y - 3); ctx.lineTo(bx - 2, by + 2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.font = `${mine ? 'bold ' : ''}12px ui-monospace, Menlo, monospace`;
      const flags = `${emergency ? ` ${f.squawk}` : ''}${inbound.has(f.callsign) ? ' HO' : ''}${f.coast ? ' CST' : ''}`;
      ctx.fillText(`${f.callsign}${flags}`, bx, by);
      const arrow = f.vs > 300 ? '↑' : f.vs < -300 ? '↓' : ' ';
      const clr = f.cleared.alt !== undefined && Math.abs(f.cleared.alt - f.alt) > 150 ? `${arrow}${altLabel(f.cleared.alt)}` : ' ';
      ctx.fillText(`${altLabel(f.alt)}${clr} ${String(Math.round(f.gs / 10)).padStart(2, '0')}`, bx, by + 13);
      if (sel === f.callsign) ctx.fillText(`${f.type}/${f.wake}${f.runway ? ` ${f.runway}` : ''}${f.seq ? ` #${f.seq}` : ''}`, bx, by + 26);
      else if (f.seq && mine) { ctx.globalAlpha = 0.7; ctx.fillText(`#${f.seq} ${f.runway ?? ''}`, bx, by + 26); ctx.globalAlpha = 1; }
    }

    // measure tool: range and bearing
    if (this.measure) {
      const a = this.toScreen(this.measure.a), b = this.toScreen(this.measure.b);
      ctx.strokeStyle = c.selected;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const d = Math.hypot(this.measure.b.x - this.measure.a.x, this.measure.b.y - this.measure.a.y);
      const brg = ((Math.atan2(this.measure.b.x - this.measure.a.x, this.measure.b.y - this.measure.a.y) * 180) / Math.PI + 360) % 360;
      ctx.fillStyle = c.selected;
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.fillText(`${d.toFixed(1)} NM ${String(Math.round(brg) || 360).padStart(3, '0')}°`, b.x + 8, b.y - 8);
    }
  }
}
