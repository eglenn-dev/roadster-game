import type { Controls, Vehicle } from '../sim/vehicle';

export type Action =
  | 'camera'
  | 'reset'
  | 'replay'
  | 'pause'
  | 'suction'
  | 'track'
  | 'flight'
  | 'autopilot'
  | 'help'
  | 'mute'
  | 'hud';

const ACTION_KEYS: Record<string, Action> = {
  KeyC: 'camera',
  KeyR: 'reset',
  KeyV: 'replay',
  Escape: 'pause',
  KeyP: 'pause',
  KeyF: 'suction',
  KeyT: 'track',
  KeyG: 'flight',
  KeyO: 'autopilot',
  KeyH: 'help',
  KeyM: 'mute',
  KeyU: 'hud',
};

/** Keys that mean "the player wants to drive" (used to take over from the autopilot). */
const DRIVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE', 'KeyX']);

export class Input {
  private keys = new Set<string>();
  private actions: Action[] = [];
  private steerState = 0;
  driveTouched = false;
  usingGamepad = false;
  private padButtons: boolean[] = [];

  constructor(target: Window) {
    target.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (DRIVE_KEYS.has(e.code) || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!e.repeat && ACTION_KEYS[e.code]) this.actions.push(ACTION_KEYS[e.code]);
      if (DRIVE_KEYS.has(e.code)) this.driveTouched = true;
      this.keys.add(e.code);
      this.usingGamepad = false;
    });
    target.addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('blur', () => this.keys.clear());
  }

  consumeActions(): Action[] {
    const a = this.actions;
    this.actions = [];
    return a;
  }

  private key(...codes: string[]) {
    return codes.some((c) => this.keys.has(c)) ? 1 : 0;
  }

  /** Fill `c` from the current input state. */
  sample(c: Controls, v: Vehicle, dt: number) {
    const airborne = v.airborneTime > 0.15;
    const kUp = this.key('KeyW', 'ArrowUp');
    const kDown = this.key('KeyS', 'ArrowDown');
    const kLeft = this.key('KeyA', 'ArrowLeft');
    const kRight = this.key('KeyD', 'ArrowRight');
    // keyboard steering: rate-limited towards target, faster return to centre
    const target = kRight - kLeft;
    const speedK = 1 / (1 + Math.abs(v.fwdSpeed) / 45);
    const rate = (target === 0 || Math.sign(target) !== Math.sign(this.steerState) ? 6 : 3.2) * (0.6 + speedK * 0.6);
    const diff = target - this.steerState;
    this.steerState += Math.sign(diff) * Math.min(Math.abs(diff), rate * dt);

    c.throttle = kUp;
    c.brake = kDown;
    c.steer = this.steerState;
    c.handbrake = !!this.key('KeyX');
    c.boost = this.key('ShiftLeft', 'ShiftRight');
    const space = this.key('Space');
    const inverted = v.up.y < -0.3 && v.contactCount > 0;
    c.suctionRelease = !!space && inverted;
    c.lift = inverted ? 0 : space;
    c.roll = this.key('KeyE') - this.key('KeyQ');
    c.pitch = airborne ? kDown - kUp : 0;
    c.yaw = airborne ? kRight - kLeft : 0;
    c.launch = c.throttle > 0.5 && c.brake > 0.5 && Math.abs(v.fwdSpeed) < 0.5;

    this.pollGamepad(c, v, airborne);
  }

  private pollGamepad(c: Controls, v: Vehicle, airborne: boolean) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = pads.find((p) => p && p.connected);
    if (!gp) return;
    const dz = (x: number, d = 0.12) => (Math.abs(x) < d ? 0 : (x - Math.sign(x) * d) / (1 - d));
    const lx = dz(gp.axes[0] ?? 0);
    const ry = dz(gp.axes[3] ?? 0);
    const rx = dz(gp.axes[2] ?? 0);
    const rt = gp.buttons[7]?.value ?? 0;
    const lt = gp.buttons[6]?.value ?? 0;
    const btn = (i: number) => !!gp.buttons[i]?.pressed;
    const any = Math.abs(lx) > 0 || rt > 0.05 || lt > 0.05 || btn(0) || btn(1) || btn(2);
    if (any) {
      this.usingGamepad = true;
      this.driveTouched = true;
    }
    if (!this.usingGamepad) return;
    c.steer = Math.sign(lx) * lx * lx;
    c.throttle = rt;
    c.brake = lt;
    c.handbrake = btn(1);
    c.boost = btn(2) ? 1 : 0;
    const inverted = v.up.y < -0.3 && v.contactCount > 0;
    c.suctionRelease = btn(0) && inverted;
    c.lift = btn(0) && !inverted ? 1 : 0;
    c.roll = (btn(5) ? 1 : 0) - (btn(4) ? 1 : 0);
    c.pitch = airborne ? -ry : 0;
    c.yaw = airborne ? rx : 0;
    c.launch = c.throttle > 0.5 && c.brake > 0.5 && Math.abs(v.fwdSpeed) < 0.5;
    // edge-triggered buttons → actions
    const map: [number, Action][] = [
      [3, 'camera'],
      [9, 'pause'],
      [8, 'reset'],
      [12, 'suction'],
      [13, 'track'],
      [14, 'replay'],
      [15, 'flight'],
    ];
    for (const [i, a] of map) {
      const pressed = btn(i);
      if (pressed && !this.padButtons[i]) this.actions.push(a);
      this.padButtons[i] = pressed;
    }
  }

  reset() {
    this.steerState = 0;
    this.driveTouched = false;
  }
}
