// Flat-earth local frame: x = NM east, y = NM north of the airport reference point.
// Headings are degrees true, 0 = north, clockwise.

export type Vec = { x: number; y: number };

export const DEG = Math.PI / 180;

export function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Signed smallest difference to - from in degrees, in (-180, 180]. */
export function angleDiff(to: number, from: number): number {
  let d = norm360(to) - norm360(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

export function bearing(from: Vec, to: Vec): number {
  return norm360(Math.atan2(to.x - from.x, to.y - from.y) / DEG);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Unit vector for a heading. */
export function headingVec(hdg: number): Vec {
  return { x: Math.sin(hdg * DEG), y: Math.cos(hdg * DEG) };
}

export function move(p: Vec, hdg: number, nm: number): Vec {
  const v = headingVec(hdg);
  return { x: p.x + v.x * nm, y: p.y + v.y * nm };
}

export function round(n: number, step = 1): number {
  return Math.round(n / step) * step;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Point-in-polygon (ray casting). */
export function inPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
