import {
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
} from 'three/webgpu';
import { CHASSIS, type TrimSpec } from '../sim/specs';
import type { Vehicle } from '../sim/vehicle';
import { SHARED, goldGlass, paint } from '../render/materials';
import { archLipPoints, loftBody, type Station } from './loft';
import { buildWheel, type WheelParts } from './wheel';

// Model coordinates: y from the ground, z forward negative, origin under the COM.

const ZF = -CHASSIS.wheelbase * (1 - CHASSIS.frontWeight);
const ZR = CHASSIS.wheelbase * CHASSIS.frontWeight;

// z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass
const ROADSTER_TABLE: number[][] = [
  [-2.21, 0.25, 0.3, 0.31, 0.42, 0.36, 0.4, 0.39, 0.25, 0],
  [-2.19, 0.2, 0.56, 0.3, 0.7, 0.4, 0.66, 0.43, 0.42, 0],
  [-2.12, 0.165, 0.72, 0.31, 0.86, 0.47, 0.8, 0.5, 0.5, 0],
  [-1.98, 0.15, 0.8, 0.34, 0.95, 0.59, 0.91, 0.575, 0.52, 0],
  [-1.78, 0.14, 0.82, 0.38, 0.985, 0.7, 0.945, 0.64, 0.5, 0],
  [ZF, 0.14, 0.83, 0.4, 0.995, 0.755, 0.95, 0.675, 0.5, 0],
  [-1.4, 0.135, 0.84, 0.4, 0.995, 0.765, 0.94, 0.705, 0.5, 0],
  [-1.15, 0.13, 0.85, 0.4, 0.985, 0.76, 0.92, 0.745, 0.52, 0],
  [-0.92, 0.13, 0.85, 0.4, 0.975, 0.75, 0.9, 0.79, 0.55, 0],
  [-0.7, 0.13, 0.85, 0.4, 0.97, 0.745, 0.89, 0.93, 0.56, 1],
  [-0.4, 0.13, 0.85, 0.4, 0.97, 0.745, 0.885, 1.06, 0.57, 1],
  [-0.05, 0.13, 0.85, 0.4, 0.975, 0.75, 0.89, 1.125, 0.57, 1],
  [0.3, 0.13, 0.86, 0.41, 0.985, 0.77, 0.9, 1.115, 0.55, 1],
  [0.65, 0.135, 0.87, 0.42, 0.998, 0.8, 0.93, 1.055, 0.5, 0.85],
  [0.95, 0.14, 0.88, 0.43, 1.005, 0.83, 0.95, 0.985, 0.46, 0.35],
  [ZR, 0.15, 0.88, 0.44, 1.01, 0.85, 0.965, 0.935, 0.5, 0],
  [1.5, 0.17, 0.87, 0.45, 1.005, 0.86, 0.955, 0.9, 0.58, 0],
  [1.8, 0.21, 0.84, 0.46, 0.98, 0.865, 0.93, 0.882, 0.62, 0],
  [2.05, 0.27, 0.79, 0.48, 0.94, 0.865, 0.89, 0.872, 0.64, 0],
  [2.21, 0.33, 0.72, 0.5, 0.88, 0.855, 0.84, 0.862, 0.62, 0],
];

export function tableToStations(t: number[][]): Station[] {
  return t.map(([z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass]) => ({ z, yb, wb, yh, wh, ybelt, wbelt, yroof, wroof, glass }));
}

export interface Nozzle {
  pos: Vector3; // car-local (COM origin)
  dir: Vector3; // exhaust direction, car-local
  kind: 'rear' | 'lift' | 'side';
  size: number;
  /** Which side/end the nozzle is at, for attitude-control visuals. */
  sx: number;
  sz: number;
}

function nozzleMesh(exitR: number, len: number, mat: Material) {
  const pts = [
    new Vector2(exitR * 0.35, 0),
    new Vector2(exitR * 0.42, len * 0.3),
    new Vector2(exitR * 0.75, len * 0.7),
    new Vector2(exitR, len),
    new Vector2(exitR * 1.12, len),
    new Vector2(exitR * 0.85, len * 0.6),
    new Vector2(exitR * 0.55, 0),
  ];
  return new Mesh(new LatheGeometry(pts, 24), mat);
}

export class RoadsterModel {
  readonly root = new Group();
  readonly body = new Group();
  readonly wheels: WheelParts[] = [];
  readonly paintMat = paint(0xe8e8e3, { roughness: 0.28 });
  readonly glassMat = goldGlass();
  readonly tailMat: MeshStandardNodeMaterial;
  readonly headMat: MeshStandardNodeMaterial;
  readonly nozzleGroup = new Group();
  readonly liftGroup = new Group();
  nozzles: Nozzle[] = [];
  private wingPivot = new Group();
  private wingLift = new Group();
  private fans: Group[] = [];
  private fanAngle = 0;
  private driver = new Group();
  private readonly stations = tableToStations(ROADSTER_TABLE);

  constructor() {
    const comY = -CHASSIS.comHeight;
    this.root.add(this.body);
    this.body.position.y = comY;

    const arches = [
      { z: ZF, y: CHASSIS.wheelRadiusFront, r: 0.41, inner: 0.66 },
      { z: ZR, y: CHASSIS.wheelRadiusRear, r: 0.425, inner: 0.66 },
    ];
    const geo = loftBody(this.stations, { rows: 150, segSamples: 7, arches });
    // carbon arch liners give the wheel openings a clean edge
    for (const a of arches) {
      for (const side of [-1, 1]) {
        const pts = archLipPoints(this.stations, a, side, 0.16);
        if (pts.length < 4) continue;
        const lip = new Mesh(new TubeGeometry(new CatmullRomCurve3(pts), 64, 0.022, 6), SHARED.carbon);
        lip.castShadow = true;
        this.body.add(lip);
      }
    }
    const shell = new Mesh(geo, [this.paintMat, SHARED.trim, this.glassMat]);
    shell.castShadow = true;
    shell.receiveShadow = true;
    this.body.add(shell);

    // Interior tub, seats, yoke (seen through the tinted canopy)
    const tub = new Mesh(new BoxGeometry(1.5, 0.45, 2.0), SHARED.interior);
    tub.position.set(0, 0.5, -0.15);
    this.body.add(tub);
    for (const sx of [-0.33, 0.33]) {
      const seat = new Mesh(new CapsuleGeometry(0.17, 0.28, 4, 10), SHARED.interior);
      seat.position.set(sx, 0.62, 0.32);
      seat.rotation.x = -0.35;
      this.body.add(seat);
    }
    const yoke = new Mesh(new TorusGeometry(0.15, 0.022, 8, 24, Math.PI), SHARED.trim);
    yoke.position.set(-0.33, 0.82, -0.32);
    yoke.rotation.set(-1.0, 0, Math.PI);
    this.body.add(yoke);
    this.buildDriver();

    // Hidden headlights: a single thin LED line across the nose
    this.headMat = new MeshStandardNodeMaterial({ color: new Color(0x000000) });
    this.headMat.emissive = new Color(0xe8f2ff);
    this.headMat.emissiveIntensity = 6;
    const headCurve = new CatmullRomCurve3([
      new Vector3(-0.8, 0.47, -2.07),
      new Vector3(-0.45, 0.445, -2.17),
      new Vector3(0, 0.432, -2.205),
      new Vector3(0.45, 0.445, -2.17),
      new Vector3(0.8, 0.47, -2.07),
    ]);
    this.body.add(new Mesh(new TubeGeometry(headCurve, 40, 0.009, 6), this.headMat));

    // Full-width taillight
    this.tailMat = new MeshStandardNodeMaterial({ color: new Color(0x100000) });
    this.tailMat.emissive = new Color(0xff1a10);
    this.tailMat.emissiveIntensity = 3;
    const tailCurve = new CatmullRomCurve3([
      new Vector3(-0.93, 0.8, 1.98),
      new Vector3(-0.8, 0.805, 2.15),
      new Vector3(0, 0.81, 2.222),
      new Vector3(0.8, 0.805, 2.15),
      new Vector3(0.93, 0.8, 1.98),
    ]);
    this.body.add(new Mesh(new TubeGeometry(tailCurve, 48, 0.016, 8), this.tailMat));

    // Rear fascia: diffuser fins and the two suction fans
    for (const fx of [-0.6, -0.2, 0.2, 0.6]) {
      const fin = new Mesh(new BoxGeometry(0.012, 0.16, 0.5), SHARED.carbon);
      fin.position.set(fx, 0.26, 1.98);
      this.body.add(fin);
    }
    for (const fx of [-0.42, 0.42]) {
      const ring = new Mesh(new TorusGeometry(0.15, 0.018, 8, 32), SHARED.graphite);
      ring.position.set(fx, 0.47, 2.215);
      this.body.add(ring);
      const fan = new Group();
      fan.position.set(fx, 0.47, 2.2);
      const hub = new Mesh(new CylinderGeometry(0.04, 0.04, 0.03, 16), SHARED.graphite);
      hub.rotation.x = Math.PI / 2;
      fan.add(hub);
      for (let i = 0; i < 7; i++) {
        const blade = new Mesh(new BoxGeometry(0.035, 0.11, 0.008), SHARED.darkSteel);
        blade.geometry.translate(0, 0.075, 0);
        blade.rotation.z = (i / 7) * Math.PI * 2;
        blade.rotation.y = 0.5;
        fan.add(blade);
      }
      const back = new Mesh(new CylinderGeometry(0.15, 0.15, 0.01, 24), SHARED.black);
      back.rotation.x = Math.PI / 2;
      back.position.z = -0.03;
      fan.add(back);
      this.fans.push(fan);
      this.body.add(fan);
    }

    // Active wing
    this.buildWing();

    // Thruster nozzles
    this.body.add(this.nozzleGroup);
    this.body.add(this.liftGroup);

    // Wheels
    const sides = [-1, 1, -1, 1];
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const w = buildWheel({
        radius: front ? CHASSIS.wheelRadiusFront : CHASSIS.wheelRadiusRear,
        width: front ? 0.27 : 0.31,
        rimRadius: front ? 0.262 : 0.272,
        side: sides[i],
        spokes: 10,
        detail: 'high',
      });
      this.root.add(w.root);
      this.wheels.push(w);
    }
  }

  private buildWing() {
    const shape = new Shape();
    // simple cambered airfoil, chord 0.3 (x), thickness ~0.035 (y)
    const c = 0.3;
    // inverted camber: the wing makes downforce
    shape.moveTo(0, 0);
    shape.bezierCurveTo(0.03, -0.03, 0.18, -0.035, c, -0.01);
    shape.lineTo(c, 0.0);
    shape.bezierCurveTo(0.18, -0.008, 0.04, 0.012, 0, 0);
    const geo = new ExtrudeGeometry(shape, { depth: 1.72, bevelEnabled: false, curveSegments: 10 });
    geo.translate(-c * 0.4, 0, -0.86);
    geo.rotateY(-Math.PI / 2); // chord along +z (rear), span along x
    const wing = new Mesh(geo, this.paintMat);
    wing.castShadow = true;
    this.wingPivot.add(wing);
    // end plates
    for (const sx of [-0.87, 0.87]) {
      const plate = new Mesh(new BoxGeometry(0.01, 0.07, 0.32), SHARED.carbon);
      plate.position.set(sx, -0.012, 0.03);
      this.wingPivot.add(plate);
    }
    this.wingLift.add(this.wingPivot);
    for (const sx of [-0.42, 0.42]) {
      const pylon = new Mesh(new BoxGeometry(0.02, 0.2, 0.1), SHARED.carbon);
      pylon.position.set(sx, -0.1, 0.02);
      this.wingLift.add(pylon);
    }
    this.wingLift.position.set(0, 0.872, 1.93);
    this.body.add(this.wingLift);
  }

  private buildDriver() {
    // Optimus at the wheel (shown when the autopilot drives)
    const white = SHARED.chrome;
    const head = new Mesh(new SphereGeometry(0.105, 20, 14), white);
    head.scale.set(0.9, 1.05, 1);
    head.position.set(-0.33, 0.93, 0.2);
    const visor = new Mesh(new SphereGeometry(0.095, 20, 10, 0, Math.PI * 2, Math.PI * 0.35, Math.PI * 0.3), SHARED.black);
    visor.position.copy(head.position).add(new Vector3(0, 0, -0.018));
    const torso = new Mesh(new CapsuleGeometry(0.17, 0.25, 4, 10), SHARED.black);
    torso.position.set(-0.33, 0.66, 0.27);
    torso.rotation.x = -0.3;
    this.driver.add(head, visor, torso);
    this.driver.visible = false;
    this.body.add(this.driver);
  }

  set showDriver(v: boolean) {
    this.driver.visible = v;
  }

  setTrim(spec: TrimSpec) {
    this.nozzleGroup.clear();
    this.liftGroup.clear();
    this.nozzles = [];
    const comY = CHASSIS.comHeight;
    const add = (kind: Nozzle['kind'], p: Vector3, d: Vector3, size: number, parent: Group) => {
      const m = nozzleMesh(size, size * 2.2, SHARED.steel);
      // lathe axis is +Y; orient exhaust direction d
      m.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), d.clone().normalize());
      m.position.copy(p).addScaledVector(d, -size * 2.2);
      parent.add(m);
      this.nozzles.push({ pos: new Vector3(p.x, p.y - comY, p.z), dir: d.clone().normalize(), kind, size, sx: Math.sign(p.x), sz: Math.sign(p.z) });
    };
    const t = spec.thrusters;
    if (!t) return;
    for (const x of [-0.68, -0.16, 0.16, 0.68]) add('rear', new Vector3(x, 0.63, 2.235), new Vector3(0, 0, 1), 0.05, this.nozzleGroup);
    if (t.liftN > 0) {
      for (const [x, z] of [
        [-0.74, -1.05],
        [0.74, -1.05],
        [-0.74, 0.55],
        [0.74, 0.55],
      ]) {
        add('lift', new Vector3(x, 0.135, z), new Vector3(0, -1, 0), 0.055, this.liftGroup);
      }
      add('side', new Vector3(-0.93, 0.42, -1.95), new Vector3(-1, 0, 0), 0.035, this.liftGroup);
      add('side', new Vector3(0.93, 0.42, -1.95), new Vector3(1, 0, 0), 0.035, this.liftGroup);
    }
  }

  /** Sync the visual with the simulation state. */
  update(v: Vehicle, dt: number) {
    this.root.position.copy(v.pos);
    this.root.quaternion.copy(v.quat);
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      const p = this.wheels[i];
      p.root.position.set(w.mount.x, w.mount.y - w.s, w.mount.z);
      p.root.rotation.y = -w.steer;
      p.spin.rotation.x = -w.angle;
      if (p.discMat) p.discMat.emissiveIntensity = Math.min(4, Math.max(0, w.brakeHeat - 0.4) * 3);
    }
    // wing: rise then pitch (trailing edge up for downforce, ~60° as an airbrake)
    this.wingLift.position.y = 0.872 + 0.19 * v.wingHeight;
    const aoa = v.airbrake > 0.1 ? 0.25 + v.airbrake * 0.8 : 0.05 + v.wing * 0.3;
    this.wingPivot.rotation.x = -aoa * v.wingHeight;
    // fans
    this.fanAngle += dt * (6 + v.fanRpm * 90);
    for (const f of this.fans) f.rotation.z = this.fanAngle;
    // lights
    this.tailMat.emissiveIntensity = v.reverse ? 3 : 2.5 + 9 * Math.min(1, v.wheels[0].brakeTorque / 2500);
  }

  /** Same as update() but from recorded replay data. */
  applyPose(pos: Vector3, quat: { x: number; y: number; z: number; w: number }) {
    this.root.position.copy(pos);
    this.root.quaternion.set(quat.x, quat.y, quat.z, quat.w);
  }
}
