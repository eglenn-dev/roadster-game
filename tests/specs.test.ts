import { describe, expect, it } from 'vitest';
import { runInvertedHold, runLaunch, runRange, runTopSpeed } from '../src/sim/benchmarks';
import { EVENT, TRIMS, type TrimId } from '../src/sim/specs';

const ids: TrimId[] = ['performance', 'thrust', 'rocket'];

describe('Roadster meets Tesla’s published specs', () => {
  for (const id of ids) {
    const spec = TRIMS[id];
    it(`${spec.name}: 0–60 mph ${spec.claims.zeroTo60Label}`, () => {
      const r = runLaunch(id);
      console.log(id, JSON.stringify(r));
      expect(r.zeroTo60).toBeGreaterThan(0);
      expect(r.zeroTo60).toBeLessThan(spec.claims.zeroTo60);
    });
    it(`${spec.name}: top speed over 230 mph`, () => {
      const r = runTopSpeed(id);
      console.log(id, JSON.stringify(r));
      expect(r.topMph).toBeGreaterThan(spec.claims.topSpeedMph);
    });
    it(`${spec.name}: range over 300 mi`, () => {
      const r = runRange(id);
      console.log(id, JSON.stringify(r));
      expect(r.rangeMi).toBeGreaterThan(spec.claims.rangeMi);
    });
    it(`${spec.name}: suction holds the car upside down at rest`, () => {
      const r = runInvertedHold(id);
      console.log(id, JSON.stringify(r));
      expect(r.held).toBe(true);
    });
  }

  it(`Thrust reproduces the on-stage ${EVENT.demoZeroTo60} s run (±0.05 s)`, () => {
    const r = runLaunch('thrust');
    expect(Math.abs(r.zeroTo60 - EVENT.demoZeroTo60)).toBeLessThan(0.05);
  });
});
