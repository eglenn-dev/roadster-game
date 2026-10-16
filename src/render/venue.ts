import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
  SpotLight,
  TubeGeometry,
  Vector3,
  type Scene,
} from 'three/webgpu';
import { Fn, abs, float, fract, hash, instanceIndex, mix, sin, smoothstep, step, time, uv, vec3 } from 'three/tsl';
import { LAYOUT } from '../sim/layout';
import type { ArchRamp } from '../sim/world';
import { buildClassicRoadster, buildCybercab, buildCybertruck, buildEsprit, buildModel3, buildModelY, buildSemi } from '../models/vehicles';
import { SHARED, bakeStatic, emissive, standard } from './materials';

export interface Venue {
  root: Group;
  setBoard(lines: string[]): void;
  setTree(state: 'off' | 'stage' | 'amber' | 'green'): void;
  setPadsActive(active: boolean[]): void;
}

const WHITE_STEEL = standard(0x9aa0a8, 0.5, 0.7);

function archDeckGeometry(arch: ArchRamp, inner: boolean, nPhi = 96, nB = 10): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const p = new Vector3();
  const n = new Vector3();
  const R0 = arch.radius;
  for (let i = 0; i <= nPhi; i++) {
    const phi = arch.phiStart * 0 + (i / nPhi) * arch.phiEnd;
    for (let j = 0; j <= nB; j++) {
      const b = -arch.width / 2 + (j / nB) * arch.width;
      arch.pointAt(phi, b, p);
      arch.normalAt(phi, n);
      if (!inner) p.addScaledVector(n, -arch.thickness);
      // the first metre blends into the ground
      if (inner && phi < 0.06) p.y = Math.max(0.01, p.y);
      pos.push(p.x, p.y + (inner ? 0.004 : 0), p.z);
      if (inner) nrm.push(n.x, n.y, n.z);
      else nrm.push(-n.x, -n.y, -n.z);
      uvs.push((phi * R0) / 4, j / nB);
    }
  }
  for (let i = 0; i < nPhi; i++) {
    for (let j = 0; j < nB; j++) {
      const a = i * (nB + 1) + j;
      const b = a + 1;
      const c = a + nB + 1;
      const d = c + 1;
      if (inner) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

function buildArch(arch: ArchRamp): Group {
  const g = new Group();
  // Deck surface: grip-coated steel with hazard edges and a centre guide line
  const deckMat = new MeshStandardNodeMaterial({ roughness: 0.7, metalness: 0.3 });
  deckMat.colorNode = Fn(() => {
    const u = uv();
    const across = abs(u.y.sub(0.5)).mul(2);
    const base = vec3(0.07, 0.072, 0.078).toVar();
    const hazard = step(0.5, fract(u.x.mul(3).add(u.y.mul(6)))).mul(step(0.9, across));
    base.assign(mix(base, mix(vec3(0.02), vec3(0.85, 0.6, 0.05), hazard), step(0.9, across)));
    const guide = step(across, 0.025).mul(step(0.5, fract(u.x.mul(1.5))));
    base.assign(mix(base, vec3(0.8, 0.8, 0.78), guide));
    return base;
  })();
  const deck = new Mesh(archDeckGeometry(arch, true), deckMat);
  deck.receiveShadow = true;
  deck.castShadow = true;
  const under = new Mesh(archDeckGeometry(arch, false, 64, 4), WHITE_STEEL);
  under.castShadow = true;
  g.add(under);

  const p = new Vector3();
  const n = new Vector3();
  const arcPts = (b: number, off: number, n0 = 0.0) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const phi = n0 + (i / 64) * (arch.phiEnd - n0);
      arch.pointAt(phi, b, p);
      arch.normalAt(phi, n);
      pts.push(p.clone().addScaledVector(n, -off));
    }
    return pts;
  };
  // Side girders and LED edge lighting
  const led = emissive(0x9fd8ff, 5);
  for (const s of [-1, 1]) {
    const girder = new Mesh(new TubeGeometry(new CatmullRomCurve3(arcPts(s * (arch.width / 2 + 0.12), 0.3, 0.12)), 96, 0.22, 4), WHITE_STEEL);
    girder.castShadow = true;
    g.add(girder);
    g.add(new Mesh(new TubeGeometry(new CatmullRomCurve3(arcPts(s * (arch.width / 2 - 0.06), -0.02, 0.05)), 128, 0.025, 5), led));
  }
  // Cross ribs under the deck
  const basis = new Matrix4();
  const tng = new Vector3();
  for (let phi = 0.35; phi < arch.phiEnd; phi += 0.22) {
    arch.pointAt(phi, 0, p);
    arch.normalAt(phi, n);
    tng.copy(arch.dir).multiplyScalar(Math.cos(phi)).setY(Math.sin(phi));
    const rib = new Mesh(new BoxGeometry(0.35, 0.35, arch.width + 0.6), WHITE_STEEL);
    basis.makeBasis(tng, n, arch.side);
    rib.quaternion.setFromRotationMatrix(basis);
    rib.position.copy(p).addScaledVector(n, -arch.thickness - 0.15);
    g.add(rib);
  }
  // Side truss towers (carry the deck from outside so the middle stays open)
  const minA = Math.sin(arch.phiEnd) * arch.radius - 0.6;
  const cols = [minA, -0.5, 3.2, 6.4, arch.radius + 0.6];
  for (const s of [-1, 1]) {
    const zc = s * (arch.width / 2 + 0.75);
    const top = 2 * arch.radius + 1.0;
    for (const a of cols) {
      const col = new Mesh(new BoxGeometry(0.3, top, 0.3), WHITE_STEEL);
      col.position.set(arch.origin.x + a, top / 2, zc);
      col.castShadow = true;
      g.add(col);
    }
    for (let k = 0; k < cols.length - 1; k++) {
      const a0 = cols[k];
      const a1 = cols[k + 1];
      for (let lvl = 0; lvl < 2; lvl++) {
        const y0 = (lvl / 2) * top;
        const y1 = ((lvl + 1) / 2) * top;
        const v0 = new Vector3(arch.origin.x + a0, y0, zc);
        const v1 = new Vector3(arch.origin.x + a1, y1, zc);
        const len = v0.distanceTo(v1);
        const d = new Mesh(new BoxGeometry(0.09, len, 0.09), WHITE_STEEL);
        d.position.copy(v0).add(v1).multiplyScalar(0.5);
        d.lookAt(v1);
        d.rotateX(Math.PI / 2);
        g.add(d);
        const hbar = new Mesh(new BoxGeometry(a1 - a0, 0.12, 0.12), WHITE_STEEL);
        hbar.position.set(arch.origin.x + (a0 + a1) / 2, y1, zc);
        g.add(hbar);
      }
    }
  }
  const out = new Group();
  out.add(bakeStatic(g), deck); // the deck keeps its UVs for the paint pattern
  return out;
}

function makeScreenTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 2048;
  c.height = 640;
  const x = c.getContext('2d')!;
  const grd = x.createLinearGradient(0, 0, 0, c.height);
  grd.addColorStop(0, '#05070c');
  grd.addColorStop(1, '#101523');
  x.fillStyle = grd;
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#ffffff';
  x.font = '300 210px "Helvetica Neue", Arial, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  (x as unknown as { letterSpacing: string }).letterSpacing = '60px';
  x.fillText('ROADSTER', c.width / 2 + 30, c.height / 2 - 30);
  x.font = '400 46px "Helvetica Neue", Arial, sans-serif';
  (x as unknown as { letterSpacing: string }).letterSpacing = '14px';
  x.fillStyle = '#9aa3b5';
  x.fillText('0–60 MPH  <1 SEC   ·   230+ MPH   ·   300+ MI', c.width / 2, c.height / 2 + 140);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function buildStage(): Group {
  const S = LAYOUT.stage;
  const g = new Group();
  const plat = new Mesh(new BoxGeometry(S.width, S.height, S.depth), standard(0x0a0a0b, 0.6, 0.1));
  plat.position.set(S.x, S.height / 2, S.z);
  plat.receiveShadow = true;
  g.add(plat);
  const lip = new Mesh(new BoxGeometry(S.width, 0.04, 0.04), emissive(0xffffff, 3));
  lip.position.set(S.x, S.height, S.z - S.depth / 2);
  g.add(lip);
  // LED wall
  const scrMat = new MeshBasicNodeMaterial({ map: makeScreenTexture() });
  scrMat.color = new Color(0.75, 0.75, 0.75);
  const scr = new Mesh(new PlaneGeometry(30, 9.4), scrMat);
  scr.position.set(S.x, S.height + 5.4, S.z + S.depth / 2 - 0.4);
  scr.rotation.y = Math.PI;
  g.add(scr);
  // truss frame
  const truss = standard(0x1a1a1c, 0.5, 0.7);
  for (const sx of [-16, 16]) {
    const t = new Mesh(new BoxGeometry(0.5, 12, 0.5), truss);
    t.position.set(S.x + sx, 6, S.z + S.depth / 2 - 0.4);
    g.add(t);
  }
  const top = new Mesh(new BoxGeometry(33, 0.5, 0.5), truss);
  top.position.set(S.x, 12, S.z + S.depth / 2 - 0.4);
  g.add(top);
  const front = new Mesh(new BoxGeometry(33, 0.4, 0.4), truss);
  front.position.set(S.x, 11, S.z - S.depth / 2);
  g.add(front);
  for (const sx of [-16, 16]) {
    const t = new Mesh(new BoxGeometry(0.4, 11, 0.4), truss);
    t.position.set(S.x + sx, 5.5, S.z - S.depth / 2);
    g.add(t);
  }
  // par cans on the front truss
  const can = emissive(0xfff2e0, 8);
  for (let i = -7; i <= 7; i++) {
    const c = new Mesh(new CylinderGeometry(0.16, 0.2, 0.3, 10), can);
    c.position.set(S.x + i * 2.1, 10.7, S.z - S.depth / 2);
    g.add(c);
  }
  return g;
}

function buildCrowd(count: number): Group {
  const C = LAYOUT.crowd;
  const g = new Group();
  // tiered bleachers
  const tiers = 10;
  const bleach = standard(0x2b2d31, 0.7, 0.5);
  for (let i = 0; i < tiers; i++) {
    const step = new Mesh(new BoxGeometry(C.width, 0.5 + i * 1.1, C.depth / tiers), bleach);
    step.position.set(0, (0.5 + i * 1.1) / 2, C.z - C.depth / 2 + (i + 0.5) * (C.depth / tiers));
    step.receiveShadow = true;
    g.add(step);
  }
  const barrier = new Mesh(new BoxGeometry(C.width, 1.1, 0.5), standard(0x8a8d92, 0.8, 0));
  barrier.position.set(0, 0.55, C.z - C.depth / 2 - 2);
  g.add(barrier);
  const baked = bakeStatic(g);
  const out = new Group();
  out.add(baked);

  // People: instanced capsules with per-instance colour
  const geo = new CapsuleGeometry(0.22, 0.95, 3, 6);
  geo.translate(0, 0.7, 0);
  const mat = new MeshStandardNodeMaterial({ roughness: 0.85 });
  mat.colorNode = Fn(() => {
    const h = hash(instanceIndex);
    const h2 = hash(instanceIndex.add(7));
    const palette = mix(vec3(0.06, 0.06, 0.07), vec3(0.32, 0.3, 0.28), h);
    return mix(palette, vec3(0.5, 0.08, 0.06), step(0.93, h2));
  })();
  const people = new InstancedMesh(geo, mat, count);
  const o = new Object3D();
  const phones: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const row = Math.floor(Math.random() * tiers);
    const x = (Math.random() - 0.5) * (C.width - 4);
    const z = C.z - C.depth / 2 + (row + 0.5) * (C.depth / tiers) + (Math.random() - 0.5) * 1.5;
    const y = 0.5 + row * 1.1;
    o.position.set(x, y, z);
    o.rotation.y = Math.PI + (Math.random() - 0.5) * 0.6;
    o.scale.setScalar(0.9 + Math.random() * 0.2);
    o.updateMatrix();
    people.setMatrixAt(i, o.matrix);
    if (Math.random() < 0.35) phones.push(new Vector3(x + 0.15, y + 1.55, z - 0.3));
  }
  people.instanceMatrix.needsUpdate = true;
  people.frustumCulled = false;
  out.add(people);

  // Phone screens held up to film the stunts (twinkle via TSL)
  const phoneMat = new MeshBasicNodeMaterial();
  phoneMat.colorNode = Fn(() => {
    const h = hash(instanceIndex);
    const flash = smoothstep(0.985, 1.0, sin(time.mul(float(1.3).add(h.mul(2))).add(h.mul(60))).mul(0.5).add(0.5));
    return vec3(0.75, 0.82, 1.0).mul(float(1.2).add(flash.mul(14)));
  })();
  const phoneGeo = new PlaneGeometry(0.08, 0.15);
  const ph = new InstancedMesh(phoneGeo, phoneMat, phones.length);
  phones.forEach((p, i) => {
    o.position.copy(p);
    o.rotation.set(0, Math.PI, 0);
    o.scale.setScalar(1);
    o.updateMatrix();
    ph.setMatrixAt(i, o.matrix);
  });
  ph.frustumCulled = false;
  out.add(ph);
  return out;
}

interface TowerResult {
  group: Group;
  lights: SpotLight[];
}

function buildTowers(scene: Scene): TowerResult {
  const g = new Group();
  const mast = standard(0x5c6066, 0.6, 0.8);
  const lamp = emissive(0xfff1dc, 12);
  const lights: SpotLight[] = [];
  // aim points for the real light sources (the rest are visual only)
  const aims: Record<string, Vector3> = {
    '-60,40': new Vector3(-20, 0, 0),
    '60,40': new Vector3(10, 0, 0),
    '-60,-60': new Vector3(-10, 0, -20),
    '-80,-160': new Vector3(-20, 0, -120),
    '80,-160': new Vector3(10, 0, -120),
    '300,180': new Vector3(320, 0, 200),
  };
  for (const [x, z] of LAYOUT.lightTowers) {
    const m = new Mesh(new CylinderGeometry(0.28, 0.45, 24, 8), mast);
    m.position.set(x, 12, z);
    m.castShadow = true;
    g.add(m);
    const head = new Group();
    head.position.set(x, 24.4, z);
    const frame = new Mesh(new BoxGeometry(4.2, 2.4, 0.3), SHARED.darkSteel);
    head.add(frame);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 2; j++) {
        const l = new Mesh(new BoxGeometry(1.1, 0.8, 0.12), lamp);
        l.position.set(-1.35 + i * 1.35, -0.5 + j * 1.0, -0.2);
        head.add(l);
      }
    const key = `${x},${z}`;
    const aim = aims[key] ?? new Vector3(0, 0, 0);
    head.lookAt(aim.x, 24.4, aim.z);
    head.rotateX(0.35);
    g.add(head);
    if (aims[key]) {
      const s = new SpotLight(0xfff0d8, 120, 260, 0.62, 0.65, 1);
      s.position.set(x, 24, z);
      s.target.position.copy(aim);
      scene.add(s.target);
      lights.push(s);
      g.add(s);
    }
  }
  return { group: g, lights };
}

function buildLineup(): Object3D {
  const L = LAYOUT.lineup;
  const g = new Group();
  const builders = { cybercab: buildCybercab, cybertruck: buildCybertruck, semi: buildSemi, modely: buildModelY, model3: buildModel3 };
  for (const v of L.vehicles) {
    const m = builders[v.kind]();
    m.position.set(v.x, 0, L.z);
    // alternate the facing direction so the line reads like the event photos
    m.rotation.y = v.kind === 'semi' ? Math.PI : 0;
    g.add(m);
  }
  // emissive things must stay separate from the bake (they bake fine, materials kept)
  return bakeStatic(g);
}

function buildDisplays(): Object3D {
  const S = LAYOUT.stage;
  const g = new Group();
  const r = buildClassicRoadster();
  r.position.set(S.x - 30, 0, S.z - 4);
  r.rotation.y = Math.PI * 0.8;
  const e = buildEsprit();
  e.position.set(S.x + 30, 0, S.z - 4);
  e.rotation.y = -Math.PI * 0.8;
  const semi = buildSemi();
  semi.position.set(S.x + 42, 0, S.z + 2);
  semi.rotation.y = -Math.PI * 0.6;
  // display plinths
  for (const p of [r.position, e.position]) {
    const plinth = new Mesh(new CylinderGeometry(3.4, 3.4, 0.12, 40), standard(0x0b0b0c, 0.25, 0.6));
    plinth.position.set(p.x, 0.06, p.z);
    g.add(plinth);
    r.position.y = e.position.y = 0.12;
  }
  g.add(r, e, semi);
  return bakeStatic(g);
}

function buildDistant(): Group {
  const g = new Group();
  const steel = standard(0x3a3d42, 0.7, 0.6);
  // SpaceX test stands: lattice towers with aviation lights
  const stands: [number, number, number][] = [
    [-700, -1100, 85],
    [-520, -1250, 60],
    [650, -900, 70],
    [900, -1500, 95],
    [-1200, -400, 55],
  ];
  const red = emissive(0xff2010, 20);
  for (const [x, z, h] of stands) {
    const t = new Mesh(new BoxGeometry(9, h, 9), steel);
    t.position.set(x, h / 2, z);
    g.add(t);
    const deck = new Mesh(new BoxGeometry(24, 4, 14), steel);
    deck.position.set(x + 10, h * 0.45, z);
    g.add(deck);
    const tank = new Mesh(new CylinderGeometry(4.5, 4.5, h * 0.55, 16), standard(0x9da3aa, 0.4, 0.8));
    tank.position.set(x - 16, h * 0.275, z + 8);
    g.add(tank);
    const beacon = new Mesh(new BoxGeometry(1.2, 1.2, 1.2), red);
    beacon.position.set(x, h + 0.8, z);
    g.add(beacon);
    const lamp = new Mesh(new BoxGeometry(14, 0.6, 0.6), emissive(0xffe0b0, 8));
    lamp.position.set(x + 10, h * 0.45 + 2.4, z - 7.2);
    g.add(lamp);
  }
  // Tree line silhouettes
  const treeGeo = new ConeGeometry(1, 1, 6);
  treeGeo.translate(0, 0.5, 0);
  const trees = new InstancedMesh(treeGeo, standard(0x0a0d08, 0.95, 0), 520);
  const o = new Object3D();
  for (let i = 0; i < 520; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 900 + Math.random() * 900;
    o.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    const h = 6 + Math.random() * 10;
    o.scale.set(3 + Math.random() * 5, h, 3 + Math.random() * 5);
    o.updateMatrix();
    trees.setMatrixAt(i, o.matrix);
  }
  trees.frustumCulled = false;
  const baked = bakeStatic(g, false, false);
  const out = new Group();
  out.add(baked, trees);
  return out;
}

function makeBoardTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return { canvas: c, tex: t };
}

export function buildVenue(scene: Scene, arch: ArchRamp, crowdCount: number): Venue {
  const root = new Group();
  root.add(buildArch(arch));
  root.add(buildStage());
  root.add(buildCrowd(crowdCount));
  const towers = buildTowers(scene);
  root.add(towers.group);
  root.add(buildLineup());
  root.add(buildDisplays());
  root.add(buildDistant());

  // Lineup labels on the ground (small floor plaques) are omitted; the lane paint carries the read.

  // Refill pads
  const padMats: MeshStandardNodeMaterial[] = [];
  for (const p of LAYOUT.pads) {
    const m = emissive(0x38d0ff, 2);
    padMats.push(m);
    const ring = new Mesh(new RingGeometry(p.radius - 0.25, p.radius, 48), m);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(p.x, 0.02, p.z);
    root.add(ring);
    const inner = new Mesh(new RingGeometry(0.4, 0.55, 32), m);
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(p.x, 0.02, p.z);
    root.add(inner);
    const post = new Mesh(new BoxGeometry(0.5, 2.2, 0.5), SHARED.darkSteel);
    post.position.set(p.x + p.radius + 0.8, 1.1, p.z);
    root.add(post);
    const tank = new Mesh(new CapsuleGeometry(0.35, 1.4, 4, 12), standard(0x2e6fd6, 0.35, 0.6));
    tank.position.set(p.x + p.radius + 1.6, 1.05, p.z);
    root.add(tank);
  }

  // Drag strip furniture: timing board and christmas tree
  const S = LAYOUT.strip;
  const board = makeBoardTexture();
  const boardMat = new MeshBasicNodeMaterial({ map: board.tex, side: DoubleSide });
  boardMat.color = new Color(1.4, 1.4, 1.4);
  const boardMesh = new Mesh(new PlaneGeometry(10, 5), boardMat);
  boardMesh.position.set(S.x - S.width / 2 - 8, 7, S.startZ - 40);
  boardMesh.rotation.y = Math.PI / 2 - 0.3;
  root.add(boardMesh);
  const legs = new Mesh(new BoxGeometry(0.4, 4.5, 0.4), SHARED.darkSteel);
  legs.position.set(boardMesh.position.x, 2.25, boardMesh.position.z);
  root.add(legs);
  const treeGroup = new Group();
  treeGroup.position.set(S.x, 0, S.startZ - 6);
  const pole = new Mesh(new BoxGeometry(0.25, 2.6, 0.25), SHARED.darkSteel);
  pole.position.y = 1.3;
  treeGroup.add(pole);
  const bulbs: Record<string, MeshStandardNodeMaterial> = {
    stage: emissive(0xffffff, 0),
    amber: emissive(0xffa000, 0),
    green: emissive(0x20ff40, 0),
  };
  const mk = (mat: MeshStandardNodeMaterial, y: number) => {
    for (const sx of [-0.22, 0.22]) {
      const b = new Mesh(new CylinderGeometry(0.11, 0.11, 0.06, 16), mat);
      b.rotation.x = Math.PI / 2;
      b.position.set(sx, y, 0.15);
      treeGroup.add(b);
    }
  };
  mk(bulbs.stage, 2.55);
  mk(bulbs.amber, 2.2);
  mk(bulbs.amber, 1.95);
  mk(bulbs.amber, 1.7);
  mk(bulbs.green, 1.35);
  const housing = new Mesh(new BoxGeometry(0.8, 1.6, 0.2), SHARED.black);
  housing.position.y = 1.95;
  treeGroup.add(housing);
  treeGroup.rotation.y = Math.PI;
  root.add(treeGroup);

  // Distance boards along the strip
  const signMat = emissive(0xffffff, 1.2);
  for (let d = 100; d < S.length; d += 100) {
    const s = new Mesh(new BoxGeometry(0.2, 1.2, 1.6), signMat);
    s.position.set(S.x + S.width / 2 + 2.5, 0.8, S.startZ - d);
    root.add(s);
  }

  const drawBoard = (lines: string[]) => {
    const x = board.canvas.getContext('2d')!;
    x.fillStyle = '#05070a';
    x.fillRect(0, 0, 1024, 512);
    x.strokeStyle = '#1e2633';
    x.lineWidth = 8;
    x.strokeRect(8, 8, 1008, 496);
    x.fillStyle = '#e8ecf2';
    x.textAlign = 'center';
    x.font = '500 54px "Helvetica Neue", Arial, sans-serif';
    x.fillText(lines[0] ?? '', 512, 110);
    x.font = '200 170px "Helvetica Neue", Arial, sans-serif';
    x.fillStyle = '#ffffff';
    x.fillText(lines[1] ?? '', 512, 300);
    x.font = '400 46px "Helvetica Neue", Arial, sans-serif';
    x.fillStyle = '#8f9bb0';
    x.fillText(lines[2] ?? '', 512, 420);
    board.tex.needsUpdate = true;
  };
  drawBoard(['ROADSTER · 0–60 MPH', '—', 'Event run: 0.81 s']);

  scene.add(root);
  return {
    root,
    setBoard: drawBoard,
    setTree(state) {
      bulbs.stage.emissiveIntensity = state === 'off' ? 0 : 6;
      bulbs.amber.emissiveIntensity = state === 'amber' ? 10 : 0;
      bulbs.green.emissiveIntensity = state === 'green' ? 12 : 0;
    },
    setPadsActive(active) {
      padMats.forEach((m, i) => (m.emissiveIntensity = active[i] ? 8 : 2));
    },
  };
}
