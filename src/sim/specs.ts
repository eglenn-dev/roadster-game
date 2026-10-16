// Vehicle specifications for the next-generation Tesla Roadster, as presented at
// the October 15, 2026 unveiling at SpaceX McGregor (Texas) and listed on
// Tesla's site afterwards. Values marked "claim" are Tesla's published figures;
// everything else is an engineering estimate chosen so the simulated car meets
// those claims (see tests/specs.test.ts).

export const MPH = 0.44704; // m/s per mph
export const G = 9.81;

export type TrimId = 'performance' | 'thrust' | 'rocket';

export interface ThrusterSpec {
  /** Total forward thrust from rear nozzles (N). */
  rearN: number;
  /** Total thrust from downward-facing lift nozzles (N). 0 if not fitted. */
  liftN: number;
  /** Max attitude-control torque from perimeter RCS nozzles (N·m). */
  rcsTorque: number;
  /** Stored impulse budget of the cold-gas system (N·s). */
  impulseNs: number;
  nozzleCount: number;
  tankLiters: number;
  pressureBar: number;
}

export interface TrimSpec {
  id: TrimId;
  name: string;
  readiness: string;
  tagline: string;
  seats: number;
  availability: string;
  reservation: string;
  massKg: number;
  /** Combined peak output of the two rear motors (kW). */
  powerKW: number;
  /** Peak torque per rear wheel, after reduction gearing (N·m). */
  wheelTorqueNm: number;
  /** Electronically limited top speed on motor power (m/s). */
  topSpeedLimit: number;
  batteryKWh: number;
  suctionMaxG: number;
  thrusters: ThrusterSpec | null;
  claims: {
    zeroTo60: number;
    zeroTo60Label: string;
    topSpeedMph: number;
    rangeMi: number;
  };
  features: string[];
}

/** Chassis values shared by every trim. */
export const CHASSIS = {
  wheelbase: 2.825, // 111.2 in (claim)
  width: 2.0, // ~79 in (claim)
  length: 4.42,
  height: 1.13,
  trackFront: 1.7,
  trackRear: 1.72,
  comHeight: 0.4,
  frontWeight: 0.43,
  wheelRadiusFront: 0.345,
  wheelRadiusRear: 0.36,
  tireMu: 1.45,
  cdA: 0.5, // m², drag area with wing stowed
  clARoad: 0.35,
  clATrack: 3.4, // "downforce approaches Formula 1 levels" in Track Mode
  wingDragTrack: 0.38,
  airbrakeCdA: 0.55,
  rollingResistance: 0.011,
  motorEfficiency: 0.94,
  regenEfficiency: 0.8,
  auxPowerKW: 0.6,
  fanPowerKW: 45, // at 2 G
} as const;

const SHARED_FEATURES = [
  'Two rear motors, torque vectoring',
  'Multi-mode suction fan, up to 2 G',
  'Active aero, self-adjusting wing',
  'Steer-by-wire yoke',
  'Magnesium, titanium & carbon fiber',
];

export const TRIMS: Record<TrimId, TrimSpec> = {
  performance: {
    id: 'performance',
    name: 'Performance',
    readiness: 'Road ready',
    tagline: 'Active aero and multi-mode suction fans.',
    seats: 2,
    availability: 'Reservation',
    reservation: '$50,000 reservation',
    massKg: 1680,
    powerKW: 1010,
    wheelTorqueNm: 5200,
    topSpeedLimit: 236 * MPH,
    batteryKWh: 76,
    suctionMaxG: 2,
    thrusters: null,
    claims: { zeroTo60: 1.6, zeroTo60Label: '< 1.6 s', topSpeedMph: 230, rangeMi: 300 },
    features: SHARED_FEATURES,
  },
  thrust: {
    id: 'thrust',
    name: 'Thrust',
    readiness: 'Race ready',
    tagline: 'Rear cold-gas thrusters developed with SpaceX.',
    seats: 2,
    availability: 'Limited release',
    reservation: '$250,000 reservation',
    massKg: 1760,
    powerKW: 1010,
    wheelTorqueNm: 5200,
    topSpeedLimit: 236 * MPH,
    batteryKWh: 76,
    suctionMaxG: 2,
    thrusters: {
      rearN: 23800,
      liftN: 0,
      rcsTorque: 0,
      impulseNs: 23800 * 5, // ~5 s of full thrust per fill
      nozzleCount: 4,
      tankLiters: 200,
      pressureBar: 690,
    },
    claims: { zeroTo60: 0.9, zeroTo60Label: '< 0.9 s', topSpeedMph: 230, rangeMi: 300 },
    features: ['4 rear cold-gas nozzles', '200 L N₂ at 10,000 psi', ...SHARED_FEATURES],
  },
  rocket: {
    id: 'rocket',
    name: 'Rocket',
    readiness: 'Air ready',
    tagline: 'Full flight system. Ten perimeter thrusters.',
    seats: 1,
    availability: 'Invite only · off-road use',
    reservation: 'Invite only',
    massKg: 1830,
    powerKW: 1010,
    wheelTorqueNm: 5200,
    topSpeedLimit: 236 * MPH,
    batteryKWh: 76,
    suctionMaxG: 2,
    thrusters: {
      rearN: 47000,
      liftN: 34000,
      rcsTorque: 26000,
      impulseNs: 47000 * 5 * 3, // 600 L total, three times the Thrust tank
      nozzleCount: 10,
      tankLiters: 600,
      pressureBar: 690,
    },
    claims: { zeroTo60: 0.59, zeroTo60Label: '< 0.59 s', topSpeedMph: 230, rangeMi: 300 },
    features: ['10 perimeter thrusters', 'Flight computer & lift', '600 L N₂ in COPVs', ...SHARED_FEATURES],
  },
};

export const EVENT = {
  date: 'October 15, 2026',
  venue: 'SpaceX Rocket Development Facility · McGregor, Texas',
  demoZeroTo60: 0.81,
  production: '2028',
};
