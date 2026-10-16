import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';

// Procedural car-body loft. A body is described by a table of stations along
// its length; each station defines a half cross-section through a handful of
// control points that are smoothed with Catmull-Rom splines both across the
// section and along the body. The result is a single smooth indexed mesh with
// material groups: 0 = paint, 1 = black trim / wheel wells, 2 = glass.
//
// Coordinates: x = right, y = up from the ground, z = forward is negative.

export interface Station {
  z: number;
  yb: number; // floor height
  wb: number; // floor half-width
  yh: number; // hip (max width) height
  wh: number; // hip half-width
  ybelt: number; // belt line height
  wbelt: number; // belt half-width
  yroof: number; // centre-line top height (hood, roof or deck)
  wroof: number; // half-width of the roof/top surface
  glass: number; // 0 = none; >0 = how far down the greenhouse the glass reaches (1 = to belt line)
}

export interface Arch {
  z: number;
  y: number; // axle height
  r: number; // arch radius
  inner: number; // x the well tucks in to
}

export interface LoftOptions {
  rows?: number;
  segSamples?: number;
  arches?: Arch[];
  capTail?: boolean;
  capNose?: boolean;
  /** Extra smoothing of the greenhouse; 0 = tight canopy, 1 = soft. */
  tumble?: number;
}

const CTRL = 7; // control points per half section

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Interpolate a station table at z with Catmull-Rom on every field. */
function sampleStation(st: Station[], z: number): Station {
  let i = 0;
  while (i < st.length - 2 && st[i + 1].z < z) i++;
  const a = st[Math.max(0, i - 1)];
  const b = st[i];
  const c = st[i + 1];
  const d = st[Math.min(st.length - 1, i + 2)];
  const t = Math.max(0, Math.min(1, (z - b.z) / (c.z - b.z || 1)));
  const out = {} as Station;
  for (const k of Object.keys(b) as (keyof Station)[]) {
    out[k] = catmull(a[k], b[k], c[k], d[k], t);
  }
  out.z = z;
  // monotone guard for glass so it doesn't overshoot to negative
  out.glass = Math.max(0, Math.min(1, out.glass));
  return out;
}

/** Control points of a half section, bottom-centre → top-centre. */
function sectionControls(s: Station, tumble: number): [number, number][] {
  const g = s.glass > 0.05;
  const hTop = s.yroof - s.ybelt;
  const p4x = s.wroof + (s.wbelt - s.wroof) * (g ? 0.55 - tumble * 0.15 : 0.6);
  const p4y = s.ybelt + hTop * (g ? 0.5 : 0.55);
  return [
    [0, s.yb],
    [s.wb, s.yb],
    [s.wh, s.yh],
    [s.wbelt, s.ybelt],
    [p4x, p4y],
    [s.wroof * 0.62, s.yroof - Math.max(0, hTop) * 0.04],
    [0, s.yroof],
  ];
}

export function loftBody(stations: Station[], opts: LoftOptions = {}): BufferGeometry {
  const rows = opts.rows ?? 140;
  const segS = opts.segSamples ?? 6;
  const tumble = opts.tumble ?? 0;
  const arches = opts.arches ?? [];
  const z0 = stations[0].z;
  const z1 = stations[stations.length - 1].z;
  const half = (CTRL - 1) * segS + 1;
  const ringN = half * 2 - 1; // right half + mirrored left half (sharing centre points)

  const positions: number[] = [];
  const rawPositions: number[] = []; // before arch tucking, for smooth normals
  const isTrim: boolean[] = [];
  const glassFrom: number[] = []; // per row: segment index from which quads are glass
  const rowZ: number[] = [];

  for (let r = 0; r < rows; r++) {
    // ease rows towards the ends for rounder nose/tail
    const u = r / (rows - 1);
    const ue = 0.5 - 0.5 * Math.cos(Math.PI * u);
    const z = z0 + (z1 - z0) * (u * 0.35 + ue * 0.65);
    rowZ.push(z);
    const s = sampleStation(stations, z);
    const ctrl = sectionControls(s, tumble);
    const pts: [number, number][] = [];
    for (let k = 0; k < CTRL - 1; k++) {
      const p0 = ctrl[Math.max(0, k - 1)];
      const p1 = ctrl[k];
      const p2 = ctrl[k + 1];
      const p3 = ctrl[Math.min(CTRL - 1, k + 2)];
      for (let j = 0; j < segS; j++) {
        const t = j / segS;
        pts.push([Math.max(0, catmull(p0[0], p1[0], p2[0], p3[0], t)), catmull(p0[1], p1[1], p2[1], p3[1], t)]);
      }
    }
    pts.push(ctrl[CTRL - 1]);
    // greenhouse glass coverage: sample index where glass begins. The boundary
    // vertex is slid along the section so the glass edge is a smooth curve.
    const beltIdx = 3 * segS;
    const topIdx = (CTRL - 1) * segS;
    let gk = Infinity;
    if (s.glass > 0.05) {
      const gf = topIdx - (topIdx - beltIdx) * s.glass;
      gk = Math.min(topIdx, Math.ceil(gf - 1e-6));
      if (gk > 0 && gk < topIdx) {
        const t = gf - (gk - 1);
        const pa = pts[gk - 1];
        const pb = pts[gk];
        pts[gk] = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
      }
    }
    glassFrom.push(gk);

    const rawPts = pts.map((q) => [q[0], q[1]] as [number, number]);
    for (let i = 0; i < half; i++) rawPositions.push(rawPts[i][0], rawPts[i][1], z);
    for (let i = half - 2; i >= 0; i--) rawPositions.push(-rawPts[i][0], rawPts[i][1], z);
    // Wheel arches: points below the arch circle tuck in to form the well; the
    // first point above the circle is snapped onto it for a clean arch edge.
    const tucked: boolean[] = pts.map(() => false);
    for (const a of arches) {
      const dz = z - a.z;
      if (Math.abs(dz) >= a.r) continue;
      const ay = a.y + Math.sqrt(a.r * a.r - dz * dz);
      let lastTucked = -1;
      for (let i = 0; i < pts.length; i++) {
        if (pts[i][1] < ay && pts[i][0] > a.inner) {
          pts[i] = [a.inner, pts[i][1]];
          tucked[i] = true;
          lastTucked = i;
        }
      }
      if (lastTucked >= 0 && lastTucked + 1 < pts.length) {
        const i = lastTucked;
        const above = pts[i + 1];
        if (above[1] > ay && above[0] > a.inner) {
          // find where the original section crosses ay between i and i+1 and snap
          pts[i] = [a.inner, Math.min(ay - 0.004, above[1] - 0.004)];
          pts[i + 1] = [above[0], Math.max(ay, pts[i + 1][1] - (pts[i + 1][1] - ay))];
        }
      }
    }

    // ring: right half bottom→top, then left half top→bottom (skipping shared top)
    for (let i = 0; i < half; i++) {
      positions.push(pts[i][0], pts[i][1], z);
      isTrim.push(tucked[i]);
    }
    for (let i = half - 2; i >= 0; i--) {
      positions.push(-pts[i][0], pts[i][1], z);
      isTrim.push(tucked[i]);
    }
  }

  // Build index buffer grouped by material
  const groups: number[][] = [[], [], []];
  for (let r = 0; r < rows - 1; r++) {
    for (let i = 0; i < ringN - 1; i++) {
      const a = r * ringN + i;
      const b = r * ringN + i + 1;
      const c = (r + 1) * ringN + i;
      const d = (r + 1) * ringN + i + 1;
      // index across the half (0 = bottom centre .. half-1 = top)
      const hiA = i < half - 1 ? i : ringN - 1 - i;
      const hiB = i < half - 1 ? i + 1 : ringN - 2 - i;
      const lo = Math.min(hiA, hiB);
      // each triangle decides its own material so material edges run diagonally
      // instead of stair-stepping
      const triMat = (verts: number[]) => {
        let glass = true;
        let trim = false;
        for (const vtx of verts) {
          const row = Math.floor(vtx / ringN);
          const col = vtx % ringN;
          const h = col < half ? col : ringN - 1 - col;
          if (h < glassFrom[row]) glass = false;
          if (isTrim[vtx]) trim = true;
        }
        if (trim) return 1;
        if (glass) return 2;
        return lo < segS ? 1 : 0;
      };
      // Pick the quad diagonal so a single corner on the other side of a
      // material boundary is isolated; boundaries then follow the diagonal.
      const cat = (vtx: number) => {
        if (isTrim[vtx]) return 1;
        const row = Math.floor(vtx / ringN);
        const col = vtx % ringN;
        const h = col < half ? col : ringN - 1 - col;
        return h >= glassFrom[row] ? 2 : 0;
      };
      const ca = cat(a);
      const cb = cat(b);
      const cc = cat(c);
      const cd = cat(d);
      const oddB = cb !== ca && ca === cc && cc === cd;
      const oddC = cc !== ca && ca === cb && cb === cd;
      if (oddB || oddC) {
        groups[triMat([a, b, d])].push(a, b, d);
        groups[triMat([a, d, c])].push(a, d, c);
      } else {
        groups[triMat([a, b, c])].push(a, b, c);
        groups[triMat([b, d, c])].push(b, d, c);
      }
    }
  }

  // Caps
  const capRing = (r: number, flip: boolean, mat: number) => {
    const base = positions.length / 3;
    let cx = 0;
    let cy = 0;
    const cz = rowZ[r];
    for (let i = 0; i < ringN; i++) {
      cx += positions[(r * ringN + i) * 3];
      cy += positions[(r * ringN + i) * 3 + 1];
    }
    positions.push(cx / ringN, cy / ringN, cz);
    isTrim.push(false);
    for (let i = 0; i < ringN - 1; i++) {
      const a = r * ringN + i;
      const b = r * ringN + i + 1;
      if (flip) groups[mat].push(base, b, a);
      else groups[mat].push(base, a, b);
    }
    // close the ring
    const a = r * ringN + ringN - 1;
    const b = r * ringN;
    if (flip) groups[mat].push(base, b, a);
    else groups[mat].push(base, a, b);
  };
  if (opts.capNose !== false) capRing(0, true, 0);
  if (opts.capTail !== false) capRing(rows - 1, false, 1);

  // cap centre vertices were appended to positions only
  for (let i = rawPositions.length; i < positions.length; i++) rawPositions.push(positions[i]);
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(rawPositions, 3));
  const index: number[] = [];
  for (let g = 0; g < 3; g++) {
    const start = index.length;
    index.push(...groups[g]);
    geo.addGroup(start, groups[g].length, g);
  }
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // fix normals on the centre line seam (mirror symmetry)
  const n = geo.getAttribute('normal');
  const p = geo.getAttribute('position');
  const tmp = new Vector3();
  for (let i = 0; i < p.count; i++) {
    if (Math.abs(p.getX(i)) < 1e-5) {
      tmp.set(0, n.getY(i), n.getZ(i)).normalize();
      n.setXYZ(i, tmp.x, tmp.y, tmp.z);
    }
  }
  geo.computeBoundingSphere();
  return geo;
}

/** Sample the outer surface of a loft at (z, height) on the right side, for placing details. */
export function surfaceX(stations: Station[], z: number, y: number): number {
  const s = sampleStation(stations, z);
  const ctrl = sectionControls(s, 0);
  let best = 0;
  for (let k = 0; k < CTRL - 1; k++) {
    const p0 = ctrl[Math.max(0, k - 1)];
    const p1 = ctrl[k];
    const p2 = ctrl[k + 1];
    const p3 = ctrl[Math.min(CTRL - 1, k + 2)];
    for (let j = 0; j <= 12; j++) {
      const t = j / 12;
      const py = catmull(p0[1], p1[1], p2[1], p3[1], t);
      const px = catmull(p0[0], p1[0], p2[0], p3[0], t);
      if (Math.abs(py - y) < 0.03) best = Math.max(best, px);
    }
  }
  return best;
}

/**
 * Build the centre-line of a wheel-arch lip on one side of a lofted body:
 * follows the arch circle on the outer surface, above the sill.
 */
export function archLipPoints(stations: Station[], arch: Arch, side: number, minY: number, out = 0.012): Vector3[] {
  const pts: Vector3[] = [];
  for (let i = 0; i <= 48; i++) {
    const th = -Math.PI * 0.62 + (i / 48) * Math.PI * 1.24;
    const z = arch.z + arch.r * Math.sin(th);
    const y = arch.y + arch.r * Math.cos(th);
    if (y < minY) continue;
    const x = Math.max(arch.inner, surfaceX(stations, z, y)) + out;
    pts.push(new Vector3(side * x, y, z));
  }
  return pts;
}
