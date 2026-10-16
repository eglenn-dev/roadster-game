import { Vector3 } from 'three';
import { LAYOUT } from './layout';
import { MPH } from './specs';
import type { Controls, Vehicle } from './vehicle';
import type { ArchRamp } from './world';

// "Optimus at the wheel": scripted drivers that perform the event demos the way
// Tesla ran them on stage. The player can take over at any time.

export interface Autopilot {
  readonly name: string;
  phase: string;
  done: boolean;
  update(v: Vehicle, c: Controls, dt: number): void;
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

function speedControl(v: Vehicle, c: Controls, target: number, gain = 0.25) {
  const err = target - v.fwdSpeed;
  if (err >= 0) {
    c.throttle = clamp(err * gain + 0.05, 0, 1);
    c.brake = 0;
  } else {
    c.throttle = 0;
    c.brake = clamp(-err * 0.3, 0, 1);
  }
}

/** Steer along a straight line through `p0` in direction `dir` (horizontal, unit). */
function steerToLine(v: Vehicle, c: Controls, p0: Vector3, dir: Vector3, lookahead = 12) {
  const side = _s.set(-dir.z, 0, dir.x); // right of travel
  const dx = v.pos.x - p0.x;
  const dz = v.pos.z - p0.z;
  const lateral = dx * side.x + dz * side.z; // >0: car is right of the line
  const fwdH = _f.set(v.fwd.x, 0, v.fwd.z);
  if (fwdH.lengthSq() < 1e-6) return;
  fwdH.normalize();
  const headingErr = fwdH.dot(side); // >0: pointing right
  c.steer = clamp(-(lateral * (1.2 / lookahead) + headingErr * 1.4), -1, 1);
}

const _s = new Vector3();
const _f = new Vector3();
const _p = new Vector3();

function clearControls(c: Controls) {
  c.throttle = c.brake = c.boost = c.lift = c.pitch = c.yaw = c.roll = 0;
  c.steer = 0;
  c.handbrake = c.suctionRelease = c.launch = false;
}

/** Demo 1: climb the arch, stop upside down, hold on the fans, drop, flip, land. */
export class ArchAutopilot implements Autopilot {
  readonly name = 'Inverted arch';
  phase = 'approach';
  done = false;
  private t = 0;
  holdTime = 0;
  private readonly dir = new Vector3(1, 0, 0);
  constructor(private arch: ArchRamp) {
    this.dir.copy(arch.dir);
  }

  update(v: Vehicle, c: Controls, dt: number) {
    this.t += dt;
    clearControls(c);
    const [phi] = this.arch.local(v.pos);
    const onDeck = v.contactCount > 0 && v.up.y < 0.97 && phi > 0.15;
    switch (this.phase) {
      case 'approach': {
        steerToLine(v, c, this.arch.origin, this.dir);
        speedControl(v, c, 20);
        if (onDeck) this.phase = 'climb';
        break;
      }
      case 'climb': {
        this.steerOnDeck(v, c);
        // ease off over the top and come to rest upside down at the apex
        const remaining = Math.max(0, Math.PI - phi) * this.arch.radius;
        const vt = Math.min(15, Math.sqrt(2 * 3.2 * remaining));
        speedControl(v, c, vt, 0.35);
        if (phi > 2.6 && v.fwdSpeed > vt + 0.5) c.brake = clamp((v.fwdSpeed - vt) * 0.4, 0.15, 1);
        if (remaining < 0.6 || (phi > 2.9 && v.speed < 0.5)) this.phase = 'hold';
        break;
      }
      case 'hold': {
        c.brake = 1;
        c.handbrake = true;
        this.holdTime += dt;
        if (this.holdTime > 2.5) {
          this.phase = 'release';
          this.t = 0;
        }
        break;
      }
      case 'release': {
        // cut the fans and push off the ceiling with the lift nozzles
        c.suctionRelease = true;
        c.lift = this.t < 0.25 ? 0.5 : 0;
        if (v.airborneTime > 0.15) this.phase = 'flip';
        if (this.t > 2) this.phase = 'flip';
        break;
      }
      case 'flip': {
        c.suctionRelease = v.up.y < 0.5; // fans back on once upright for the landing
        if (v.contactCount >= 3 && v.groundedTime > 0.6) {
          this.phase = 'exit';
          this.t = 0;
        }
        break;
      }
      case 'exit': {
        _p.copy(this.arch.origin);
        steerToLine(v, c, _p, _f.copy(this.dir).negate());
        if (this.t < 3.5) speedControl(v, c, 12);
        else speedControl(v, c, 0);
        if (this.t > 3.5 && v.speed < 0.3) {
          this.done = true;
          this.phase = 'done';
        }
        break;
      }
      default:
        c.brake = 1;
    }
  }

  private steerOnDeck(v: Vehicle, c: Controls) {
    const [, , b] = this.arch.local(v.pos);
    const rs = v.right.dot(this.arch.side);
    const e = b * rs; // >0: displaced towards the car's right
    const h = v.fwd.dot(this.arch.side) * rs;
    c.steer = clamp(-(0.18 * e + 1.8 * h), -0.6, 0.6);
  }
}

/** Demo 2: lift on thrusters over the five-vehicle lineup with a kickflip, land beyond. */
export class JumpAutopilot implements Autopilot {
  readonly name = 'Lineup kickflip';
  phase = 'approach';
  done = false;
  private t = 0;
  private readonly p0 = new Vector3(0, 0, LAYOUT.lineup.z);
  private readonly dir = new Vector3(1, 0, 0);
  constructor(public kickflip = true) {}

  update(v: Vehicle, c: Controls, dt: number) {
    this.t += dt;
    clearControls(c);
    const L = LAYOUT.lineup;
    switch (this.phase) {
      case 'approach':
        steerToLine(v, c, this.p0, this.dir, 16);
        speedControl(v, c, 40 * MPH);
        if (v.pos.x >= L.takeoffX) {
          this.phase = 'lift';
          this.t = 0;
        }
        break;
      case 'lift':
        speedControl(v, c, 40 * MPH);
        c.lift = 1;
        if (this.t > 1.0) {
          this.phase = this.kickflip ? 'kickflip' : 'coast';
          this.t = 0;
        }
        break;
      case 'kickflip':
        c.roll = 1;
        if (Math.abs(v.rollAccum) > Math.PI * 2 - 1.1) this.phase = 'coast';
        break;
      case 'coast':
        if (v.contactCount >= 3 && v.groundedTime > 0.3) {
          this.phase = 'stop';
          this.t = 0;
        }
        break;
      case 'stop':
        steerToLine(v, c, this.p0, this.dir, 16);
        speedControl(v, c, this.t < 1.5 ? 15 : 0);
        if (v.speed < 0.3 && this.t > 1.5) {
          this.done = true;
          this.phase = 'done';
        }
        break;
      default:
        c.brake = 1;
    }
  }
}

/** Demo 3: launch-control run on the strip. */
export class LaunchAutopilot implements Autopilot {
  readonly name = 'Launch';
  phase = 'stage';
  done = false;
  private t = 0;
  private readonly p0 = new Vector3(LAYOUT.strip.x, 0, LAYOUT.strip.startZ);
  private readonly dir = new Vector3(0, 0, -1);
  /** `go` lets a race-tree drive the start; without it the car launches after 2.2 s. */
  constructor(public holdAfter = 3, private go?: () => boolean) {}

  update(v: Vehicle, c: Controls, dt: number) {
    this.t += dt;
    clearControls(c);
    switch (this.phase) {
      case 'stage':
        c.launch = true;
        c.brake = 1;
        c.throttle = 1;
        if (this.go ? this.go() : this.t > 2.2) {
          this.phase = 'run';
          this.t = 0;
        }
        break;
      case 'run':
        c.throttle = 1;
        c.boost = v.hasThrusters ? 1 : 0;
        steerToLine(v, c, this.p0, this.dir, 40);
        if (v.distance > 430 || this.t > this.holdAfter) {
          this.phase = 'brake';
          this.t = 0;
        }
        break;
      case 'brake':
        steerToLine(v, c, this.p0, this.dir, 40);
        c.brake = 0.8;
        if (v.speed < 0.3) {
          this.done = true;
          this.phase = 'done';
        }
        break;
    }
  }
}

/** Demo 4: flat-out to top speed on the 2-mile strip. */
export class TopSpeedAutopilot implements Autopilot {
  readonly name = 'Top speed';
  phase = 'run';
  done = false;
  private readonly p0 = new Vector3(LAYOUT.strip.x, 0, LAYOUT.strip.startZ);
  private readonly dir = new Vector3(0, 0, -1);

  update(v: Vehicle, c: Controls) {
    clearControls(c);
    steerToLine(v, c, this.p0, this.dir, 60);
    const endZ = LAYOUT.strip.startZ - LAYOUT.strip.length;
    const remaining = v.pos.z - endZ;
    const stopDist = (v.fwdSpeed * v.fwdSpeed) / (2 * 12) + 150;
    if (this.phase === 'run') {
      c.throttle = 1;
      if (remaining < stopDist) this.phase = 'brake';
    } else if (this.phase === 'brake') {
      c.brake = 1;
      if (v.speed < 0.3) {
        this.phase = 'done';
        this.done = true;
      }
    }
  }
}
