import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three/webgpu';
import { LAYOUT } from '../sim/layout';
import type { Vehicle } from '../sim/vehicle';

export type CameraMode = 'chase' | 'far' | 'hood' | 'cinematic' | 'orbit';
export const CAMERA_MODES: CameraMode[] = ['chase', 'far', 'hood', 'cinematic', 'orbit'];
export const CAMERA_LABEL: Record<CameraMode, string> = {
  chase: 'Chase',
  far: 'Wide chase',
  hood: 'Cockpit',
  cinematic: 'Broadcast',
  orbit: 'Orbit (drag)',
};

// Fixed broadcast camera positions around the demo areas, like the livestream.
const BROADCAST: Vector3[] = [
  // arch: from the open side of the loop, like the livestream
  new Vector3(-30, 2.5, 9),
  new Vector3(-17, 1.4, -7),
  new Vector3(-42, 15, -4),
  new Vector3(-90, 1.6, 14),
  new Vector3(-30, 3, -100),
  new Vector3(0, 1.4, -96),
  new Vector3(36, 6, -138),
  new Vector3(-80, 1.8, -132),
  new Vector3(LAYOUT.strip.x - 22, 2, LAYOUT.strip.startZ - 20),
  new Vector3(LAYOUT.strip.x + 20, 1.2, LAYOUT.strip.startZ - 400),
  new Vector3(LAYOUT.strip.x - 24, 3, LAYOUT.strip.startZ - 1200),
  new Vector3(LAYOUT.strip.x + 22, 2, LAYOUT.strip.startZ - 2100),
  new Vector3(LAYOUT.strip.x - 20, 2.5, LAYOUT.strip.startZ - 2900),
  new Vector3(-40, 8, 120),
  new Vector3(60, 3, 60),
];

const _a = new Vector3();
const _b = new Vector3();
const _c = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();

export class CameraRig {
  mode: CameraMode = 'chase';
  private pos = new Vector3(0, 3, 10);
  private vel = new Vector3();
  private look = new Vector3();
  private camUp = new Vector3(0, 1, 0);
  private heading = new Vector3(0, 0, -1);
  private shake = 0;
  private broadcastIdx = -1;
  private broadcastTime = 0;
  orbitYaw = 0.6;
  orbitPitch = 0.25;
  orbitDist = 7.5;
  private dragging = false;
  private lastMouse: [number, number] = [0, 0];
  menuSpin = 0;

  constructor(public camera: PerspectiveCamera, canvas: HTMLCanvasElement) {
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastMouse = [e.clientX, e.clientY];
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastMouse[0];
      const dy = e.clientY - this.lastMouse[1];
      this.lastMouse = [e.clientX, e.clientY];
      this.orbitYaw -= dx * 0.006;
      this.orbitPitch = MathUtils.clamp(this.orbitPitch + dy * 0.004, -0.05, 1.4);
    });
    canvas.addEventListener('wheel', (e) => {
      this.orbitDist = MathUtils.clamp(this.orbitDist * (1 + Math.sign(e.deltaY) * 0.08), 3.5, 40);
    });
  }

  cycle() {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    this.broadcastIdx = -1;
  }

  addShake(amount: number) {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  snap(v: Vehicle) {
    this.heading.copy(v.fwd).setY(0).normalize();
    this.camUp.set(0, 1, 0);
    this.pos.copy(v.pos).addScaledVector(this.heading, -7).add(_a.set(0, 2.2, 0));
    this.vel.set(0, 0, 0);
    this.look.copy(v.pos);
  }

  /** Slow turntable around the car for the menu. */
  updateMenu(target: Vector3, dt: number) {
    this.menuSpin += dt * 0.12;
    const d = 11.5;
    this.camera.position.set(target.x + Math.cos(this.menuSpin) * d, target.y + 1.1 + Math.sin(this.menuSpin * 0.7) * 0.25, target.z + Math.sin(this.menuSpin) * d);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target.x, target.y + 0.15, target.z);
    this.camera.fov = 30;
    this.camera.updateProjectionMatrix();
  }

  update(v: Vehicle, dt: number, overrideMode?: CameraMode) {
    const mode = overrideMode ?? this.mode;
    const cam = this.camera;
    const speed = v.speed;
    // Heading: blend of car forward and travel direction, projected on the reference up
    const onWall = v.contactCount > 0 && v.up.y < 0.9;
    const targetUp = onWall ? v.up : _a.set(0, 1, 0);
    this.camUp.lerp(targetUp, Math.min(1, dt * (onWall ? 3.5 : 1.5))).normalize();
    const fwdRef = _b.copy(v.fwd);
    if (v.contactCount === 0 && speed > 4) fwdRef.lerp(_c.copy(v.vel).normalize(), 0.5);
    if (v.fwdSpeed < -2) fwdRef.negate();
    fwdRef.addScaledVector(this.camUp, -fwdRef.dot(this.camUp));
    if (fwdRef.lengthSq() > 1e-4) {
      fwdRef.normalize();
      const k = v.contactCount === 0 ? 2.0 : 5.5;
      this.heading.lerp(fwdRef, Math.min(1, dt * k)).normalize();
    }
    let fov = 55;
    if (mode === 'chase' || mode === 'far') {
      const far = mode === 'far';
      const dist = (far ? 10.5 : 6.4) + Math.min(3, speed * 0.02);
      const height = far ? 3.4 : 1.9;
      const desired = _a.copy(v.pos).addScaledVector(this.heading, -dist).addScaledVector(this.camUp, height);
      // critically damped spring
      const w = far ? 7 : 9;
      const accel = _c.copy(desired).sub(this.pos).multiplyScalar(w * w).addScaledVector(this.vel, -2 * w);
      this.vel.addScaledVector(accel, dt);
      this.pos.addScaledVector(this.vel, dt);
      // never go under the ground
      if (this.camUp.y > 0.9) this.pos.y = Math.max(this.pos.y, 0.4);
      this.look.copy(v.pos).addScaledVector(this.camUp, 0.75).addScaledVector(this.heading, 2.0);
      cam.position.copy(this.pos);
      cam.up.copy(this.camUp);
      cam.lookAt(this.look);
      fov = 55 + Math.min(20, speed * 0.16);
    } else if (mode === 'hood') {
      _a.set(-0.33, 0.62, 0.18).applyQuaternion(v.quat).add(v.pos);
      cam.position.copy(_a);
      cam.up.copy(v.up);
      _b.copy(v.pos).addScaledVector(v.fwd, 30).addScaledVector(v.up, 0.4);
      cam.lookAt(_b);
      fov = 68 + Math.min(14, speed * 0.1);
      this.pos.copy(cam.position);
    } else if (mode === 'orbit') {
      const cp = Math.cos(this.orbitPitch);
      cam.position.set(
        v.pos.x + Math.sin(this.orbitYaw) * cp * this.orbitDist,
        v.pos.y + Math.sin(this.orbitPitch) * this.orbitDist + 0.4,
        v.pos.z + Math.cos(this.orbitYaw) * cp * this.orbitDist,
      );
      if (cam.position.y < 0.3) cam.position.y = 0.3;
      cam.up.set(0, 1, 0);
      cam.lookAt(v.pos);
      fov = 50;
      this.pos.copy(cam.position);
    } else {
      // broadcast: pick the best fixed camera, telephoto to frame the car
      this.broadcastTime += dt;
      const cur = BROADCAST[this.broadcastIdx];
      const curDist = cur ? cur.distanceTo(v.pos) : Infinity;
      if (!cur || curDist > 150 || (this.broadcastTime > 7 && curDist > 25)) {
        let best = 0;
        let bestD = Infinity;
        // prefer cameras ahead of the car
        BROADCAST.forEach((p, i) => {
          const d = p.distanceTo(v.pos);
          const ahead = _c.subVectors(p, v.pos).normalize().dot(v.vel.lengthSq() > 1 ? _a.copy(v.vel).normalize() : v.fwd);
          const score = d * (1.2 - ahead * 0.4) + (i === this.broadcastIdx ? 30 : 0);
          if (d > 6 && score < bestD) {
            bestD = score;
            best = i;
          }
        });
        if (best !== this.broadcastIdx) {
          this.broadcastIdx = best;
          this.broadcastTime = 0;
          this.look.copy(v.pos);
        }
      }
      const p = BROADCAST[this.broadcastIdx];
      cam.position.copy(p);
      cam.up.set(0, 1, 0);
      this.look.lerp(v.pos, Math.min(1, dt * 6));
      cam.lookAt(this.look);
      const d = p.distanceTo(v.pos);
      fov = MathUtils.clamp(2 * MathUtils.radToDeg(Math.atan(5.5 / d)), 6, 60);
      this.pos.copy(cam.position);
    }
    // shake
    if (this.shake > 0.001) {
      const s = this.shake * 0.06;
      cam.position.x += (Math.random() - 0.5) * s;
      cam.position.y += (Math.random() - 0.5) * s;
      cam.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 6);
    }
    // thruster rumble
    const rumble = v.thrustOut.rear + v.thrustOut.lift;
    if (rumble > 0.05 && mode !== 'cinematic') {
      _m.makeRotationFromQuaternion(cam.quaternion);
      cam.quaternion.multiply(_q.setFromAxisAngle(_a.set(0, 0, 1), (Math.random() - 0.5) * 0.004 * rumble));
    }
    cam.fov += (fov - cam.fov) * Math.min(1, dt * 4);
    cam.updateProjectionMatrix();
  }
}
