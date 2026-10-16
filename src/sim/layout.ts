import { Vector3 } from 'three';
import { PhysWorld, type ArchRamp } from './world';

// World layout of the demo site. Shared by the physics world and the
// renderer so that what you see is exactly what you collide with.
// Headings follow Vehicle.reset(): 0 faces -Z, -π/2 faces +X.

export interface LineupVehicle {
  kind: 'cybercab' | 'cybertruck' | 'semi' | 'modely' | 'model3';
  label: string;
  x: number;
  width: number;
  length: number;
  height: number;
}

const LINEUP_DEF: Omit<LineupVehicle, 'x'>[] = [
  { kind: 'cybercab', label: 'Cybercab', width: 1.95, length: 4.25, height: 1.45 },
  { kind: 'cybertruck', label: 'Cybertruck', width: 2.03, length: 5.68, height: 1.79 },
  { kind: 'semi', label: 'Tesla Semi', width: 2.6, length: 6.6, height: 4.05 },
  { kind: 'modely', label: 'Model Y', width: 1.92, length: 4.79, height: 1.62 },
  { kind: 'model3', label: 'Model 3', width: 1.85, length: 4.72, height: 1.44 },
];

function buildLineup(centerX: number, gap: number): LineupVehicle[] {
  const total = LINEUP_DEF.reduce((s, v) => s + v.width, 0) + gap * (LINEUP_DEF.length - 1);
  let x = centerX - total / 2;
  return LINEUP_DEF.map((v) => {
    const item = { ...v, x: x + v.width / 2 };
    x += v.width + gap;
    return item;
  });
}

export const LAYOUT = {
  arch: {
    origin: new Vector3(0, 0, 0),
    yaw: 0, // deck runs along +X
    radius: 9.5,
    width: 7,
    approachX: -140,
    exitX: -120,
  },
  lineup: {
    z: -120,
    centerX: 0,
    vehicles: buildLineup(0, 0.9),
    approachX: -170,
    takeoffX: -34,
    landingX: 14,
    stopX: 140,
  },
  strip: {
    x: 320,
    startZ: 250,
    length: 3200, // runs towards -Z
    width: 30,
  },
  stage: { x: 0, z: 150, width: 46, depth: 14, height: 1.4 },
  crowd: { z: 205, width: 260, depth: 40 },
  spawn: { x: -60, z: 95, heading: Math.PI * 0.75 },
  pads: [
    { x: -60, z: 70, radius: 4 },
    { x: 300, z: 270, radius: 4 },
    { x: -190, z: -120, radius: 4 },
  ],
  lightTowers: [
    [-60, 40],
    [60, 40],
    [-60, -60],
    [60, -60],
    [-80, -160],
    [80, -160],
    [-150, 120],
    [150, 120],
    [300, 180],
    [345, -300],
    [295, -900],
    [345, -1500],
    [295, -2100],
  ] as [number, number][],
} as const;

export interface BuiltWorld {
  world: PhysWorld;
  arch: ArchRamp;
}

export function buildWorld(): BuiltWorld {
  const world = new PhysWorld();
  const A = LAYOUT.arch;
  const arch = world.addArch(A.origin, A.yaw, A.radius, A.width);
  // Side trusses that carry the deck. They sit outside the deck so the car can
  // fall freely through the middle of the arch.
  const minA = Math.sin(arch.phiEnd) * A.radius - 0.6;
  const maxA = A.radius + 0.9;
  const cx = (minA + maxA) / 2;
  const hx = (maxA - minA) / 2;
  for (const s of [-1, 1]) {
    world.addBox(new Vector3(cx, A.radius + 0.6, s * (A.width / 2 + 0.75)), new Vector3(hx, A.radius + 0.6, 0.35));
  }
  // Lineup vehicles (length along Z, lined up across X)
  const L = LAYOUT.lineup;
  for (const v of L.vehicles) {
    world.addBox(new Vector3(v.x, v.height / 2, L.z), new Vector3(v.width / 2, v.height / 2, v.length / 2));
  }
  // Stage and crowd barrier
  const S = LAYOUT.stage;
  world.addBox(new Vector3(S.x, S.height / 2, S.z), new Vector3(S.width / 2, S.height / 2, S.depth / 2));
  const C = LAYOUT.crowd;
  world.addBox(new Vector3(0, 0.55, C.z - C.depth / 2 - 2), new Vector3(C.width / 2, 0.55, 0.3));
  world.addBox(new Vector3(0, 6, C.z), new Vector3(C.width / 2, 6, C.depth / 2));
  // Light towers
  for (const [x, z] of LAYOUT.lightTowers) world.addBox(new Vector3(x, 12, z), new Vector3(0.5, 12, 0.5));
  for (const p of LAYOUT.pads) world.pads.push({ ...p });
  return { world, arch };
}
