import { BufferAttribute, BufferGeometry, Mesh, MeshBasicNodeMaterial, Vector3 } from 'three/webgpu';
import { attribute, vec3 } from 'three/tsl';

/** Ring buffer of tire-mark quads laid on the surface the tire is touching. */
export class Skidmarks {
  readonly mesh: Mesh;
  private readonly max: number;
  private next = 0;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly geo: BufferGeometry;
  private readonly last: (Vector3 | null)[] = [null, null, null, null];
  private readonly lastSide: Vector3[] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];

  constructor(max = 3000) {
    this.max = max;
    this.pos = new Float32Array(max * 4 * 3);
    this.alpha = new Float32Array(max * 4);
    const idx = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.pos, 3));
    geo.setAttribute('skidAlpha', new BufferAttribute(this.alpha, 1));
    geo.setIndex(new BufferAttribute(idx, 1));
    this.geo = geo;
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.colorNode = vec3(0.012, 0.012, 0.012);
    mat.opacityNode = attribute('skidAlpha', 'float');
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = -2;
    mat.polygonOffsetUnits = -2;
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Call per wheel per frame. `strength` 0..1; null contact breaks the strip. */
  add(wheel: number, contact: Vector3 | null, normal: Vector3, side: Vector3, width: number, strength: number) {
    if (!contact || strength < 0.05) {
      this.last[wheel] = null;
      return;
    }
    const prev = this.last[wheel];
    const p = contact.clone().addScaledVector(normal, 0.015);
    const s = side.clone().multiplyScalar(width / 2);
    if (prev && prev.distanceToSquared(p) > 0.04 && prev.distanceToSquared(p) < 9) {
      const i = this.next;
      this.next = (this.next + 1) % this.max;
      const ps = this.lastSide[wheel];
      const a = Math.min(0.85, strength);
      const set = (k: number, v: Vector3, al: number) => {
        this.pos[(i * 4 + k) * 3] = v.x;
        this.pos[(i * 4 + k) * 3 + 1] = v.y;
        this.pos[(i * 4 + k) * 3 + 2] = v.z;
        this.alpha[i * 4 + k] = al;
      };
      set(0, prev.clone().sub(ps), a);
      set(1, prev.clone().add(ps), a);
      set(2, p.clone().sub(s), a);
      set(3, p.clone().add(s), a);
      const pa = this.geo.getAttribute('position') as BufferAttribute;
      const aa = this.geo.getAttribute('skidAlpha') as BufferAttribute;
      pa.needsUpdate = true;
      aa.needsUpdate = true;
      this.last[wheel] = p;
      this.lastSide[wheel].copy(s);
    } else if (!prev || prev.distanceToSquared(p) >= 9) {
      this.last[wheel] = p;
      this.lastSide[wheel].copy(s);
    }
  }

  clear() {
    this.alpha.fill(0);
    (this.geo.getAttribute('skidAlpha') as BufferAttribute).needsUpdate = true;
    this.last.fill(null);
  }
}
