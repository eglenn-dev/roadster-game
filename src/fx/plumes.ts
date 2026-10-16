import { AdditiveBlending, CylinderGeometry, DoubleSide, Group, Mesh, MeshBasicNodeMaterial, Quaternion, Vector3 } from 'three/webgpu';
import { Fn, abs, dot, float, mx_noise_float, normalView, positionViewDirection, pow, sin, smoothstep, time, uniform, uv, vec3 } from 'three/tsl';
import type { Nozzle } from '../models/roadster';

// Cold-gas (nitrogen) jets: mostly transparent, with a bright condensing core,
// expansion "shock diamonds" near the nozzle and turbulent edges.

export class Plume {
  readonly mesh: Mesh;
  readonly intensity = uniform(0);
  constructor(public nozzle: Nozzle) {
    const len = nozzle.kind === 'side' ? 1.2 : nozzle.kind === 'lift' ? 2.4 : 3.2;
    const geo = new CylinderGeometry(nozzle.size * 0.9, nozzle.size * (nozzle.kind === 'side' ? 5 : 7), len, 20, 12, true);
    geo.translate(0, -len / 2, 0);
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: DoubleSide, blending: AdditiveBlending });
    const I = this.intensity;
    mat.colorNode = Fn(() => {
      const s = float(1).sub(uv().y); // 0 at nozzle .. 1 at tail
      const edge = pow(abs(dot(normalView, positionViewDirection)), 1.6);
      const n = mx_noise_float(vec3(uv().x.mul(8), s.mul(6).sub(time.mul(14)), time.mul(3)));
      const diamonds = smoothstep(0.55, 1.0, sin(s.mul(42).sub(time.mul(5)))).mul(smoothstep(0.45, 0.0, s));
      const core = smoothstep(0.7, 0.0, s).mul(edge);
      const body = pow(float(1).sub(s), 1.8).mul(edge.mul(0.6).add(0.4)).mul(n.mul(0.5).add(0.7));
      const glow = core.mul(1.6).add(body.mul(0.9)).add(diamonds.mul(2.2));
      return vec3(0.72, 0.84, 1.0).mul(glow).mul(I).mul(1.6);
    })();
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    // orient -Y along the exhaust direction
    this.mesh.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), nozzle.dir));
    this.mesh.position.copy(nozzle.pos);
    this.mesh.visible = false;
  }

  set(value: number, flicker: number) {
    const v = Math.max(0, value);
    this.intensity.value = v * (0.85 + flicker * 0.3);
    this.mesh.visible = v > 0.01;
    const sc = 0.5 + 0.5 * Math.min(1, v);
    this.mesh.scale.set(1, sc * (0.92 + flicker * 0.16), 1);
  }
}

export class PlumeSet {
  readonly group = new Group();
  plumes: Plume[] = [];

  rebuild(nozzles: Nozzle[]) {
    this.group.clear();
    this.plumes = nozzles.map((n) => new Plume(n));
    for (const p of this.plumes) this.group.add(p.mesh);
  }

  /**
   * Drive the visuals from thruster outputs. `rcs` is the normalised local
   * torque command (x pitch, y yaw, z roll).
   */
  update(rear: number, lift: number, rcs: Vector3) {
    for (const p of this.plumes) {
      const f = Math.random();
      const n = p.nozzle;
      if (n.kind === 'rear') p.set(rear, f);
      else if (n.kind === 'lift') {
        // corner nozzles also provide pitch and roll authority
        const pitch = rcs.x * (n.sz < 0 ? 1 : -1);
        const roll = rcs.z * (n.sx < 0 ? -1 : 1);
        p.set(Math.min(1, lift + Math.max(0, pitch) * 0.7 + Math.max(0, roll) * 0.7), f);
      } else {
        // side nozzles at the nose provide yaw
        const yaw = rcs.y * (n.sx < 0 ? 1 : -1);
        p.set(Math.max(0, yaw), f);
      }
    }
  }
}
