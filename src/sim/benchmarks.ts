import { Quaternion, Vector3 } from 'three';
import { MPH, TRIMS, type TrimId } from './specs';
import { Vehicle, makeControls } from './vehicle';
import { PhysWorld } from './world';

export const SIM_DT = 1 / 240;

export interface LaunchResult {
  zeroTo60: number; // with 1-ft rollout (how Tesla quotes it)
  zeroTo60NoRollout: number;
  zeroTo100: number;
  quarterMile: number;
  trapMph: number;
  peakG: number;
}

export function runLaunch(trim: TrimId, useThrusters = true): LaunchResult {
  const world = new PhysWorld();
  const v = new Vehicle(TRIMS[trim]);
  v.reset(0, 0, 0);
  const c = makeControls();
  // settle on the springs, then arm launch control
  for (let i = 0; i < 240; i++) v.step(SIM_DT, world, c);
  c.launch = true;
  c.brake = 1;
  c.throttle = 1;
  for (let i = 0; i < 120; i++) v.step(SIM_DT, world, c);
  c.launch = false;
  c.brake = 0;
  c.boost = useThrusters && v.hasThrusters ? 1 : 0;
  const start = v.pos.clone();
  let t = 0;
  let tRoll = -1;
  let t60 = -1;
  let t60nr = -1;
  let t100 = -1;
  let tq = -1;
  let trap = 0;
  let peakG = 0;
  while (t < 30) {
    v.step(SIM_DT, world, c);
    t += SIM_DT;
    const d = v.pos.distanceTo(start);
    const s = v.fwdSpeed;
    peakG = Math.max(peakG, v.gLong);
    if (tRoll < 0 && d >= 0.3048) tRoll = t;
    if (t60nr < 0 && s >= 60 * MPH) {
      t60nr = t;
      t60 = t - Math.max(0, tRoll);
    }
    if (t100 < 0 && s >= 100 * MPH) t100 = t - Math.max(0, tRoll);
    if (tq < 0 && d >= 402.336) {
      tq = t;
      trap = s / MPH;
      break;
    }
  }
  return { zeroTo60: t60, zeroTo60NoRollout: t60nr, zeroTo100: t100, quarterMile: tq, trapMph: trap, peakG };
}

export function runTopSpeed(trim: TrimId): { topMph: number; timeTo230: number; distance: number } {
  const world = new PhysWorld();
  const v = new Vehicle(TRIMS[trim]);
  v.reset(0, 0, 0);
  const c = makeControls();
  for (let i = 0; i < 240; i++) v.step(SIM_DT, world, c);
  c.throttle = 1;
  let top = 0;
  let t = 0;
  let t230 = -1;
  while (t < 60) {
    v.step(SIM_DT, world, c);
    t += SIM_DT;
    top = Math.max(top, v.fwdSpeed);
    if (t230 < 0 && v.fwdSpeed >= 230 * MPH) t230 = t;
  }
  return { topMph: top / MPH, timeTo230: t230, distance: v.distance };
}

/** Steady 65 mph cruise on flat ground → projected range on a full battery. */
export function runRange(trim: TrimId, mph = 65): { rangeMi: number; whPerMi: number } {
  const world = new PhysWorld();
  const v = new Vehicle(TRIMS[trim]);
  v.reset(0, 0, 0);
  v.suctionMode = 'off';
  const c = makeControls();
  const target = mph * MPH;
  let t = 0;
  // accelerate gently to speed
  while (v.fwdSpeed < target && t < 60) {
    c.throttle = 0.15;
    v.step(SIM_DT, world, c);
    t += SIM_DT;
  }
  const e0 = v.energyUsedKWh;
  const d0 = v.distance;
  let integ = 0;
  for (let i = 0; i < 240 * 60; i++) {
    const err = target - v.fwdSpeed;
    integ += err * SIM_DT;
    c.throttle = Math.max(0, Math.min(1, 0.02 + err * 0.08 + integ * 0.02));
    v.step(SIM_DT, world, c);
  }
  const kwh = v.energyUsedKWh - e0;
  const mi = (v.distance - d0) / 1609.344;
  const whPerMi = (kwh * 1000) / mi;
  return { rangeMi: (TRIMS[trim].batteryKWh * 1000) / whPerMi, whPerMi };
}

/** Park the car upside down at the top of an inverted arch and see if the fans hold it. */
export function runInvertedHold(trim: TrimId, seconds = 4): { held: boolean; drift: number } {
  const world = new PhysWorld();
  const arch = world.addArch(new Vector3(0, 0, 0), 0);
  const v = new Vehicle(TRIMS[trim]);
  const top = arch.pointAt(Math.PI, 0, new Vector3());
  // inverted: up = (0,-1,0), heading along -X (direction of travel over the top)
  v.reset(0, 0, 0);
  v.suctionMode = 'max';
  v.suctionLevel = 2;
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // face -X
  const flip = new Quaternion().setFromAxisAngle(new Vector3(0, 0, -1).applyQuaternion(q).normalize(), Math.PI);
  v.quat.copy(flip.multiply(q));
  v.updateBasis();
  // the deck curves towards the wheels; start slightly clear and let the fans pull it in
  v.pos.copy(top).addScaledVector(v.up, 0.4 + 0.2);
  for (let i = 0; i < 240; i++) v.step(SIM_DT, world, makeControls());
  const c = makeControls();
  c.handbrake = true;
  c.brake = 1;
  const p0 = v.pos.clone();
  for (let i = 0; i < 240 * seconds; i++) v.step(SIM_DT, world, c);
  const drift = v.pos.distanceTo(p0);
  return { held: v.up.y < -0.9 && drift < 0.5 && v.contactCount === 4, drift };
}
