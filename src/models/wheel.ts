import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshStandardNodeMaterial,
  Color,
  Vector2,
  type Material,
} from 'three/webgpu';
import { SHARED } from '../render/materials';

export interface WheelParts {
  root: Group; // at hub; steer about Y
  spin: Group; // rotates about X
  discMat: MeshStandardNodeMaterial | null;
}

export interface WheelOptions {
  radius: number;
  width: number;
  rimRadius: number;
  spokes?: number;
  rimMat?: Material;
  spokeMat?: Material;
  detail?: 'high' | 'low';
  /** +1 for a wheel on the right side (face points +X), -1 for left. */
  side: number;
  brakes?: boolean;
}

function tireGeometry(R: number, W: number, rimR: number, segs: number, grooves: boolean) {
  const h = W / 2;
  const pts: Vector2[] = [];
  const side = (sgn: number) => {
    const p: [number, number][] = [
      [rimR - 0.005, sgn * (h - 0.02)],
      [rimR + 0.02, sgn * h],
      [rimR + (R - rimR) * 0.55, sgn * (h + 0.006)],
      [R - 0.035, sgn * (h - 0.005)],
      [R - 0.01, sgn * (h - 0.03)],
    ];
    return sgn < 0 ? p : p.reverse();
  };
  for (const [r, y] of side(-1)) pts.push(new Vector2(r, y));
  if (grooves) {
    const g = [-0.6, -0.2, 0.2, 0.6];
    pts.push(new Vector2(R, -h + 0.045));
    for (const gx of g) {
      const y = gx * h * 0.9;
      pts.push(new Vector2(R, y - 0.012), new Vector2(R - 0.008, y - 0.008), new Vector2(R - 0.008, y + 0.008), new Vector2(R, y + 0.012));
    }
    pts.push(new Vector2(R, h - 0.045));
  } else {
    pts.push(new Vector2(R, -h + 0.04), new Vector2(R, h - 0.04));
  }
  for (const [r, y] of side(1)) pts.push(new Vector2(r, y));
  const geo = new LatheGeometry(pts, segs);
  geo.rotateZ(-Math.PI / 2); // axis Y → +X
  return geo;
}

export function buildWheel(o: WheelOptions): WheelParts {
  const high = (o.detail ?? 'high') === 'high';
  const root = new Group();
  const spin = new Group();
  root.add(spin);
  const segs = high ? 56 : 24;

  const tire = new Mesh(tireGeometry(o.radius, o.width, o.rimRadius, segs, high), SHARED.rubber);
  tire.castShadow = true;
  spin.add(tire);

  const rimMat = o.rimMat ?? SHARED.graphite;
  const spokeMat = o.spokeMat ?? rimMat;
  const face = o.side; // outward x direction
  const h = o.width / 2;

  // Rim barrel and lip
  const barrelPts = [
    new Vector2(o.rimRadius * 0.98, -h + 0.01),
    new Vector2(o.rimRadius, -h + 0.03),
    new Vector2(o.rimRadius * 0.93, -h + 0.06),
    new Vector2(o.rimRadius * 0.9, h - 0.05),
    new Vector2(o.rimRadius, h - 0.03),
    new Vector2(o.rimRadius * 0.98, h - 0.01),
  ];
  const barrel = new LatheGeometry(barrelPts.reverse(), segs); // normals face the axle
  barrel.rotateZ(-Math.PI / 2);
  spin.add(new Mesh(barrel, rimMat));

  if (high) {
    const lip = new Mesh(new CylinderGeometry(o.rimRadius * 1.0, o.rimRadius * 1.0, 0.012, segs, 1, true), SHARED.chrome);
    lip.rotation.z = Math.PI / 2;
    lip.position.x = face * (h - 0.025);
    spin.add(lip);
  }

  // Face: concave dish with aero spokes
  const dishPts = [
    new Vector2(0.0, face * (h - 0.035)),
    new Vector2(o.rimRadius * 0.25, face * (h - 0.04)),
    new Vector2(o.rimRadius * 0.3, face * (h - 0.07)),
    new Vector2(o.rimRadius * 0.92, face * (h - 0.09)),
  ];
  const dish = new LatheGeometry(face > 0 ? dishPts.slice().reverse() : dishPts, segs);
  dish.rotateZ(-Math.PI / 2);
  spin.add(new Mesh(dish, SHARED.darkSteel));

  const spokes = o.spokes ?? 10;
  const spokeLen = o.rimRadius * 0.72;
  const spokeGeo = new BoxGeometry(0.03, spokeLen, high ? 0.045 : 0.06);
  spokeGeo.translate(0, o.rimRadius * 0.24 + spokeLen / 2, 0);
  for (let i = 0; i < spokes; i++) {
    const s = new Mesh(spokeGeo, spokeMat);
    s.position.x = face * (h - 0.05);
    s.rotation.x = (i / spokes) * Math.PI * 2;
    s.rotation.y = face * 0.12; // slight turbine twist
    spin.add(s);
  }
  const cap = new Mesh(new CylinderGeometry(o.rimRadius * 0.22, o.rimRadius * 0.24, 0.03, 24), spokeMat);
  cap.rotation.z = Math.PI / 2;
  cap.position.x = face * (h - 0.03);
  spin.add(cap);

  let discMat: MeshStandardNodeMaterial | null = null;
  if (o.brakes !== false && high) {
    discMat = new MeshStandardNodeMaterial({ color: new Color(0x4b4d52), roughness: 0.4, metalness: 0.9 });
    discMat.emissive = new Color(0xff3a08);
    discMat.emissiveIntensity = 0;
    const disc = new Mesh(new CylinderGeometry(o.rimRadius * 0.86, o.rimRadius * 0.86, 0.032, 40), discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = face * (h - 0.16);
    spin.add(disc);
    // caliper stays put (not in spin), sits at the rear-top of the disc
    const cal = new Mesh(new BoxGeometry(0.07, o.rimRadius * 0.5, 0.13), SHARED.caliper);
    cal.position.set(face * (h - 0.14), o.rimRadius * 0.55, o.rimRadius * 0.4);
    cal.rotation.x = -0.6;
    root.add(cal);
  }
  return { root, spin, discMat };
}
