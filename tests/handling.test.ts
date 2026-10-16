import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/sim/benchmarks';
import { TRIMS } from '../src/sim/specs';
import { Vehicle, makeControls } from '../src/sim/vehicle';
import { PhysWorld } from '../src/sim/world';

function cruise(v: Vehicle, world: PhysWorld, speed: number) {
  const c = makeControls();
  let t = 0;
  while (v.fwdSpeed < speed && t < 30) {
    c.throttle = 1;
    v.step(SIM_DT, world, c);
    t += SIM_DT;
  }
  return c;
}

describe('handling stays sane', () => {
  for (const speed of [8, 25, 45, 70]) {
    it(`full steering lock at ${speed} m/s does not flip or explode`, () => {
      const world = new PhysWorld();
      const v = new Vehicle(TRIMS.performance);
      v.reset(0, 0, 0);
      const c = cruise(v, world, speed);
      c.throttle = 0.3;
      c.steer = 1;
      let maxYaw = 0;
      let minUp = 1;
      for (let i = 0; i < 240 * 4; i++) {
        v.step(SIM_DT, world, c);
        maxYaw = Math.max(maxYaw, Math.abs(v.angVel.y));
        minUp = Math.min(minUp, v.up.y);
      }
      console.log(speed, 'maxYaw', maxYaw.toFixed(2), 'minUp', minUp.toFixed(3), 'lat', v.gLat.toFixed(2), 'speed', v.speed.toFixed(1));
      expect(Number.isFinite(v.pos.x)).toBe(true);
      expect(minUp).toBeGreaterThan(0.8);
      expect(maxYaw).toBeLessThan(4);
      expect(v.contactCount).toBe(4);
    });
  }

  it('brakes from 100 mph to a stop in a straight line', () => {
    const world = new PhysWorld();
    const v = new Vehicle(TRIMS.performance);
    v.reset(0, 0, 0);
    const c = cruise(v, world, 44.7);
    c.throttle = 0;
    c.brake = 1;
    const x0 = v.pos.clone();
    let t = 0;
    while (v.speed > 0.2 && t < 20) {
      v.step(SIM_DT, world, c);
      t += SIM_DT;
    }
    const d = v.pos.distanceTo(x0);
    console.log('100-0 mph', d.toFixed(1), 'm', t.toFixed(2), 's', 'lateral drift', Math.abs(v.pos.x).toFixed(2));
    expect(d).toBeLessThan(80);
    expect(Math.abs(v.pos.x)).toBeLessThan(1.5);
  });

  it('sits still on flat ground', () => {
    const world = new PhysWorld();
    const v = new Vehicle(TRIMS.rocket);
    v.reset(0, 0, 0);
    const c = makeControls();
    for (let i = 0; i < 240 * 5; i++) v.step(SIM_DT, world, c);
    expect(v.speed).toBeLessThan(0.01);
    expect(Math.abs(v.pos.y - 0.4)).toBeLessThan(0.05);
  });
});
