import {
  BoxGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Shape,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three/webgpu';
import { SHARED, darkGlass, paint, standard } from '../render/materials';
import { archLipPoints, loftBody, type Station } from './loft';
import { buildWheel } from './wheel';

// Supporting cast from the event: the five-vehicle lineup the Roadster jumped
// (Cybercab, Cybertruck, Semi, Model Y, Model 3) and the display cars on stage
// (original Roadster, Lotus Esprit "Wet Nellie"). All models face -Z.

interface SedanParams {
  L: number;
  W: number;
  H: number;
  floorY: number;
  noseY: number;
  hoodY: number;
  beltY: number;
  deckY: number;
  tailY: number;
  ws: number; // windshield base (fraction of length from the nose)
  rs: number; // roof start
  re: number; // roof end
  rg: number; // rear glass end
  roofW: number; // roof half-width as fraction of body half-width
  axles: [number, number]; // fractions
  wheelR: number;
  openTop?: boolean;
}

function smooth(a: number, b: number, t: number) {
  const x = Math.max(0, Math.min(1, t));
  return a + (b - a) * x * x * (3 - 2 * x);
}

function sedanStations(p: SedanParams): Station[] {
  const us = [0, 0.012, 0.04, 0.1, 0.18, p.ws, (p.ws + p.rs) / 2, p.rs, (p.rs + p.re) / 2, p.re, p.rg, (p.rg + 1) / 2, 0.95, 0.985, 1];
  const hw = p.W / 2;
  return us.map((u) => {
    const z = -p.L / 2 + u * p.L;
    const taperF = smooth(0.62, 1, u / 0.12);
    const taperR = smooth(1, 0.82, (u - 0.9) / 0.1);
    const taper = Math.min(taperF, taperR);
    let yroof: number;
    let glass = 0;
    if (u < 0.1) yroof = smooth(p.noseY, p.hoodY - 0.04, u / 0.1);
    else if (u < p.ws) yroof = smooth(p.hoodY - 0.04, p.hoodY, (u - 0.1) / (p.ws - 0.1));
    else if (u < p.rs) {
      yroof = smooth(p.hoodY, p.H, (u - p.ws) / (p.rs - p.ws));
      glass = 1;
    } else if (u <= p.re) {
      yroof = p.H;
      glass = p.openTop ? 0 : 1;
    } else if (u < p.rg) {
      yroof = smooth(p.H, p.deckY, (u - p.re) / (p.rg - p.re));
      glass = p.openTop ? 0 : 1;
    } else yroof = smooth(p.deckY, p.tailY, (u - p.rg) / (1 - p.rg));
    if (p.openTop && u > p.rs - 0.01) yroof = Math.min(yroof, p.beltY + 0.03);
    const inCabin = u > p.ws && u < p.rg;
    const beltY = u < 0.06 ? smooth(p.noseY - 0.05, p.beltY * 0.92, u / 0.06) : u > 0.97 ? p.tailY - 0.02 : p.beltY;
    return {
      z,
      yb: p.floorY + (u < 0.05 || u > 0.95 ? 0.06 : 0),
      wb: hw * 0.86 * taper,
      yh: p.floorY + (beltY - p.floorY) * 0.45,
      wh: hw * taper,
      ybelt: Math.min(beltY, yroof - 0.01),
      wbelt: hw * 0.95 * taper,
      yroof,
      wroof: hw * (inCabin ? p.roofW : 0.55) * taper,
      glass,
    };
  });
}

function addWheels(g: Group, p: { L: number; W: number; axles: [number, number]; wheelR: number }, rimMat: Material, extraAxles: number[] = []) {
  const zs = [...p.axles, ...extraAxles].map((a) => -p.L / 2 + a * p.L);
  for (const z of zs) {
    for (const side of [-1, 1]) {
      const w = buildWheel({ radius: p.wheelR, width: p.wheelR * 0.65, rimRadius: p.wheelR * 0.68, side, detail: 'low', rimMat, brakes: false, spokes: 6 });
      w.root.position.set(side * (p.W / 2 - p.wheelR * 0.36), p.wheelR, z);
      g.add(w.root);
    }
  }
}

function lightStrip(g: Group, pts: Vector3[], hex: number, intensity: number, r = 0.012) {
  const m = new MeshStandardNodeMaterial({ color: new Color(0) });
  m.emissive = new Color(hex);
  m.emissiveIntensity = intensity;
  g.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 24, r, 5), m));
}

export function buildSedan(p: SedanParams, color: Material, glass: Material = darkGlass()): Group {
  const g = new Group();
  const st = sedanStations(p);
  const arches = p.axles.map((a) => ({ z: -p.L / 2 + a * p.L, y: p.wheelR, r: p.wheelR + 0.06, inner: p.W / 2 - p.wheelR * 0.75 }));
  const body = new Mesh(loftBody(st, { rows: 90, segSamples: 5, arches }), [color, SHARED.trim, glass]);
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);
  for (const a of arches)
    for (const side of [-1, 1]) {
      const pts = archLipPoints(st, a, side, p.floorY + 0.03, 0.006);
      if (pts.length > 3) g.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 32, 0.016, 5), SHARED.trim));
    }
  addWheels(g, p, SHARED.graphite);
  // light bars
  const fz = -p.L / 2 + 0.06;
  const rz = p.L / 2 - 0.03;
  lightStrip(g, [new Vector3(-p.W * 0.4, p.noseY + 0.02, fz + 0.12), new Vector3(0, p.noseY + 0.04, fz), new Vector3(p.W * 0.4, p.noseY + 0.02, fz + 0.12)], 0xe8f0ff, 4);
  lightStrip(g, [new Vector3(-p.W * 0.42, p.tailY - 0.06, rz - 0.1), new Vector3(0, p.tailY - 0.05, rz), new Vector3(p.W * 0.42, p.tailY - 0.06, rz - 0.1)], 0xff1408, 2.5);
  return g;
}

export const MODEL3: SedanParams = {
  L: 4.72, W: 1.85, H: 1.44, floorY: 0.15, noseY: 0.62, hoodY: 0.86, beltY: 0.92, deckY: 1.0, tailY: 0.95,
  ws: 0.33, rs: 0.46, re: 0.62, rg: 0.8, roofW: 0.7, axles: [0.19, 0.79], wheelR: 0.34,
};
export const MODELY: SedanParams = {
  L: 4.79, W: 1.92, H: 1.62, floorY: 0.18, noseY: 0.7, hoodY: 0.96, beltY: 1.02, deckY: 1.14, tailY: 1.08,
  ws: 0.3, rs: 0.44, re: 0.68, rg: 0.88, roofW: 0.72, axles: [0.19, 0.79], wheelR: 0.37,
};
export const CYBERCAB: SedanParams = {
  L: 4.25, W: 1.95, H: 1.45, floorY: 0.17, noseY: 0.62, hoodY: 0.82, beltY: 0.86, deckY: 1.05, tailY: 0.98,
  ws: 0.24, rs: 0.38, re: 0.66, rg: 0.9, roofW: 0.68, axles: [0.18, 0.82], wheelR: 0.36,
};
const CLASSIC_ROADSTER: SedanParams = {
  L: 3.95, W: 1.85, H: 1.13, floorY: 0.13, noseY: 0.48, hoodY: 0.72, beltY: 0.8, deckY: 0.86, tailY: 0.86,
  ws: 0.36, rs: 0.46, re: 0.56, rg: 0.6, roofW: 0.66, axles: [0.2, 0.78], wheelR: 0.31, openTop: true,
};

/** Polygon side profile (z, y) extruded across the width, with chamfered edges. */
function extrudedBody(profile: [number, number][], width: number, mat: Material, bevel = 0.03) {
  const s = new Shape();
  s.moveTo(profile[0][0], profile[0][1]);
  for (let i = 1; i < profile.length; i++) s.lineTo(profile[i][0], profile[i][1]);
  s.closePath();
  const geo = new ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: 4 });
  geo.translate(0, 0, -(width - bevel * 2) / 2);
  geo.rotateY(Math.PI / 2); // shape x → -z (forward), extrusion z → x
  const m = new Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildCybertruck(): Group {
  const g = new Group();
  const L = 5.68;
  const W = 2.03;
  const steel = standard(0xbfc4ca, 0.32, 1);
  // profile in (x = -z, y): nose at +L/2 in shape x so rotateY maps it forward
  const h = L / 2;
  const prof: [number, number][] = [
    [h, 0.48],
    [h, 1.02],
    [h - 1.35, 1.36],
    [h - 2.45, 1.79],
    [-h, 1.25],
    [-h, 0.5],
    [-h + 0.55, 0.42],
    [-h + 0.75, 0.98],
    [-h + 1.55, 0.98],
    [-h + 1.75, 0.42],
    [h - 1.75, 0.42],
    [h - 1.55, 0.98],
    [h - 0.75, 0.98],
    [h - 0.55, 0.42],
  ];
  g.add(extrudedBody(prof, W, steel));
  // glass band
  const glassProf: [number, number][] = [
    [h - 1.45, 1.37],
    [h - 2.42, 1.75],
    [h - 3.3, 1.5],
    [h - 3.3, 1.28],
    [h - 1.6, 1.28],
  ];
  g.add(extrudedBody(glassProf, W + 0.02, darkGlass(), 0.005));
  addWheels(g, { L, W: W + 0.02, axles: [0.2025, 0.7975], wheelR: 0.43 }, SHARED.graphite);
  lightStrip(g, [new Vector3(-0.98, 1.0, -h - 0.02), new Vector3(0.98, 1.0, -h - 0.02)], 0xf0f6ff, 6, 0.014);
  lightStrip(g, [new Vector3(-0.98, 1.22, h + 0.02), new Vector3(0.98, 1.22, h + 0.02)], 0xff1408, 3, 0.014);
  return g;
}

// z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass  (cab-local z, nose at -1.65)
const SEMI_CAB: number[][] = [
  [-1.66, 0.62, 0.95, 0.9, 1.08, 1.25, 1.05, 1.32, 0.85, 0],
  [-1.6, 0.56, 1.12, 0.95, 1.24, 1.55, 1.2, 1.7, 0.98, 0],
  [-1.45, 0.55, 1.16, 1.0, 1.27, 1.85, 1.25, 2.2, 1.02, 0],
  [-1.2, 0.55, 1.16, 1.0, 1.27, 1.98, 1.27, 2.75, 1.05, 0.55],
  [-0.8, 0.55, 1.16, 1.0, 1.27, 2.02, 1.27, 3.35, 1.08, 0.62],
  [-0.35, 0.55, 1.16, 1.0, 1.27, 2.05, 1.27, 3.8, 1.1, 0.35],
  [0.2, 0.55, 1.16, 1.0, 1.27, 2.05, 1.27, 4.02, 1.12, 0],
  [1.0, 0.55, 1.16, 1.0, 1.27, 2.05, 1.27, 4.05, 1.12, 0],
  [1.6, 0.55, 1.14, 1.0, 1.25, 2.05, 1.25, 4.0, 1.1, 0],
  [1.66, 0.6, 1.08, 1.0, 1.2, 2.0, 1.2, 3.94, 1.05, 0],
];

export function buildSemi(): Group {
  const g = new Group();
  const white = paint(0xeeeeee, { roughness: 0.35 });
  const L = 6.6;
  const st = SEMI_CAB.map(([z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass]) => ({ z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass }));
  const body = new Mesh(loftBody(st, { rows: 80, segSamples: 5, arches: [{ z: -0.86, y: 0.52, r: 0.62, inner: 0.82 }], capTail: true }), [white, SHARED.trim, darkGlass()]);
  body.castShadow = true;
  body.receiveShadow = true;
  body.position.z = -L / 2 + 1.66;
  g.add(body);
  // chassis rails, fifth wheel, side skirts and battery boxes
  const rail = new Mesh(new BoxGeometry(1.05, 0.32, L - 3.4), SHARED.darkSteel);
  rail.position.set(0, 0.9, 1.6);
  g.add(rail);
  const fifth = new Mesh(new CylinderGeometry(0.75, 0.75, 0.12, 24), SHARED.darkSteel);
  fifth.position.set(0, 1.12, 2.2);
  g.add(fifth);
  for (const side of [-1, 1]) {
    const skirt = new Mesh(new BoxGeometry(0.08, 0.75, 1.2), white);
    skirt.position.set(side * 1.18, 0.78, 0.55);
    g.add(skirt);
  }
  addWheels(g, { L, W: 2.5, axles: [0.12, 0.7], wheelR: 0.52 }, SHARED.steel, [0.88]);
  lightStrip(g, [new Vector3(-1.05, 1.32, -L / 2 + 0.06), new Vector3(0, 1.3, -L / 2 + 0.0), new Vector3(1.05, 1.32, -L / 2 + 0.06)], 0xf0f6ff, 5, 0.018);
  return g;
}

export function buildModel3() {
  return buildSedan(MODEL3, paint(0xa3121c, { roughness: 0.22, metalness: 0.4 }));
}
export function buildModelY() {
  return buildSedan(MODELY, paint(0x1d3d78, { roughness: 0.24, metalness: 0.45 }));
}
export function buildCybercab() {
  return buildSedan(CYBERCAB, paint(0xc7ad7a, { roughness: 0.3, metalness: 0.7 }));
}
export function buildClassicRoadster() {
  return buildSedan(CLASSIC_ROADSTER, paint(0xb3141b, { roughness: 0.22, metalness: 0.3 }));
}

export function buildEsprit(): Group {
  const g = new Group();
  const white = paint(0xf2f2ee, { roughness: 0.26 });
  const L = 4.19;
  const h = L / 2;
  const prof: [number, number][] = [
    [h, 0.25],
    [h, 0.5],
    [h - 1.25, 0.82],
    [h - 1.9, 1.11],
    [h - 2.8, 1.08],
    [-h, 0.9],
    [-h, 0.3],
    [-h + 0.5, 0.2],
    [h - 0.5, 0.2],
  ];
  g.add(extrudedBody(prof, 1.85, white, 0.05));
  g.add(extrudedBody([[h - 1.3, 0.84], [h - 1.88, 1.09], [h - 2.7, 1.07], [h - 2.7, 0.88]], 1.87, darkGlass(), 0.005));
  addWheels(g, { L, W: 1.85, axles: [0.2, 0.8], wheelR: 0.31 }, SHARED.steel);
  return g;
}
