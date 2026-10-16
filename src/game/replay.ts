import type { Vehicle } from '../sim/vehicle';

// Fixed-rate recording of everything the renderer needs to redraw the car.
const STRIDE = 34;
const RATE = 60;

export class Replay {
  private buf: Float32Array;
  private frames = 0;
  private head = 0;
  private acc = 0;
  readonly capacity: number;
  playing = false;
  private playT = 0;

  constructor(seconds = 40) {
    this.capacity = seconds * RATE;
    this.buf = new Float32Array(this.capacity * STRIDE);
  }

  clear() {
    this.frames = 0;
    this.head = 0;
    this.acc = 0;
  }

  get duration() {
    return this.frames / RATE;
  }

  record(v: Vehicle, dt: number) {
    this.acc += dt;
    if (this.acc < 1 / RATE) return;
    this.acc -= 1 / RATE;
    const o = this.head * STRIDE;
    const b = this.buf;
    b[o] = v.pos.x;
    b[o + 1] = v.pos.y;
    b[o + 2] = v.pos.z;
    b[o + 3] = v.quat.x;
    b[o + 4] = v.quat.y;
    b[o + 5] = v.quat.z;
    b[o + 6] = v.quat.w;
    for (let i = 0; i < 4; i++) {
      const w = v.wheels[i];
      b[o + 7 + i * 4] = w.s;
      b[o + 8 + i * 4] = w.steer;
      b[o + 9 + i * 4] = w.angle;
      b[o + 10 + i * 4] = w.brakeHeat;
    }
    b[o + 23] = v.wingHeight;
    b[o + 24] = v.wing;
    b[o + 25] = v.airbrake;
    b[o + 26] = v.fanRpm;
    b[o + 27] = v.thrustOut.rear;
    b[o + 28] = v.thrustOut.lift;
    b[o + 29] = v.thrustOut.rcs.x;
    b[o + 30] = v.thrustOut.rcs.y;
    b[o + 31] = v.thrustOut.rcs.z;
    b[o + 32] = v.speed;
    b[o + 33] = v.wheels[0].brakeTorque;
    this.head = (this.head + 1) % this.capacity;
    this.frames = Math.min(this.capacity, this.frames + 1);
  }

  start() {
    this.playing = this.frames > 10;
    this.playT = 0;
    return this.playing;
  }

  stop() {
    this.playing = false;
  }

  /** Advance playback and write the interpolated frame into `ghost`. Returns false at the end. */
  play(ghost: Vehicle, dt: number, speed = 1): boolean {
    if (!this.playing) return false;
    this.playT += dt * speed;
    const f = this.playT * RATE;
    if (f >= this.frames - 1) {
      this.playing = false;
      return false;
    }
    const i0 = Math.floor(f);
    const t = f - i0;
    const start = (this.head - this.frames + this.capacity) % this.capacity;
    const o0 = ((start + i0) % this.capacity) * STRIDE;
    const o1 = ((start + i0 + 1) % this.capacity) * STRIDE;
    const b = this.buf;
    const L = (k: number) => b[o0 + k] + (b[o1 + k] - b[o0 + k]) * t;
    const prev = ghost.pos.clone();
    ghost.pos.set(L(0), L(1), L(2));
    ghost.quat.set(b[o0 + 3], b[o0 + 4], b[o0 + 5], b[o0 + 6]);
    const q1 = ghost.quat.clone().set(b[o1 + 3], b[o1 + 4], b[o1 + 5], b[o1 + 6]);
    ghost.quat.slerp(q1, t);
    ghost.updateBasis();
    if (dt > 0) ghost.vel.subVectors(ghost.pos, prev).divideScalar(dt * speed);
    for (let i = 0; i < 4; i++) {
      const w = ghost.wheels[i];
      w.s = L(7 + i * 4);
      w.steer = L(8 + i * 4);
      w.angle = L(9 + i * 4);
      w.brakeHeat = L(10 + i * 4);
    }
    ghost.wingHeight = L(23);
    ghost.wing = L(24);
    ghost.airbrake = L(25);
    ghost.fanRpm = L(26);
    ghost.thrustOut.rear = L(27);
    ghost.thrustOut.lift = L(28);
    ghost.thrustOut.rcs.set(L(29), L(30), L(31));
    ghost.speed = L(32);
    ghost.fwdSpeed = ghost.vel.dot(ghost.fwd);
    ghost.wheels[0].brakeTorque = L(33);
    ghost.contactCount = ghost.thrustOut.lift > 0.05 ? 0 : 4;
    return true;
  }

  get progress() {
    return this.frames ? (this.playT * RATE) / this.frames : 0;
  }
}
