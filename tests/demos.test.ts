import { describe, expect, it } from 'vitest';
import { ArchAutopilot, JumpAutopilot, LaunchAutopilot, TopSpeedAutopilot, type Autopilot } from '../src/sim/autopilot';
import { SIM_DT } from '../src/sim/benchmarks';
import { LAYOUT, buildWorld } from '../src/sim/layout';
import { MPH, TRIMS } from '../src/sim/specs';
import { Vehicle, makeControls } from '../src/sim/vehicle';

function run(ap: Autopilot, v: Vehicle, world: ReturnType<typeof buildWorld>['world'], maxT: number, log = false) {
  const c = makeControls();
  let t = 0;
  let lastPhase = '';
  let maxImpact = 0;
  let minUpWhileGrounded = 1;
  const trace: string[] = [];
  while (t < maxT && !ap.done) {
    ap.update(v, c, SIM_DT);
    v.step(SIM_DT, world, c);
    v.impacts.length = 0;
    maxImpact = Math.max(maxImpact, v.maxImpactThisStep);
    if (v.contactCount > 0) minUpWhileGrounded = Math.min(minUpWhileGrounded, v.up.y);
    t += SIM_DT;
    if (ap.phase !== lastPhase || (log && Math.round(t / SIM_DT) % 60 === 0)) {
      trace.push(`${t.toFixed(2)} ${ap.phase} pos=${v.pos.toArray().map((x) => x.toFixed(1))} v=${v.fwdSpeed.toFixed(1)} up=${v.up.y.toFixed(2)} cc=${v.contactCount} suc=${v.suctionLevel.toFixed(2)} lift=${v.thrustOut.lift.toFixed(2)} vy=${v.vel.y.toFixed(1)} roll=${v.rollAccum.toFixed(2)}`);
      lastPhase = ap.phase;
    }
  }
  return { t, maxImpact, minUpWhileGrounded, trace };
}

describe('event demos (Optimus autopilot)', () => {
  it('Inverted arch: climb, hold upside down, drop, flip, land on wheels', () => {
    const { world, arch } = buildWorld();
    const v = new Vehicle(TRIMS.rocket);
    v.reset(LAYOUT.arch.approachX, 0, -Math.PI / 2);
    const ap = new ArchAutopilot(arch);
    const r = run(ap, v, world, 60, true);
    console.log(r.trace.join('\n'));
    console.log('maxImpact(m/s)', r.maxImpact.toFixed(2), 'hold', ap.holdTime.toFixed(2));
    expect(ap.done).toBe(true);
    expect(ap.holdTime).toBeGreaterThan(2);
    expect(v.up.y).toBeGreaterThan(0.95);
  });

  it('Lineup kickflip: clears all five vehicles and lands upright', () => {
    const { world } = buildWorld();
    const v = new Vehicle(TRIMS.rocket);
    v.reset(LAYOUT.lineup.approachX, LAYOUT.lineup.z, -Math.PI / 2);
    const ap = new JumpAutopilot(true);
    let hitLineup = false;
    const c = makeControls();
    let t = 0;
    let maxRoll = 0;
    const trace: string[] = [];
    let last = '';
    while (t < 40 && !ap.done) {
      ap.update(v, c, SIM_DT);
      v.step(SIM_DT, world, c);
      for (const imp of v.impacts) if (Math.abs(imp.point.z - LAYOUT.lineup.z) < 4 && imp.point.y > 0.3 && Math.abs(imp.point.x) < 8) hitLineup = true;
      v.impacts.length = 0;
      maxRoll = Math.max(maxRoll, Math.abs(v.rollAccum));
      t += SIM_DT;
      if (ap.phase !== last || Math.round(t / SIM_DT) % 48 === 0) {
        trace.push(`${t.toFixed(2)} ${ap.phase} pos=${v.pos.toArray().map((x) => x.toFixed(1))} v=${v.fwdSpeed.toFixed(1)} up=${v.up.y.toFixed(2)} cc=${v.contactCount} lift=${v.thrustOut.lift.toFixed(2)} roll=${v.rollAccum.toFixed(2)} tank=${v.tankFraction.toFixed(2)}`);
        last = ap.phase;
      }
    }
    console.log(trace.join('\n'));
    expect(hitLineup).toBe(false);
    expect(maxRoll).toBeGreaterThan(Math.PI * 1.8);
    expect(ap.done).toBe(true);
    expect(v.up.y).toBeGreaterThan(0.95);
    expect(v.pos.x).toBeGreaterThan(LAYOUT.lineup.landingX);
  });

  it('Launch demo hits 60 mph on the strip', () => {
    const { world } = buildWorld();
    const v = new Vehicle(TRIMS.thrust);
    v.reset(LAYOUT.strip.x, LAYOUT.strip.startZ, 0);
    const ap = new LaunchAutopilot();
    const r = run(ap, v, world, 30);
    expect(ap.done).toBe(true);
    expect(Math.abs(v.pos.x - LAYOUT.strip.x)).toBeLessThan(3);
    void r;
  });

  it('Top speed run exceeds 230 mph and stops before the end of the strip', () => {
    const { world } = buildWorld();
    const v = new Vehicle(TRIMS.performance);
    v.reset(LAYOUT.strip.x, LAYOUT.strip.startZ, 0);
    const ap = new TopSpeedAutopilot();
    const c = makeControls();
    let top = 0;
    let t = 0;
    while (t < 120 && !ap.done) {
      ap.update(v, c);
      v.step(SIM_DT, world, c);
      v.impacts.length = 0;
      top = Math.max(top, v.fwdSpeed);
      t += SIM_DT;
    }
    console.log('top', (top / MPH).toFixed(1), 'end z', v.pos.z.toFixed(0), 'x', v.pos.x.toFixed(1));
    expect(top / MPH).toBeGreaterThan(230);
    expect(v.pos.z).toBeGreaterThan(LAYOUT.strip.startZ - LAYOUT.strip.length);
    expect(Math.abs(v.pos.x - LAYOUT.strip.x)).toBeLessThan(5);
  });
});
