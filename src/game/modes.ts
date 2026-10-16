import { ArchAutopilot, JumpAutopilot, LaunchAutopilot, TopSpeedAutopilot, type Autopilot } from '../sim/autopilot';
import { LAYOUT } from '../sim/layout';
import { EVENT, MPH, TRIMS, type TrimId } from '../sim/specs';
import type { Vehicle } from '../sim/vehicle';
import type { ArchRamp, PhysWorld } from '../sim/world';

export type ModeId = 'free' | 'arch' | 'jump' | 'launch' | 'topspeed';

export interface ModeInfo {
  id: ModeId;
  title: string;
  kicker: string;
  description: string;
  eventNote: string;
  recommendedTrim?: TrimId;
  needsFlight?: boolean;
  hint: string;
}

export const MODES: ModeInfo[] = [
  {
    id: 'arch',
    title: 'The Inverted Arch',
    kicker: 'Demo 1',
    description: 'Drive up the curved ramp until you are upside down. Stop and hang there on the suction fans, then drop, flip and land on your wheels.',
    eventNote: 'On stage the car climbed a curved ramp upside down, paused, flipped mid-air and landed, with thrusters slowing the descent. The fans pull up to 2 G.',
    recommendedTrim: 'rocket',
    needsFlight: true,
    hint: 'Hold ~45 mph into the arch · brake to a stop at the top · SPACE to drop',
  },
  {
    id: 'jump',
    title: 'Lineup Kickflip',
    kicker: 'Demo 2',
    description: 'Fly over a Cybercab, Cybertruck, Semi, Model Y and Model 3 on cold-gas thrusters. Kickflip on the way over and land on the far side.',
    eventNote: 'The Roadster used its thrusters to lift over the five-vehicle lineup and "kick flip" across it.',
    recommendedTrim: 'rocket',
    needsFlight: true,
    hint: '40 mph · SPACE at the red/white bar · hold E (or Q) to kickflip',
  },
  {
    id: 'launch',
    title: '0–60 Launch',
    kicker: 'Demo 3',
    description: 'Launch control on the strip. Hold brake + throttle, wait for green, release the brake. Add SHIFT for thrusters.',
    eventNote: `Tesla showed an on-screen 0–60 mph run of ${EVENT.demoZeroTo60} seconds and says it expects to do better.`,
    recommendedTrim: 'thrust',
    hint: 'Hold W + S to arm launch control · release S on green · SHIFT = thrusters',
  },
  {
    id: 'topspeed',
    title: 'Top Speed Run',
    kicker: 'Demo 4',
    description: 'Two miles of runway. Flat out until the speed trap. Tesla claims over 230 mph for every version.',
    eventNote: 'Top speed was quoted as over 230 mph; a presenter said at least 235 mph and Musk said "much faster".',
    recommendedTrim: 'performance',
    hint: 'Flat out · T for Track Mode changes the wing · brake before the end',
  },
  {
    id: 'free',
    title: 'Free Drive',
    kicker: 'Open site',
    description: 'The whole McGregor demo site at night: the arch, the lineup, the strip and the stage. Refill N₂ on the blue pads.',
    eventNote: 'The event ran at SpaceX’s rocket development facility in McGregor, Texas, with the crowd kept several hundred yards back.',
    hint: 'Blue rings refill the N₂ tanks · F cycles fan modes · T toggles Track Mode',
  },
];

export interface ModeStatus {
  objective: string;
  steps: { label: string; done: boolean; active?: boolean }[];
  big?: string;
  bigLabel?: string;
}

export interface ModeResult {
  success: boolean;
  title: string;
  subtitle: string;
  lines: [string, string, string?][];
}

export interface ModeContext {
  vehicle: Vehicle;
  world: PhysWorld;
  arch: ArchRamp;
  units: 'mph' | 'kmh';
  toast(msg: string, kind?: 'good' | 'bad' | 'info'): void;
  cheer(strength: number): void;
  beep(freq: number): void;
  setBoard(lines: string[]): void;
  setTree(s: 'off' | 'stage' | 'amber' | 'green'): void;
}

export function fmtSpeed(ms: number, units: 'mph' | 'kmh') {
  return units === 'mph' ? `${(ms / MPH).toFixed(1)} mph` : `${(ms * 3.6).toFixed(1)} km/h`;
}

export abstract class GameMode {
  result: ModeResult | null = null;
  time = 0;
  constructor(public info: ModeInfo) {}
  abstract start(ctx: ModeContext): void;
  abstract update(ctx: ModeContext, dt: number): void;
  abstract status(ctx: ModeContext): ModeStatus;
  autopilot(_ctx: ModeContext): Autopilot | null {
    return null;
  }
}

// ---------------------------------------------------------------------------

export class FreeMode extends GameMode {
  start(ctx: ModeContext) {
    const s = LAYOUT.spawn;
    ctx.vehicle.reset(s.x, s.z, s.heading);
  }
  update() {}
  status(): ModeStatus {
    return { objective: 'Explore the demo site', steps: [] };
  }
}

export class ArchMode extends GameMode {
  private phase: 'approach' | 'deck' | 'hold' | 'drop' | 'done' = 'approach';
  private hold = 0;
  private touchdownVy = 0;
  private tank0 = 1;
  private maxG = 0;
  private dropT = 0;
  start(ctx: ModeContext) {
    ctx.vehicle.reset(LAYOUT.arch.approachX, 0, -Math.PI / 2);
    this.phase = 'approach';
    this.hold = 0;
    this.tank0 = ctx.vehicle.tankFraction;
    this.result = null;
    this.time = 0;
    this.maxG = 0;
  }
  autopilot(ctx: ModeContext) {
    return new ArchAutopilot(ctx.arch);
  }
  update(ctx: ModeContext, dt: number) {
    const v = ctx.vehicle;
    this.time += dt;
    const onArch = v.contactCount > 0 && v.wheels.some((w) => w.contact && w.surfaceId === ctx.arch.id);
    if (this.phase === 'approach' && onArch && v.up.y < 0.9) this.phase = 'deck';
    if (this.phase === 'deck' || this.phase === 'hold') this.maxG = Math.max(this.maxG, Math.hypot(v.gVert, v.gLong));
    if (this.phase === 'deck') {
      if (v.up.y < -0.85 && v.speed < 0.6 && onArch) {
        this.phase = 'hold';
        ctx.toast('Upside down — holding on the fans', 'info');
      } else if (v.airborneTime > 0.4) {
        this.phase = 'drop';
        this.hold = 0;
      }
    }
    if (this.phase === 'hold') {
      if (onArch && v.up.y < -0.8) this.hold += dt;
      if (v.airborneTime > 0.15) {
        this.phase = 'drop';
        this.dropT = 0;
        if (this.hold >= 2) ctx.toast('Released!', 'info');
      }
    }
    if (this.phase === 'drop') {
      this.dropT += dt;
      if (v.contactCount === 0) {
        this.touchdownVy = v.vel.y;
      }
      if (v.contactCount > 0 && v.groundedTime > 0.9) {
        const upright = v.up.y > 0.85;
        const soft = Math.abs(this.touchdownVy) < 7;
        const ok = upright && this.hold >= 2;
        this.phase = 'done';
        const used = Math.max(0, this.tank0 - v.tankFraction);
        this.result = {
          success: ok,
          title: ok ? 'Stuck the landing' : !upright ? 'Landed on the roof' : 'Not quite the event run',
          subtitle: ok
            ? 'Upside down on the fans, dropped, flipped and landed — just like McGregor.'
            : this.hold < 2
              ? 'You need to stop and hang upside down for 2 seconds before the drop.'
              : 'Use the flight system (G toggles assist) to roll upright before touchdown.',
          lines: [
            ['Time upside down', `${this.hold.toFixed(1)} s`, '≥ 2.0 s'],
            ['Touchdown speed', `${Math.abs(this.touchdownVy).toFixed(1)} m/s`, soft ? 'soft' : 'hard'],
            ['Peak load on the climb', `${this.maxG.toFixed(1)} G`],
            ['N₂ used', `${Math.round(used * 100)} %`],
          ],
        };
        if (ok) ctx.cheer(1);
      }
    }
  }
  status(ctx: ModeContext): ModeStatus {
    const v = ctx.vehicle;
    const flightOk = v.canFly;
    return {
      objective: flightOk ? 'Recreate the inverted-arch demo' : 'Rocket trim needed for the drop & flip',
      steps: [
        { label: 'Climb the arch', done: this.phase !== 'approach', active: this.phase === 'approach' },
        { label: `Hang upside down 2 s (${Math.min(2, this.hold).toFixed(1)})`, done: this.hold >= 2, active: this.phase === 'deck' || this.phase === 'hold' },
        { label: 'Drop (SPACE), flip & land', done: this.phase === 'done' && !!this.result?.success, active: this.hold >= 2 },
      ],
      big: this.phase === 'hold' ? `${this.hold.toFixed(1)}s` : undefined,
      bigLabel: this.phase === 'hold' ? 'INVERTED' : undefined,
    };
  }
}

export class JumpMode extends GameMode {
  private phase: 'approach' | 'air' | 'done' = 'approach';
  private hit = false;
  private maxH = 0;
  private air = 0;
  private maxRoll = 0;
  private takeoffX = 0;
  private landedOnCar = false;
  start(ctx: ModeContext) {
    ctx.vehicle.reset(LAYOUT.lineup.approachX, LAYOUT.lineup.z, -Math.PI / 2);
    this.phase = 'approach';
    this.hit = false;
    this.maxH = this.air = this.maxRoll = 0;
    this.result = null;
    this.landedOnCar = false;
  }
  autopilot() {
    return new JumpAutopilot(true);
  }
  update(ctx: ModeContext, dt: number) {
    const v = ctx.vehicle;
    const L = LAYOUT.lineup;
    for (const imp of v.impacts) {
      if (Math.abs(imp.point.z - L.z) < 4 && imp.point.y > 0.25 && Math.abs(imp.point.x - L.centerX) < 8) this.hit = true;
    }
    const lineupIds = new Set(ctx.world.boxes.slice(2, 7).map((b) => b.id));
    if (v.wheels.some((w) => w.contact && lineupIds.has(w.surfaceId))) this.landedOnCar = true;
    if (this.phase === 'approach' && v.airborneTime > 0.2) {
      this.phase = 'air';
      this.takeoffX = v.pos.x;
    }
    if (this.phase === 'air') {
      this.air += dt;
      this.maxH = Math.max(this.maxH, v.pos.y - 0.4);
      this.maxRoll = Math.max(this.maxRoll, Math.abs(v.rollAccum));
      if (v.contactCount > 0 && v.groundedTime > 0.8) {
        this.phase = 'done';
        const cleared = v.pos.x > L.landingX && !this.hit && !this.landedOnCar;
        const upright = v.up.y > 0.85;
        const flip = this.maxRoll > Math.PI * 1.7;
        const ok = cleared && upright;
        this.result = {
          success: ok,
          title: ok ? (flip ? 'Kickflip over the lineup!' : 'Cleared the lineup') : this.landedOnCar ? 'Parked on the lineup' : this.hit ? 'Clipped the lineup' : !upright ? 'Landed upside down' : 'Short of the landing line',
          subtitle: ok ? (flip ? 'Five Teslas cleared with a full kickflip — the event finale.' : 'Now try it with a kickflip (hold E or Q in the air).') : 'Lift earlier or carry more speed. The Semi is 4 m tall.',
          lines: [
            ['Peak height', `${this.maxH.toFixed(1)} m`],
            ['Air time', `${this.air.toFixed(2)} s`],
            ['Rotation', `${Math.round((this.maxRoll * 180) / Math.PI)}°`, flip ? 'kickflip ✓' : '360° = kickflip'],
            ['Distance', `${(v.pos.x - this.takeoffX).toFixed(0)} m`],
          ],
        };
        if (ok) ctx.cheer(flip ? 1.2 : 0.7);
      }
    }
  }
  status(ctx: ModeContext): ModeStatus {
    const v = ctx.vehicle;
    return {
      objective: v.canFly ? 'Fly over all five vehicles' : 'Rocket trim needed for lift thrusters',
      steps: [
        { label: `Reach 40 mph (${fmtSpeed(v.fwdSpeed, ctx.units)})`, done: v.fwdSpeed > 38 * MPH || this.phase !== 'approach', active: this.phase === 'approach' },
        { label: 'Lift off at the red/white bar (SPACE)', done: this.phase !== 'approach', active: this.phase === 'approach' && v.pos.x > LAYOUT.lineup.takeoffX - 30 },
        { label: `Kickflip (${Math.round((this.maxRoll * 180) / Math.PI)}°)`, done: this.maxRoll > Math.PI * 1.7, active: this.phase === 'air' },
        { label: 'Land beyond the line', done: !!this.result?.success, active: this.phase === 'air' },
      ],
    };
  }
}

export class LaunchMode extends GameMode {
  private phase: 'stage' | 'count' | 'run' | 'done' = 'stage';
  private countT = 0;
  private green = 0;
  private reaction = -1;
  private startPos = { x: 0, z: 0 };
  private tMove = -1;
  private tRoll = -1;
  private t60 = -1;
  private t60raw = -1;
  private t100 = -1;
  private tQ = -1;
  private trap = 0;
  private lastBeep = -1;
  private falseStart = false;
  start(ctx: ModeContext) {
    ctx.vehicle.reset(LAYOUT.strip.x, LAYOUT.strip.startZ, 0);
    this.phase = 'stage';
    this.countT = 0;
    this.time = 0;
    this.reaction = this.tMove = this.tRoll = this.t60 = this.t60raw = this.t100 = this.tQ = -1;
    this.result = null;
    this.falseStart = false;
    this.lastBeep = -1;
    this.startPos = { x: ctx.vehicle.pos.x, z: ctx.vehicle.pos.z };
    ctx.setTree('stage');
  }
  autopilot() {
    return new LaunchAutopilot(12, () => this.phase === 'run' || this.phase === 'done');
  }
  update(ctx: ModeContext, dt: number) {
    const v = ctx.vehicle;
    this.time += dt;
    const d = Math.hypot(v.pos.x - this.startPos.x, v.pos.z - this.startPos.z);
    if (this.phase === 'stage') {
      if (this.time > 1.2 && v.speed < 0.2) {
        this.phase = 'count';
        this.countT = 0;
      }
    } else if (this.phase === 'count') {
      this.countT += dt;
      const step = Math.floor(this.countT / 0.5);
      if (step !== this.lastBeep && step < 3) {
        this.lastBeep = step;
        ctx.beep(660);
        ctx.setTree('amber');
      }
      if (d > 0.3) {
        this.falseStart = true;
        this.phase = 'run';
        ctx.toast('Red light — false start', 'bad');
      }
      if (this.countT >= 1.5) {
        this.phase = 'run';
        this.green = this.time;
        ctx.setTree('green');
        ctx.beep(1320);
      }
    } else if (this.phase === 'run') {
      const t = this.time - this.green;
      if (this.tMove < 0 && v.speed > 0.05) {
        this.tMove = t;
        this.reaction = t;
      }
      if (this.tRoll < 0 && d >= 0.3048) this.tRoll = t;
      if (this.t60raw < 0 && v.fwdSpeed >= 60 * MPH) {
        this.t60raw = t - Math.max(0, this.tMove);
        this.t60 = t - Math.max(0, this.tRoll);
        ctx.setBoard(['ROADSTER · 0–60 MPH', `${this.t60.toFixed(2)} s`, `${TRIMS[v.spec.id].name} · event run ${EVENT.demoZeroTo60} s`]);
        ctx.toast(`0–60 mph: ${this.t60.toFixed(2)} s`, 'good');
      }
      if (this.t100 < 0 && v.fwdSpeed >= 100 * MPH) this.t100 = t - Math.max(0, this.tRoll);
      if (this.tQ < 0 && d >= 402.336) {
        this.tQ = t - Math.max(0, this.tMove);
        this.trap = v.fwdSpeed;
      }
      const finished = this.tQ > 0 || (this.t60 > 0 && v.speed < 0.5) || t > 40;
      if (finished) this.finish(ctx);
    }
  }
  private finish(ctx: ModeContext) {
    const v = ctx.vehicle;
    this.phase = 'done';
    const claim = v.spec.claims;
    const ok = !this.falseStart && this.t60 > 0 && this.t60 < claim.zeroTo60;
    this.result = {
      success: ok,
      title: this.falseStart ? 'False start' : ok ? `0–60 in ${this.t60.toFixed(2)} s` : this.t60 > 0 ? `0–60 in ${this.t60.toFixed(2)} s` : 'Run aborted',
      subtitle: ok
        ? `${v.spec.name} beats its ${claim.zeroTo60Label} claim.${Math.abs(this.t60 - EVENT.demoZeroTo60) < 0.015 ? ` Matches the on-stage ${EVENT.demoZeroTo60} s run.` : this.t60 < EVENT.demoZeroTo60 ? ' Faster than the on-stage run!' : ''}`
        : this.t60 > 0
          ? `Claim is ${claim.zeroTo60Label}. Use launch control (hold W+S) and add SHIFT for thrusters.`
          : 'Hold W and S together to arm launch control, release S on green.',
      lines: [
        ['0–60 mph (1-ft rollout)', this.t60 > 0 ? `${this.t60.toFixed(2)} s` : '—', `claim ${claim.zeroTo60Label}`],
        ['0–60 mph (no rollout)', this.t60raw > 0 ? `${this.t60raw.toFixed(2)} s` : '—'],
        ['0–100 mph', this.t100 > 0 ? `${this.t100.toFixed(2)} s` : '—'],
        ['¼ mile', this.tQ > 0 ? `${this.tQ.toFixed(2)} s @ ${fmtSpeed(this.trap, ctx.units)}` : '—'],
        ['Reaction', this.reaction >= 0 ? `${this.reaction.toFixed(3)} s` : '—'],
      ],
    };
    if (ok) ctx.cheer(0.8);
  }
  status(): ModeStatus {
    const running = this.phase === 'run';
    const t = running ? this.time - this.green : 0;
    return {
      objective: this.phase === 'stage' || this.phase === 'count' ? 'Arm launch control: hold W + S' : 'Go!',
      steps: [
        { label: 'Stage & arm launch control', done: this.phase !== 'stage', active: this.phase === 'stage' },
        { label: 'Release brake on green', done: running && this.tMove >= 0, active: this.phase === 'count' },
        { label: `0–60 mph ${this.t60 > 0 ? this.t60.toFixed(2) + ' s' : ''}`, done: this.t60 > 0, active: running },
        { label: `¼ mile ${this.tQ > 0 ? this.tQ.toFixed(2) + ' s' : ''}`, done: this.tQ > 0, active: running && this.t60 > 0 },
      ],
      big: running && this.t60 < 0 && this.tMove >= 0 ? (t - this.tMove).toFixed(2) : this.t60 > 0 ? this.t60.toFixed(2) : undefined,
      bigLabel: this.t60 > 0 ? '0–60 MPH' : running ? 'SECONDS' : undefined,
    };
  }
}

export class TopSpeedMode extends GameMode {
  private top = 0;
  private t200 = -1;
  private t230 = -1;
  private started = -1;
  start(ctx: ModeContext) {
    ctx.vehicle.reset(LAYOUT.strip.x, LAYOUT.strip.startZ, 0);
    this.top = 0;
    this.t200 = this.t230 = this.started = -1;
    this.result = null;
    this.time = 0;
    ctx.setTree('off');
  }
  autopilot() {
    return new TopSpeedAutopilot();
  }
  update(ctx: ModeContext, dt: number) {
    const v = ctx.vehicle;
    this.time += dt;
    if (this.started < 0 && v.speed > 0.5) this.started = this.time;
    this.top = Math.max(this.top, v.fwdSpeed);
    const t = this.time - this.started;
    if (this.t200 < 0 && v.fwdSpeed >= 200 * MPH) this.t200 = t;
    if (this.t230 < 0 && v.fwdSpeed >= 230 * MPH) {
      this.t230 = t;
      ctx.toast('230 mph', 'good');
    }
    const end = LAYOUT.strip.startZ - LAYOUT.strip.length;
    const done = (this.top > 100 * MPH && v.speed < 0.5) || v.pos.z < end;
    if (done && !this.result) {
      const ok = this.top / MPH > 230;
      ctx.setBoard(['ROADSTER · TOP SPEED', fmtSpeed(this.top, ctx.units).replace('.0 ', ' '), `claim: over 230 mph`]);
      this.result = {
        success: ok,
        title: `Top speed ${fmtSpeed(this.top, ctx.units)}`,
        subtitle: ok ? 'Over 230 mph, as claimed at the event.' : 'Keep it pinned. Track Mode adds drag from the wing.',
        lines: [
          ['Top speed', fmtSpeed(this.top, ctx.units), 'claim > 230 mph'],
          ['0–200 mph', this.t200 > 0 ? `${this.t200.toFixed(1)} s` : '—'],
          ['0–230 mph', this.t230 > 0 ? `${this.t230.toFixed(1)} s` : '—'],
          ['Distance used', `${(LAYOUT.strip.startZ - v.pos.z).toFixed(0)} m`],
        ],
      };
      if (ok) ctx.cheer(0.6);
    }
  }
  status(ctx: ModeContext): ModeStatus {
    return {
      objective: 'Beat 230 mph before the end of the strip',
      steps: [
        { label: '200 mph', done: this.t200 > 0, active: this.t200 < 0 },
        { label: '230 mph', done: this.t230 > 0, active: this.t200 > 0 && this.t230 < 0 },
        { label: 'Stop before the end', done: !!this.result, active: this.t230 > 0 },
      ],
      big: fmtSpeed(this.top, ctx.units).split(' ')[0],
      bigLabel: `TOP ${ctx.units === 'mph' ? 'MPH' : 'KM/H'}`,
    };
  }
}

export function createMode(id: ModeId): GameMode {
  const info = MODES.find((m) => m.id === id)!;
  switch (id) {
    case 'arch':
      return new ArchMode(info);
    case 'jump':
      return new JumpMode(info);
    case 'launch':
      return new LaunchMode(info);
    case 'topspeed':
      return new TopSpeedMode(info);
    default:
      return new FreeMode(info);
  }
}
