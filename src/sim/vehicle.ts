import { Quaternion, Vector3 } from 'three';
import { CHASSIS, G, type TrimSpec } from './specs';
import { makeHit, type PhysWorld, type SurfaceHit } from './world';

// Car-local axes: +X right, +Y up, -Z forward. Origin at the centre of mass.

export interface Controls {
  throttle: number; // 0..1
  brake: number; // 0..1 (also reverse when stopped)
  steer: number; // -1..1, + = right
  handbrake: boolean;
  boost: number; // rear thrusters 0..1
  lift: number; // lift thrusters 0..1
  pitch: number; // airborne attitude, + = nose up
  yaw: number; // + = right
  roll: number; // + = roll right
  suctionRelease: boolean; // momentarily cut the fans
  launch: boolean; // launch control armed (brake + throttle at rest)
}

export function makeControls(): Controls {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    boost: 0,
    lift: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    suctionRelease: false,
    launch: false,
  };
}

export type SuctionMode = 'auto' | 'off' | 'road' | 'track' | 'max';
export const SUCTION_MODES: SuctionMode[] = ['auto', 'off', 'road', 'track', 'max'];
const SUCTION_LEVEL: Record<Exclude<SuctionMode, 'auto'>, number> = { off: 0, road: 0.35, track: 1.0, max: 2.0 };

export interface Assists {
  traction: boolean;
  stability: boolean;
  flight: boolean;
}

const KAPPA_PEAK = 0.11;
const ALPHA_PEAK = 0.13;

/** Normalised combined-slip tire curve: rises to 1 at σ=1, falls to ~0.82 when sliding. */
function slipCurve(s: number): number {
  if (s < 1) return s * (2 - s);
  return 1 - 0.18 * Math.min(1, (s - 1) / 2.5);
}

function tireFx(kappa: number, alpha: number, muFz: number): number {
  const sx = kappa / KAPPA_PEAK;
  const sy = alpha / ALPHA_PEAK;
  const s = Math.hypot(sx, sy);
  if (s < 1e-7) return 0;
  return (muFz * slipCurve(s) * sx) / s;
}

function tireFy(kappa: number, alpha: number, muFz: number): number {
  const sx = kappa / KAPPA_PEAK;
  const sy = alpha / ALPHA_PEAK;
  const s = Math.hypot(sx, sy);
  if (s < 1e-7) return 0;
  return (-muFz * slipCurve(s) * sy) / s;
}

export class Wheel {
  readonly mount = new Vector3();
  readonly radius: number;
  readonly front: boolean;
  readonly left: boolean;
  readonly restLength = 0.26;
  readonly bumpTravel = 0.09;
  readonly inertia: number;
  k: number;
  c: number;
  baseMountY = 0;

  s = 0.26;
  sPrev = 0.26;
  contact = false;
  readonly normal = new Vector3(0, 1, 0);
  readonly point = new Vector3();
  grip = 1;
  surfaceId = -1;

  omega = 0;
  angle = 0;
  steer = 0;
  Fz = 0;
  Fx = 0;
  Fy = 0;
  kappa = 0;
  alpha = 0;
  vx = 0;
  vy = 0;
  driveTorque = 0;
  brakeTorque = 0;
  slipEnergy = 0; // for smoke/skid/audio
  brakeHeat = 0;

  // scratch per step
  readonly fwdW = new Vector3();
  readonly sideW = new Vector3();

  constructor(x: number, z: number, radius: number, front: boolean, staticLoad: number) {
    this.radius = radius;
    this.front = front;
    this.left = x < 0;
    this.inertia = front ? 1.5 : 3.6; // rear includes motor rotor reflected through the reduction gear
    this.k = front ? 80000 : 98000;
    this.c = front ? 5200 : 6200;
    const staticComp = staticLoad / this.k;
    const centerY = radius - CHASSIS.comHeight;
    this.baseMountY = centerY + this.restLength - staticComp;
    this.mount.set(x, this.baseMountY, z);
    this.s = this.restLength - staticComp;
    this.sPrev = this.s;
  }
}

/** Points on the body shell that collide with the world. */
const BODY_POINTS: [number, number, number][] = [
  // floor
  [-0.82, -0.25, -0.65],
  [0.82, -0.25, -0.65],
  [-0.82, -0.25, 0.55],
  [0.82, -0.25, 0.55],
  [0, -0.27, 0],
  // nose & tail lower
  [-0.75, -0.23, -2.12],
  [0.75, -0.23, -2.12],
  [0, -0.22, -2.2],
  [-0.85, -0.11, 2.18],
  [0.85, -0.11, 2.18],
  // shoulders
  [-0.99, 0.2, -1.5],
  [0.99, 0.2, -1.5],
  [-0.99, 0.25, 1.4],
  [0.99, 0.25, 1.4],
  [-0.98, 0.2, 0],
  [0.98, 0.2, 0],
  // roof / canopy
  [-0.5, 0.72, -0.2],
  [0.5, 0.72, -0.2],
  [0, 0.73, 0.5],
  [-0.6, 0.48, 1.6],
  [0.6, 0.48, 1.6],
  [0, 0.3, -1.6],
];

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _d = new Vector3();
const _e = new Vector3();
const _n = new Vector3();
const _q = new Quaternion();
const _rcs = new Vector3();
const _pl = new Vector3();
const _imp = new Vector3();
const _hit: SurfaceHit = makeHit();
const _best: SurfaceHit = makeHit();

export interface ImpactEvent {
  impulse: number;
  point: Vector3;
  normal: Vector3;
  scrape: number;
}

export class Vehicle {
  spec: TrimSpec;
  mass: number;
  readonly inertia = new Vector3(); // body-frame principal moments (pitch, yaw, roll)
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly quat = new Quaternion();
  readonly angVel = new Vector3();

  readonly right = new Vector3(1, 0, 0);
  readonly up = new Vector3(0, 1, 0);
  readonly fwd = new Vector3(0, 0, -1);

  readonly wheels: Wheel[];

  // systems
  suctionMode: SuctionMode = 'auto';
  suctionLevel = 0; // current G
  suctionTarget = 0;
  suctionSeal = 0;
  floorGap = Infinity;
  trackMode = false;
  rideOffset = 0;
  wing = 0; // 0 stowed .. 1 max angle
  wingHeight = 0; // 0 stowed .. 1 raised
  airbrake = 0;
  assists: Assists = { traction: true, stability: true, flight: true };
  impulseLeft = 0;
  readonly thrustOut = { rear: 0, lift: 0, rcs: new Vector3() };
  batteryKWh = 0;
  energyUsedKWh = 0;
  reverse = false;
  private reverseTimer = 0;
  launchArmed = false;

  // telemetry
  fwdSpeed = 0;
  speed = 0;
  gLong = 0;
  gLat = 0;
  gVert = 0;
  powerKW = 0;
  contactCount = 0;
  airborneTime = 0;
  groundedTime = 0;
  rollAccum = 0; // radians rolled while airborne (signed)
  pitchAccum = 0;
  distance = 0;
  time = 0;
  readonly impacts: ImpactEvent[] = [];
  maxImpactThisStep = 0;
  readonly lastVel = new Vector3();
  fanRpm = 0;
  steerAngle = 0;

  private readonly force = new Vector3();
  private readonly torque = new Vector3();
  private readonly invIw: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  constructor(spec: TrimSpec) {
    this.spec = spec;
    this.mass = spec.massKg;
    this.setSpec(spec);
    const m = this.mass;

    const wb = CHASSIS.wheelbase;
    const zf = -wb * (1 - CHASSIS.frontWeight);
    const zr = wb * CHASSIS.frontWeight;
    const loadF = (m * G * CHASSIS.frontWeight) / 2;
    const loadR = (m * G * (1 - CHASSIS.frontWeight)) / 2;
    this.wheels = [
      new Wheel(-CHASSIS.trackFront / 2, zf, CHASSIS.wheelRadiusFront, true, loadF),
      new Wheel(CHASSIS.trackFront / 2, zf, CHASSIS.wheelRadiusFront, true, loadF),
      new Wheel(-CHASSIS.trackRear / 2, zr, CHASSIS.wheelRadiusRear, false, loadR),
      new Wheel(CHASSIS.trackRear / 2, zr, CHASSIS.wheelRadiusRear, false, loadR),
    ];
    this.refill();
  }

  /** Switch trim: mass and inertia follow the spec. */
  setSpec(spec: TrimSpec) {
    this.spec = spec;
    this.mass = spec.massKg;
    const m = this.mass;
    const L = CHASSIS.length;
    const W = CHASSIS.width;
    const H = CHASSIS.height;
    // Mass is concentrated low and central (floor battery, mid motors).
    this.inertia.set((m / 12) * (H * H + L * L) * 0.72, (m / 12) * (W * W + L * L) * 0.76, (m / 12) * (W * W + H * H) * 0.8);
    this.refill();
  }

  get hasThrusters() {
    return this.spec.thrusters !== null;
  }
  get canFly() {
    return (this.spec.thrusters?.liftN ?? 0) > 0;
  }
  get tankFraction() {
    const t = this.spec.thrusters;
    return t ? this.impulseLeft / t.impulseNs : 0;
  }

  refill() {
    this.impulseLeft = this.spec.thrusters?.impulseNs ?? 0;
    this.batteryKWh = this.spec.batteryKWh;
  }

  /** Place the car at rest on flat ground. Heading is the yaw in radians (0 = facing -Z). */
  reset(x: number, z: number, heading: number, y = 0) {
    this.pos.set(x, y + CHASSIS.comHeight, z);
    this.quat.setFromAxisAngle(_a.set(0, 1, 0), heading);
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.lastVel.set(0, 0, 0);
    for (const w of this.wheels) {
      w.omega = 0;
      w.s = w.sPrev = w.baseMountY - (w.radius - CHASSIS.comHeight);
      w.contact = false;
      w.brakeHeat = 0;
    }
    this.suctionLevel = 0;
    this.airborneTime = 0;
    this.groundedTime = 0;
    this.rollAccum = 0;
    this.pitchAccum = 0;
    this.reverse = false;
    this.distance = 0;
    this.time = 0;
    this.impacts.length = 0;
    this.updateBasis();
  }

  updateBasis() {
    this.right.set(1, 0, 0).applyQuaternion(this.quat);
    this.up.set(0, 1, 0).applyQuaternion(this.quat);
    this.fwd.set(0, 0, -1).applyQuaternion(this.quat);
  }

  toWorld(local: Vector3, out: Vector3): Vector3 {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }

  private computeInvInertiaWorld() {
    // I⁻¹_world = R · diag(1/I) · Rᵀ
    const r = this.right;
    const u = this.up;
    const b = _e.copy(this.fwd).negate(); // local +Z
    const ix = 1 / this.inertia.x;
    const iy = 1 / this.inertia.y;
    const iz = 1 / this.inertia.z;
    const m = this.invIw;
    const cols = [r, u, b];
    const inv = [ix, iy, iz];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) {
          const ck = cols[k];
          const ci = i === 0 ? ck.x : i === 1 ? ck.y : ck.z;
          const cj = j === 0 ? ck.x : j === 1 ? ck.y : ck.z;
          s += ci * inv[k] * cj;
        }
        m[i * 3 + j] = s;
      }
    }
  }

  private applyInvInertia(v: Vector3, out: Vector3): Vector3 {
    const m = this.invIw;
    return out.set(
      m[0] * v.x + m[1] * v.y + m[2] * v.z,
      m[3] * v.x + m[4] * v.y + m[5] * v.z,
      m[6] * v.x + m[7] * v.y + m[8] * v.z,
    );
  }

  private addForceAt(f: Vector3, p: Vector3) {
    this.force.add(f);
    _d.subVectors(p, this.pos).cross(f);
    this.torque.add(_d);
  }

  private pointVelocity(p: Vector3, out: Vector3): Vector3 {
    _d.subVectors(p, this.pos);
    return out.crossVectors(this.angVel, _d).add(this.vel);
  }

  step(dt: number, world: PhysWorld, c: Controls) {
    const spec = this.spec;
    const m = this.mass;
    this.updateBasis();
    this.computeInvInertiaWorld();
    this.force.set(0, -G * m, 0);
    this.torque.set(0, 0, 0);
    this.maxImpactThisStep = 0;

    const fwdSpeed = this.vel.dot(this.fwd);
    const speed = this.vel.length();

    // ---- Track mode ride height & wing --------------------------------------
    const targetRide = this.trackMode ? -0.035 : 0;
    this.rideOffset += (targetRide - this.rideOffset) * Math.min(1, dt * 2);

    // ---- Suspension / contact ----------------------------------------------
    let contactCount = 0;
    let totalFz = 0;
    const avgN = _n.set(0, 0, 0);
    for (const w of this.wheels) {
      w.mount.y = w.baseMountY + this.rideOffset;
      const mountW = this.toWorld(w.mount, _a);
      const hub = _b.copy(mountW).addScaledVector(this.up, -w.s);
      let bestS = Infinity;
      let found = false;
      for (const s of world.surfaces) {
        if (!s.query(hub, _hit)) continue;
        const un = this.up.dot(_hit.normal);
        if (un < 0.3) continue;
        const sCand = w.s + (_hit.dist - w.radius) / un;
        if (sCand > w.restLength || sCand < -0.35) continue;
        if (sCand < bestS) {
          bestS = sCand;
          found = true;
          _best.dist = _hit.dist;
          _best.normal.copy(_hit.normal);
          _best.grip = _hit.grip;
          _best.id = _hit.id;
        }
      }
      w.sPrev = w.s;
      if (found) {
        w.contact = true;
        w.s = Math.max(0.02, bestS);
        w.normal.copy(_best.normal);
        w.grip = _best.grip;
        w.surfaceId = _best.id;
        const comp = w.restLength - bestS;
        const compVel = (w.sPrev - bestS) / dt;
        const stiff = this.trackMode ? 1.35 : 1;
        let fs = w.k * stiff * comp + w.c * stiff * compVel;
        if (comp > w.bumpTravel) fs += 650000 * (comp - w.bumpTravel);
        w.Fz = Math.max(0, fs);
        w.point.copy(mountW).addScaledVector(this.up, -w.s).addScaledVector(w.normal, -w.radius);
        contactCount++;
        totalFz += w.Fz;
        avgN.add(w.normal);
      } else {
        w.contact = false;
        w.s = Math.min(w.restLength, w.s + dt * 3);
        w.Fz = 0;
      }
    }
    this.contactCount = contactCount;
    if (contactCount > 0) {
      this.airborneTime = 0;
      this.groundedTime += dt;
      avgN.normalize();
    } else {
      this.airborneTime += dt;
      this.groundedTime = 0;
    }
    const grounded = contactCount > 0;
    const airborne = this.airborneTime > 0.12;

    // ---- Suction fan ---------------------------------------------------------
    const upDotWorld = this.up.y;
    let target = 0;
    if (this.suctionMode === 'auto') {
      target = 0.35;
      if (this.trackMode) target = 1.0;
      if (Math.abs(this.gLat) > 0.8) target = Math.max(target, Math.min(1.0, Math.abs(this.gLat) - 0.5));
      if (upDotWorld < 0.75) target = 2.0; // on a wall or upside down
      if (this.launchArmed || (c.throttle > 0.9 && Math.abs(fwdSpeed) < 30)) target = Math.max(target, 1.2);
      if (c.brake > 0.6 && fwdSpeed > 10) target = Math.max(target, 1.6);
    } else {
      target = SUCTION_LEVEL[this.suctionMode];
    }
    target = Math.min(target, spec.suctionMaxG);
    if (c.suctionRelease) target = 0;
    this.suctionTarget = target;
    const spool = target > this.suctionLevel ? 5 : 9;
    this.suctionLevel += Math.sign(target - this.suctionLevel) * Math.min(Math.abs(target - this.suctionLevel), spool * dt);
    this.fanRpm = this.suctionLevel / 2;
    // The fans only pull when the floor is sealed close to a surface.
    this.floorGap = Infinity;
    if (this.suctionLevel > 0 || this.suctionTarget > 0) {
      _d.set(0, -0.26, 0.1);
      const floor = this.toWorld(_d, _e);
      for (const s of world.surfaces) {
        if (!s.query(floor, _hit)) continue;
        if (this.up.dot(_hit.normal) < 0.6) continue;
        const gap = _hit.dist / this.up.dot(_hit.normal);
        if (gap > -0.2 && gap < this.floorGap) {
          this.floorGap = gap;
          _best.normal.copy(_hit.normal);
        }
      }
      const seal = Math.max(0, Math.min(1, (0.65 - this.floorGap) / 0.3));
      if (seal > 0 && this.suctionLevel > 0) {
        const f = this.suctionLevel * m * G * seal;
        _c.copy(_best.normal).multiplyScalar(-f);
        this.addForceAt(_c, floor);
      }
      this.suctionSeal = seal;
    }

    // ---- Aero -----------------------------------------------------------------
    const rho = 1.225;
    const vf = Math.max(0, fwdSpeed);
    const braking = c.brake > 0.5 && fwdSpeed > 25;
    this.airbrake += ((braking ? 1 : 0) - this.airbrake) * Math.min(1, dt * 6);
    // The wing adjusts on its own: raised in Track Mode, at speed, under braking.
    const wingUp = this.trackMode || vf > 35 || this.airbrake > 0.1 ? 1 : 0;
    this.wingHeight += (wingUp - this.wingHeight) * Math.min(1, dt * 3);
    let wingTarget = this.trackMode ? 0.75 : 0.25;
    if (this.trackMode && vf > 60 && Math.abs(this.gLat) < 0.3 && c.brake < 0.1) wingTarget = 0.25; // DRS-style trim on straights
    if (this.airbrake > 0.1) wingTarget = 1;
    this.wing += (wingTarget * this.wingHeight - this.wing) * Math.min(1, dt * 5);
    const cdA = CHASSIS.cdA + CHASSIS.wingDragTrack * this.wing * this.wingHeight + CHASSIS.airbrakeCdA * this.airbrake;
    const dragK = 0.5 * rho * cdA * speed;
    this.force.addScaledVector(this.vel, -dragK);
    const clA = CHASSIS.clARoad + (CHASSIS.clATrack - CHASSIS.clARoad) * this.wing * this.wingHeight * (this.trackMode ? 1 : 0.55);
    const down = 0.5 * rho * clA * vf * vf;
    if (down > 0) {
      const frontShare = 0.42;
      _c.copy(this.up).multiplyScalar(-down * frontShare);
      _d.set(0, 0, this.wheels[0].mount.z);
      this.addForceAt(_c, this.toWorld(_d, _e));
      _c.copy(this.up).multiplyScalar(-down * (1 - frontShare));
      _d.set(0, 0, this.wheels[2].mount.z);
      this.addForceAt(_c, this.toWorld(_d, _e));
    }

    // ---- Steering ---------------------------------------------------------
    const maxSteer = 0.6 / (1 + (Math.abs(fwdSpeed) / 19) ** 2);
    const delta = c.steer * maxSteer;
    this.steerAngle = delta;
    const wb = CHASSIS.wheelbase;
    if (Math.abs(delta) > 1e-4) {
      const R = wb / Math.tan(Math.abs(delta));
      const inner = Math.atan(wb / (R - CHASSIS.trackFront / 2));
      const outer = Math.atan(wb / (R + CHASSIS.trackFront / 2));
      const sgn = Math.sign(delta);
      // turning right (+): right wheel is inner
      this.wheels[0].steer = sgn * (sgn > 0 ? outer : inner);
      this.wheels[1].steer = sgn * (sgn > 0 ? inner : outer);
    } else {
      this.wheels[0].steer = this.wheels[1].steer = 0;
    }
    this.wheels[2].steer = this.wheels[3].steer = 0;

    // ---- Tire kinematics --------------------------------------------------------
    for (const w of this.wheels) {
      const sd = Math.sin(w.steer);
      const cd = Math.cos(w.steer);
      w.fwdW.copy(this.fwd).multiplyScalar(cd).addScaledVector(this.right, sd);
      if (w.contact) {
        w.fwdW.addScaledVector(w.normal, -w.fwdW.dot(w.normal)).normalize();
        w.sideW.crossVectors(w.fwdW, w.normal);
        const vp = this.pointVelocity(w.point, _c);
        w.vx = vp.dot(w.fwdW);
        w.vy = vp.dot(w.sideW);
        const vden = Math.max(Math.abs(w.vx), 1.0);
        w.kappa = (w.omega * w.radius - w.vx) / vden;
        w.alpha = Math.atan2(w.vy, Math.max(Math.abs(w.vx), 1.5));
      } else {
        w.vx = w.vy = w.kappa = w.alpha = 0;
      }
    }

    // ---- Powertrain: two rear motors, torque vectoring, traction control ----------
    const rl = this.wheels[2];
    const rr = this.wheels[3];
    const pPerMotor = (spec.powerKW * 1000) / 2;
    const motorTorque = (w: Wheel) => {
      const om = Math.abs(w.omega);
      return Math.min(spec.wheelTorqueNm, pPerMotor / Math.max(om, 1));
    };

    // Gear selection (arcade style): brake at standstill engages reverse.
    if (!this.reverse && fwdSpeed < 0.5 && c.brake > 0.2 && c.throttle < 0.05 && !c.launch && !c.handbrake) {
      this.reverseTimer += dt;
      if (this.reverseTimer > 0.35) this.reverse = true;
    } else {
      this.reverseTimer = 0;
    }
    if (this.reverse && (c.throttle > 0.1 || c.launch)) this.reverse = fwdSpeed < -0.5 ? this.reverse : false;

    let drive = 0;
    let brakeIn = c.brake;
    if (this.reverse) {
      drive = -c.brake * 0.35 * (fwdSpeed > -12 ? 1 : 0);
      brakeIn = c.throttle;
    } else {
      drive = c.throttle;
    }
    this.launchArmed = c.launch && Math.abs(fwdSpeed) < 0.3;
    if (this.launchArmed) {
      drive = 0;
      brakeIn = 1;
    }
    const limiter = Math.min(1, Math.max(0, (spec.topSpeedLimit - fwdSpeed) / 1.2));
    let motorPower = 0;
    for (const w of [rl, rr]) {
      let t = drive * motorTorque(w) * (drive > 0 ? limiter : 1);
      // one-pedal regen when off throttle
      if (drive === 0 && w.omega > 0.5 && !this.launchArmed) {
        const regen = Math.min(0.2 * m * G * w.radius * 0.5, 160000 / Math.max(w.omega, 1)) * Math.min(1, w.omega * w.radius / 3);
        t = -regen * (1 + brakeIn);
      }
      w.driveTorque = t;
    }
    // Torque vectoring: bias rear torque to track the steer-implied yaw rate.
    const yawRate = this.angVel.dot(this.up);
    const vfa = Math.max(Math.abs(fwdSpeed), 0.1);
    let yawTarget = (-fwdSpeed * Math.tan(delta)) / wb;
    const yawMax = ((CHASSIS.tireMu + this.suctionLevel * 0.6) * G) / vfa;
    yawTarget = Math.max(-yawMax, Math.min(yawMax, yawTarget));
    if (grounded && fwdSpeed > 2 && drive > 0) {
      const tv = Math.max(-0.35, Math.min(0.35, (yawTarget - yawRate) * 0.8));
      const base = (rl.driveTorque + rr.driveTorque) / 2;
      rr.driveTorque = base * (1 + tv);
      rl.driveTorque = base * (1 - tv);
    }
    // Stability control: trim drive torque if the rear steps out.
    if (this.assists.stability && grounded && fwdSpeed > 5) {
      const over = Math.abs(yawRate) - Math.abs(yawTarget) - 0.15;
      if (over > 0 && Math.sign(yawRate) === Math.sign(yawTarget || yawRate)) {
        const cut = Math.max(0.15, 1 - over * 2.5);
        if (rl.driveTorque > 0) rl.driveTorque *= cut;
        if (rr.driveTorque > 0) rr.driveTorque *= cut;
      }
    }
    // Traction control: cap torque at what the tire can carry at target slip.
    const axEst = this.gLong * G;
    for (const w of [rl, rr]) {
      if (!this.assists.traction || !w.contact || w.driveTorque <= 0) continue;
      const kt = 0.095;
      const muFz = CHASSIS.tireMu * w.grip * w.Fz;
      const cap = w.radius * tireFx(kt, w.alpha, muFz) + (w.inertia * Math.max(0, axEst)) / w.radius;
      let t = Math.min(w.driveTorque, Math.max(0, cap));
      if (w.kappa > kt * 1.6) t *= 0.6;
      w.driveTorque = t;
    }
    for (const w of [rl, rr]) motorPower += w.driveTorque * w.omega;

    // ---- Brakes ------------------------------------------------------------
    const brakeForceMax = m * G * 2.4;
    for (const w of this.wheels) {
      const share = w.front ? 0.31 : 0.19;
      let tb = brakeIn * brakeForceMax * share * w.radius;
      if (c.handbrake && !w.front) tb = Math.max(tb, 9000);
      if (!c.handbrake && w.kappa < -0.16 && Math.abs(w.vx) > 2) tb *= 0.35; // ABS
      w.brakeTorque = tb;
    }

    // ---- Tire forces & wheel spin --------------------------------------------
    for (const w of this.wheels) {
      if (!w.contact) {
        // free spin with bearing drag + brakes + drive
        const tq = w.driveTorque - Math.sign(w.omega) * (w.brakeTorque + 5);
        const next = w.omega + (tq / w.inertia) * dt;
        w.omega = Math.sign(next) !== Math.sign(w.omega) && w.brakeTorque > 0 ? 0 : next;
        w.angle += w.omega * dt;
        w.Fx = w.Fy = 0;
        w.slipEnergy = 0;
        continue;
      }
      const muFz = CHASSIS.tireMu * w.grip * w.Fz;
      const vden = Math.max(Math.abs(w.vx), 1.0);
      const kOf = (om: number) => (om * w.radius - w.vx) / vden;
      const rr0 = CHASSIS.rollingResistance * w.Fz * w.radius * Math.sign(w.omega);
      const f0 = tireFx(kOf(w.omega), w.alpha, muFz);
      const dOm = 0.02;
      const f1 = tireFx(kOf(w.omega + dOm), w.alpha, muFz);
      const slope = Math.max(0, (f1 - f0) / dOm);
      const r = w.radius;
      const solve = (text: number) =>
        (w.inertia * w.omega / dt + text - r * (f0 - slope * w.omega)) / (w.inertia / dt + r * slope);
      const dir = w.omega !== 0 ? Math.sign(w.omega) : Math.sign(w.driveTorque - r * f0) || 1;
      let next = solve(w.driveTorque - rr0 - dir * w.brakeTorque);
      if (w.brakeTorque > 0 && (w.omega === 0 || Math.sign(next) !== Math.sign(w.omega))) {
        const f00 = tireFx(kOf(0), w.alpha, muFz);
        if (Math.abs(w.driveTorque - r * f00) <= w.brakeTorque) next = 0;
      }
      let fx = f0 + slope * (next - w.omega);
      fx = Math.max(-muFz, Math.min(muFz, fx));
      w.omega = next;
      w.angle += w.omega * dt;

      let fy = tireFy(kOf(w.omega), w.alpha, muFz);
      const mEff = (m * w.Fz) / Math.max(totalFz, 1);
      const latCap = (mEff * Math.abs(w.vy)) / dt;
      if (Math.abs(fy) > latCap) fy = Math.sign(fy) * latCap;
      // static hold when braked at (near) rest
      if ((brakeIn > 0.3 || (c.handbrake && !w.front)) && Math.abs(w.vx) < 0.4 && w.omega === 0) {
        fx = Math.max(-muFz, Math.min(muFz, (-w.vx * mEff) / dt * 0.5));
      }
      w.Fx = fx;
      w.Fy = fy;
      w.slipEnergy = Math.abs(fx * (w.omega * r - w.vx)) + Math.abs(fy * w.vy);
      _c.copy(w.normal).multiplyScalar(w.Fz).addScaledVector(w.fwdW, fx).addScaledVector(w.sideW, fy);
      this.addForceAt(_c, w.point);
      w.brakeHeat = Math.max(0, w.brakeHeat + (w.brakeTorque * Math.abs(w.omega) * dt) / 6e5 - dt * 0.08);
    }

    // ---- Thrusters & flight computer ---------------------------------------------
    this.thrustOut.rear = 0;
    this.thrustOut.lift = 0;
    this.thrustOut.rcs.set(0, 0, 0);
    const th = spec.thrusters;
    let impulseUsed = 0;
    if (th && this.impulseLeft > 0) {
      const rear = Math.max(0, Math.min(1, c.boost));
      if (rear > 0) {
        const f = th.rearN * rear;
        this.force.addScaledVector(this.fwd, f);
        impulseUsed += f * dt;
        this.thrustOut.rear = rear;
      }
      if (th.liftN > 0) {
        let lift = Math.max(0, Math.min(1, c.lift));
        const rcs = _rcs.set(0, 0, 0);
        if (airborne) {
          this.flightComputer(world, c, rcs);
          if (this.assists.flight) lift = Math.max(lift, this.landingBurn(world));
        } else if (c.pitch || c.roll || c.yaw) {
          // allow manual attitude while lifting off
          rcs.set(c.pitch, -c.yaw, -c.roll).multiplyScalar(0.6);
        }
        if (lift > 0) {
          const f = th.liftN * lift;
          this.force.addScaledVector(this.up, f);
          impulseUsed += f * dt;
          this.thrustOut.lift = lift;
        }
        if (rcs.lengthSq() > 0) {
          rcs.clampScalar(-1, 1);
          this.thrustOut.rcs.copy(rcs);
          // local torque → world
          _c.set(0, 0, 0)
            .addScaledVector(this.right, rcs.x * th.rcsTorque)
            .addScaledVector(this.up, rcs.y * th.rcsTorque * 0.7)
            .addScaledVector(this.fwd, -rcs.z * th.rcsTorque * 0.85);
          this.torque.add(_c);
          impulseUsed += (Math.abs(rcs.x) + Math.abs(rcs.y) + Math.abs(rcs.z)) * th.rcsTorque * 0.5 * dt;
        }
      }
      this.impulseLeft = Math.max(0, this.impulseLeft - impulseUsed);
    }

    // ---- Integrate velocities ---------------------------------------------------
    this.vel.addScaledVector(this.force, dt / m);
    this.applyInvInertia(this.torque, _c);
    this.angVel.addScaledVector(_c, dt);
    // a little angular damping (air, suspension friction)
    this.angVel.multiplyScalar(1 - (grounded ? 0.4 : 0.05) * dt);

    // ---- Body contacts (impulses) -----------------------------------------------
    this.resolveBodyContacts(world, dt);

    // ---- Integrate positions -----------------------------------------------------
    this.pos.addScaledVector(this.vel, dt);
    const wl = this.angVel.length();
    if (wl > 1e-9) {
      _q.setFromAxisAngle(_a.copy(this.angVel).divideScalar(wl), wl * dt);
      this.quat.premultiply(_q).normalize();
    }

    // ---- Telemetry & energy ---------------------------------------------------------
    this.updateBasis();
    // accelerometer reading: specific force (what the occupant feels)
    _c.subVectors(this.vel, this.lastVel).divideScalar(dt);
    _c.y += G;
    const k = Math.min(1, dt * 12);
    this.gLong += (_c.dot(this.fwd) / G - this.gLong) * k;
    this.gLat += (_c.dot(this.right) / G - this.gLat) * k;
    this.gVert += (_c.dot(this.up) / G - this.gVert) * k;
    this.lastVel.copy(this.vel);
    this.fwdSpeed = this.vel.dot(this.fwd);
    this.speed = this.vel.length();
    this.distance += this.speed * dt;
    this.time += dt;
    if (airborne) {
      this.rollAccum += this.angVel.dot(this.fwd) * dt;
      this.pitchAccum += this.angVel.dot(this.right) * dt;
    } else if (this.groundedTime > 0.5) {
      this.rollAccum = 0;
      this.pitchAccum = 0;
    }
    const fanKW = CHASSIS.fanPowerKW * Math.pow(this.suctionLevel / 2, 1.5);
    const battKW =
      (motorPower >= 0 ? motorPower / CHASSIS.motorEfficiency : motorPower * CHASSIS.regenEfficiency) / 1000 +
      fanKW +
      CHASSIS.auxPowerKW;
    this.powerKW = motorPower / 1000;
    const used = (battKW * dt) / 3600;
    this.energyUsedKWh += used;
    this.batteryKWh = Math.max(0, Math.min(spec.batteryKWh, this.batteryKWh - used));
  }

  /** Attitude control while airborne. Writes a normalised local torque command into `rcs`. */
  private flightComputer(world: PhysWorld, c: Controls, rcs: Vector3) {
    const th = this.spec.thrusters!;
    const I = this.inertia;
    const wLocal = _c.set(this.angVel.dot(this.right), this.angVel.dot(this.up), -this.angVel.dot(this.fwd));
    const pilot = c.pitch !== 0 || c.yaw !== 0 || c.roll !== 0;
    // Desired local angular velocity
    const des = _d.set(0, 0, 0);
    if (pilot || !this.assists.flight) {
      des.set(c.pitch * 3.2, -c.yaw * 2.2, -c.roll * 5.5);
      if (!this.assists.flight) {
        rcs.set(c.pitch, -c.yaw, -c.roll);
        return;
      }
    } else {
      // Auto-level: rotate so that the car's up matches the world up.
      const target = _e.set(0, 1, 0);
      const cosA = Math.max(-1, Math.min(1, this.up.dot(target)));
      const ang = Math.acos(cosA);
      const axis = _a.crossVectors(this.up, target);
      if (this.up.y < 0.2) {
        // Mostly inverted: always right the car with a roll (keeps the heading),
        // turning towards whichever side is already coming up.
        let sgn = Math.sign(axis.dot(this.fwd));
        if (Math.abs(axis.dot(this.fwd)) < 0.05) sgn = Math.sign(this.angVel.dot(this.fwd)) || 1;
        axis.copy(this.fwd).multiplyScalar(sgn);
      }
      axis.normalize();
      const rate = Math.min(5.5, ang * 4.5);
      const aw = axis.multiplyScalar(rate);
      des.set(aw.dot(this.right), aw.dot(this.up), -aw.dot(this.fwd));
      // keep heading: damp yaw
      des.y = 0;
      void world;
    }
    // P-controller on angular rate → torque, normalised to thruster authority
    rcs.set(
      ((des.x - wLocal.x) * I.x * 9) / th.rcsTorque,
      ((des.y - wLocal.y) * I.y * 9) / (th.rcsTorque * 0.7),
      ((des.z - wLocal.z) * I.z * 9) / (th.rcsTorque * 0.85),
    );
  }

  /** Automatic landing burn: fire lift nozzles to arrive at ~2.5 m/s. Returns lift throttle. */
  private landingBurn(world: PhysWorld): number {
    const th = this.spec.thrusters!;
    if (this.up.y < 0.75) return 0;
    const vy = this.vel.y;
    if (vy > -3) return 0;
    const ground = world.heightBelow(this.pos);
    const h = this.pos.y - CHASSIS.comHeight - ground - 0.15;
    if (h <= 0) return 0;
    const vt = 2;
    const aReq = (vy * vy - vt * vt) / (2 * h);
    const aMax = (th.liftN * this.up.y) / this.mass;
    const aNet = aMax - G;
    if (aNet <= 0 || aReq < aNet * 0.7) return 0;
    return Math.min(1, (aReq + G) / aMax);
  }

  private resolveBodyContacts(world: PhysWorld, dt: number) {
    const m = this.mass;
    let corrDepth = 0;
    const corr = _e.set(0, 0, 0);
    for (const bp of BODY_POINTS) {
      _pl.set(bp[0], bp[1], bp[2]);
      const p = this.toWorld(_pl, _a);
      for (const s of world.surfaces) {
        const pen = s.penetrate(p, _n);
        if (pen <= 0) continue;
        const r = _b.subVectors(p, this.pos);
        const vp = _c.crossVectors(this.angVel, r).add(this.vel);
        const vn = vp.dot(_n);
        if (pen > corrDepth) {
          corrDepth = pen;
          corr.copy(_n);
        }
        if (vn >= 0) continue;
        const rn = _d.crossVectors(r, _n);
        this.applyInvInertia(rn, rn);
        rn.cross(r);
        const k = 1 / m + rn.dot(_n);
        const e = vn < -3 ? 0.15 : 0;
        const j = (-(1 + e) * vn) / k;
        // normal impulse
        this.applyImpulse(_n, j, r);
        // friction
        const vp2 = _c.crossVectors(this.angVel, r).add(this.vel);
        const vt = vp2.addScaledVector(_n, -vp2.dot(_n));
        const vtl = vt.length();
        if (vtl > 1e-4) {
          vt.divideScalar(vtl);
          const rt = _d.crossVectors(r, vt);
          this.applyInvInertia(rt, rt);
          rt.cross(r);
          const kt = 1 / m + rt.dot(vt);
          const jt = Math.min(vtl / kt, 0.45 * j);
          this.applyImpulse(vt, -jt, r);
          if (vtl > 2 && j > 50 && this.impacts.length < 32) {
            this.impacts.push({ impulse: j, point: p.clone(), normal: _n.clone(), scrape: vtl });
          }
        }
        if (j > 1500 && vtl <= 2 && this.impacts.length < 32) {
          this.impacts.push({ impulse: j, point: p.clone(), normal: _n.clone(), scrape: 0 });
        }
        this.maxImpactThisStep = Math.max(this.maxImpactThisStep, j / m);
      }
    }
    if (corrDepth > 0.002) this.pos.addScaledVector(corr, Math.min(corrDepth, 0.05) * Math.min(1, dt * 120));
  }

  private applyImpulse(dir: Vector3, j: number, r: Vector3) {
    this.vel.addScaledVector(dir, j / this.mass);
    const tq = _imp.crossVectors(r, dir).multiplyScalar(j);
    this.applyInvInertia(tq, tq);
    this.angVel.add(tq);
  }
}

