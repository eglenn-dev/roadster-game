import { Vector3 } from 'three';

/** Result of a closest-surface query. `dist` is signed: >0 above / in front of the surface. */
export interface SurfaceHit {
  dist: number;
  normal: Vector3;
  grip: number;
  id: number;
}

export function makeHit(): SurfaceHit {
  return { dist: 0, normal: new Vector3(0, 1, 0), grip: 1, id: -1 };
}

export interface Surface {
  id: number;
  /** Driving-surface query. Returns false when `p` is outside the surface's domain. */
  query(p: Vector3, hit: SurfaceHit): boolean;
  /** Solid-body penetration query for chassis contact points. Returns penetration depth (>0) or 0. */
  penetrate(p: Vector3, outNormal: Vector3): number;
}

export class GroundPlane implements Surface {
  constructor(public id: number, public grip = 1) {}
  query(p: Vector3, hit: SurfaceHit): boolean {
    hit.dist = p.y;
    hit.normal.set(0, 1, 0);
    hit.grip = this.grip;
    hit.id = this.id;
    return true;
  }
  penetrate(p: Vector3, n: Vector3): number {
    if (p.y >= 0) return 0;
    n.set(0, 1, 0);
    return -p.y;
  }
}

/**
 * The event's curved ramp: a deck that starts flush with the ground and curls
 * up and over until it is upside down. In the ramp's vertical plane the deck is
 * a circular arc of radius R centred at (0, R). Angle φ is measured from the
 * bottom of the circle: φ=0 at ground level, φ=π/2 vertical wall, φ=π inverted.
 */
export class ArchRamp implements Surface {
  readonly origin: Vector3;
  readonly dir: Vector3;
  readonly side: Vector3;
  readonly thickness = 0.5;
  constructor(
    public id: number,
    origin: Vector3,
    yaw: number,
    public radius = 9.5,
    public width = 7,
    public phiStart = 0.04,
    public phiEnd = Math.PI + 0.36,
    public grip = 0.95,
  ) {
    this.origin = origin.clone();
    this.dir = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.side = new Vector3(Math.sin(yaw), 0, Math.cos(yaw));
  }

  /** World position on the deck at angle φ and lateral offset b. */
  pointAt(phi: number, b: number, out: Vector3): Vector3 {
    const a = this.radius * Math.sin(phi);
    const y = this.radius - this.radius * Math.cos(phi);
    return out.copy(this.origin).addScaledVector(this.dir, a).addScaledVector(this.side, b).setY(this.origin.y + y);
  }

  /** Inward-facing deck normal at angle φ. */
  normalAt(phi: number, out: Vector3): Vector3 {
    return out.copy(this.dir).multiplyScalar(-Math.sin(phi)).setY(Math.cos(phi));
  }

  /** Local polar coordinates of `p`: [phi, r, b]. phi in (-π/2, 3π/2]. */
  local(p: Vector3): [number, number, number] {
    const dx = p.x - this.origin.x;
    const dz = p.z - this.origin.z;
    const a = dx * this.dir.x + dz * this.dir.z;
    const b = dx * this.side.x + dz * this.side.z;
    const da = a;
    const dy = p.y - this.origin.y - this.radius;
    const r = Math.hypot(da, dy);
    let phi = Math.atan2(da, -dy);
    if (phi < -Math.PI / 2) phi += Math.PI * 2;
    return [phi, r, b];
  }

  query(p: Vector3, hit: SurfaceHit): boolean {
    const [phi, r, b] = this.local(p);
    if (Math.abs(b) > this.width / 2) return false;
    if (phi < this.phiStart || phi > this.phiEnd) return false;
    const d = this.radius - r;
    if (d < -0.3 || d > 3.5 || r < 1e-3) return false;
    hit.dist = d;
    this.normalAt(phi, hit.normal);
    hit.grip = this.grip;
    hit.id = this.id;
    return true;
  }

  penetrate(p: Vector3, n: Vector3): number {
    const [phi, r, b] = this.local(p);
    if (Math.abs(b) > this.width / 2 + 0.05) return 0;
    if (phi < this.phiStart || phi > this.phiEnd) return 0;
    const inner = r - this.radius; // >0 means pushed through the deck from inside
    if (inner <= 0 || inner >= this.thickness) return 0;
    const outer = this.thickness - inner;
    this.normalAt(phi, n);
    if (inner <= outer) return inner;
    n.negate();
    return outer;
  }
}

/** Static oriented box (yaw only): parked vehicles, stage, structure. */
export class BoxObstacle implements Surface {
  readonly center: Vector3;
  readonly half: Vector3;
  private c: number;
  private s: number;
  constructor(public id: number, center: Vector3, half: Vector3, public yaw = 0, public grip = 0.8) {
    this.center = center.clone();
    this.half = half.clone();
    this.c = Math.cos(yaw);
    this.s = Math.sin(yaw);
  }

  private toLocal(p: Vector3, out: Vector3) {
    const dx = p.x - this.center.x;
    const dz = p.z - this.center.z;
    out.set(dx * this.c - dz * this.s, p.y - this.center.y, dx * this.s + dz * this.c);
  }

  private dirToWorld(lx: number, ly: number, lz: number, out: Vector3) {
    out.set(lx * this.c + lz * this.s, ly, -lx * this.s + lz * this.c);
  }

  query(p: Vector3, hit: SurfaceHit): boolean {
    this.toLocal(p, tmpL);
    if (Math.abs(tmpL.x) > this.half.x || Math.abs(tmpL.z) > this.half.z) return false;
    const d = tmpL.y - this.half.y;
    if (d < -0.4 || d > 3) return false;
    hit.dist = d;
    hit.normal.set(0, 1, 0);
    hit.grip = this.grip;
    hit.id = this.id;
    return true;
  }

  penetrate(p: Vector3, n: Vector3): number {
    this.toLocal(p, tmpL);
    const px = this.half.x - Math.abs(tmpL.x);
    const py = this.half.y - Math.abs(tmpL.y);
    const pz = this.half.z - Math.abs(tmpL.z);
    if (px <= 0 || py <= 0 || pz <= 0) return 0;
    if (py <= px && py <= pz) {
      this.dirToWorld(0, Math.sign(tmpL.y) || 1, 0, n);
      return py;
    }
    if (px <= pz) {
      this.dirToWorld(Math.sign(tmpL.x) || 1, 0, 0, n);
      return px;
    }
    this.dirToWorld(0, 0, Math.sign(tmpL.z) || 1, n);
    return pz;
  }

  /** Height of the box top if `p` is above its footprint, else -Infinity. */
  topBelow(p: Vector3): number {
    this.toLocal(p, tmpL);
    if (Math.abs(tmpL.x) > this.half.x || Math.abs(tmpL.z) > this.half.z) return -Infinity;
    const top = this.center.y + this.half.y;
    return p.y >= top - 0.2 ? top : -Infinity;
  }
}

const tmpL = new Vector3();

/** Circular pad that refills the cold-gas tanks. */
export interface RefillPad {
  x: number;
  z: number;
  radius: number;
}

export class PhysWorld {
  surfaces: Surface[] = [];
  boxes: BoxObstacle[] = [];
  arches: ArchRamp[] = [];
  pads: RefillPad[] = [];
  private nextId = 0;

  constructor() {
    this.surfaces.push(new GroundPlane(this.nextId++));
  }

  addArch(origin: Vector3, yaw: number, radius?: number, width?: number): ArchRamp {
    const a = new ArchRamp(this.nextId++, origin, yaw, radius, width);
    this.surfaces.push(a);
    this.arches.push(a);
    return a;
  }

  addBox(center: Vector3, half: Vector3, yaw = 0): BoxObstacle {
    const b = new BoxObstacle(this.nextId++, center, half, yaw);
    this.surfaces.push(b);
    this.boxes.push(b);
    return b;
  }

  /** Height of the highest walkable surface directly below `p` (ground or box tops). */
  heightBelow(p: Vector3): number {
    let h = 0;
    for (const b of this.boxes) h = Math.max(h, b.topBelow(p));
    return h;
  }
}
