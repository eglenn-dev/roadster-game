import { Color, Mesh, MeshStandardNodeMaterial, PlaneGeometry } from 'three/webgpu';
import {
  Fn,
  abs,
  clamp,
  float,
  floor,
  fract,
  fwidth,
  max,
  min,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  positionWorld,
  smoothstep,
  step,
  vec2,
  vec3,
} from 'three/tsl';
import { LAYOUT } from '../sim/layout';

// TSL node graphs are dynamically typed; keep helper signatures loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

/** Anti-aliased 1D band: 1 inside |x - c| < w/2. */
function band(x: N, c: number | N, w: number): N {
  const d = abs(x.sub(c));
  const fw = max(fwidth(x), 0.0005);
  return float(1).sub(smoothstep(float(w / 2).sub(fw), float(w / 2).add(fw), d));
}

/** Anti-aliased rectangle mask. */
function rect(p: N, x0: number, x1: number, z0: number, z1: number, soft = 0): N {
  const fx = max(fwidth(p.x), 0.001).add(soft);
  const fz = max(fwidth(p.y), 0.001).add(soft);
  const mx = smoothstep(x0 - 0, fx.add(x0), p.x).mul(float(1).sub(smoothstep(float(x1).sub(fx), x1, p.x)));
  const mz = smoothstep(z0, fz.add(z0), p.y).mul(float(1).sub(smoothstep(float(z1).sub(fz), z1, p.y)));
  return mx.mul(mz);
}

export function buildGround(): Mesh {
  const S = LAYOUT.strip;
  const L = LAYOUT.lineup;
  const A = LAYOUT.arch;
  const mat = new MeshStandardNodeMaterial({ color: new Color(1, 1, 1), roughness: 0.85, metalness: 0 });

  const stripX0 = S.x - S.width / 2;
  const stripX1 = S.x + S.width / 2;
  const stripZ0 = S.startZ - S.length - 120;
  const stripZ1 = S.startZ + 80;

  const shade = Fn(() => {
    const p = positionWorld.xz;
    const n1 = mx_fractal_noise_float(vec3(p.x, p.y, 0).mul(0.08), 3, 2.0, 0.5);
    const n2 = mx_noise_float(vec3(p.x, p.y, 0).mul(1.7));
    const grain = mx_noise_float(vec3(p.x, p.y, 0).mul(9.0));

    // Texas scrub / dirt
    const grass = mix(vec3(0.05, 0.055, 0.03), vec3(0.085, 0.075, 0.05), n1.mul(0.5).add(0.5)).toVar();
    const rough = float(0.95).toVar();

    // Concrete apron with expansion joints
    const apron = rect(p, -270, 215, -270, 245, 0.5);
    const concrete = vec3(0.33, 0.325, 0.31).mul(float(0.82).add(n1.mul(0.12)).add(grain.mul(0.04))).toVar();
    const jx = band(fract(p.x.div(7.5)).mul(7.5), 0, 0.05);
    const jz = band(fract(p.y.div(7.5)).mul(7.5), 0, 0.05);
    concrete.mulAssign(float(1).sub(max(jx, jz).mul(0.45)));
    // tire rubber and oil stains
    const stain = smoothstep(0.35, 0.75, mx_noise_float(vec3(p.x, p.y, 0).mul(0.05)).add(n2.mul(0.15)));
    concrete.mulAssign(float(1).sub(stain.mul(0.35)));

    // Asphalt drag strip & connector road
    const strip = max(rect(p, stripX0, stripX1, stripZ0, stripZ1), rect(p, 190, stripX0 + 1, 205, 285));
    const asphalt = vec3(0.075, 0.075, 0.078).mul(float(0.85).add(n1.mul(0.1)).add(grain.mul(0.08))).toVar();
    // rubbered-in launch area
    const launch = rect(p, S.x - 3.5, S.x + 3.5, S.startZ - 260, S.startZ + 5, 3);
    asphalt.mulAssign(float(1).sub(launch.mul(0.45)));

    const base = mix(grass, concrete, apron).toVar();
    base.assign(mix(base, asphalt, strip));
    rough.assign(mix(rough, float(0.78), apron));
    rough.assign(mix(rough, float(0.62).sub(launch.mul(0.12)), strip));

    // --- markings ---------------------------------------------------------
    const white = vec3(0.85, 0.85, 0.82);
    const yellow = vec3(0.85, 0.62, 0.1);
    const red = vec3(0.75, 0.06, 0.05);
    const paint = float(0).toVar();
    const paintCol = white.toVar();

    // strip: edge lines, lane split, 100 m boards, start line
    const inStripZ = rect(p, stripX0 - 1, stripX1 + 1, stripZ0 + 20, S.startZ + 2);
    const edges = max(band(p.x, stripX0 + 0.6, 0.25), band(p.x, stripX1 - 0.6, 0.25)).mul(inStripZ);
    const dash = step(0.5, fract(p.y.div(12))).mul(band(p.x, S.x, 0.18)).mul(inStripZ);
    const boards = band(fract(p.y.sub(S.startZ).div(100)).mul(100), 0, 0.6).mul(rect(p, stripX0 + 1, stripX1 - 1, stripZ0, S.startZ - 50));
    const start = band(p.y, S.startZ, 0.5).mul(rect(p, stripX0, stripX1, S.startZ - 3, S.startZ + 3));
    const check = step(0.5, fract(p.x.div(1.0).add(step(0.5, fract(p.y.div(1.0))).mul(0.5)))).mul(rect(p, S.x - 4, S.x + 4, S.startZ + 1, S.startZ + 3));
    paint.assign(max(max(edges, dash), max(boards.mul(0.85), max(start, check))));

    // arch lane: yellow edges from the approach up to the deck
    const archLane = rect(p, A.approachX, A.origin.x + 0.5, -A.width / 2 - 1, A.width / 2 + 1);
    const archEdges = max(band(p.y, -A.width / 2, 0.22), band(p.y, A.width / 2, 0.22)).mul(archLane);
    const chevron = band(fract(p.x.add(abs(p.y).mul(0.6)).div(6)).mul(6), 0, 0.5).mul(rect(p, -40, -6, -2.2, 2.2));
    // landing target under the apex
    const ld = p.sub(vec2(A.origin.x - 0.5, A.origin.z)).length();
    const target = max(band(ld, 6, 0.3), band(ld, 3.2, 0.3));
    const archPaint = max(archEdges, max(chevron.mul(0.8), target));
    paint.assign(max(paint, archPaint));
    paintCol.assign(mix(paintCol, yellow, max(archEdges, target)));

    // lineup jump lane: lane lines, take-off bar, landing box
    const jl = rect(p, L.approachX, L.stopX, L.z - 4.5, L.z + 4.5);
    const jEdges = max(band(p.y, L.z - 4, 0.22), band(p.y, L.z + 4, 0.22)).mul(jl);
    const takeoff = band(p.x, L.takeoffX, 1.2).mul(rect(p, L.takeoffX - 2, L.takeoffX + 2, L.z - 4, L.z + 4));
    const stripes = step(0.5, fract(p.y.div(1.0)));
    const landing = band(p.x, L.landingX, 0.3).mul(rect(p, L.landingX - 1, L.landingX + 1, L.z - 4, L.z + 4));
    paint.assign(max(paint, max(jEdges, max(takeoff, landing))));
    paintCol.assign(mix(paintCol, mix(red, white, stripes), takeoff));

    const worn = smoothstep(-0.4, 0.6, n2).mul(0.25).add(0.75);
    base.assign(mix(base, paintCol.mul(worn), clamp(paint, 0, 1).mul(0.92)));
    rough.assign(mix(rough, float(0.55), paint));
    return vec3(base);
  });

  mat.colorNode = shade();
  mat.roughnessNode = Fn(() => {
    const p = positionWorld.xz;
    const n = mx_noise_float(vec3(p.x, p.y, 0).mul(0.3));
    const onStrip = rect(p, stripX0, stripX1, stripZ0, stripZ1);
    const apron = rect(p, -270, 215, -270, 245, 0.5);
    const r = mix(float(0.95), float(0.82), apron);
    return min(mix(r, float(0.62), onStrip).add(n.mul(0.06)), 1);
  })();
  void floor;

  const geo = new PlaneGeometry(9000, 9000, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const ground = new Mesh(geo, mat);
  ground.receiveShadow = true;
  return ground;
}
