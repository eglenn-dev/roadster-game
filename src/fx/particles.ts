import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshBasicNodeMaterial,
  NormalBlending,
  PlaneGeometry,
  Vector3,
} from 'three/webgpu';
import {
  Fn,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  instancedDynamicBufferAttribute,
  mx_noise_float,
  positionLocal,
  smoothstep,
  uv,
  vec3,
  vec4,
} from 'three/tsl';

export interface SpawnOpts {
  pos: Vector3;
  vel: Vector3;
  life: number;
  size0: number;
  size1: number;
  alpha: number;
  r: number;
  g: number;
  b: number;
  drag?: number;
  gravity?: number;
}

/**
 * CPU-simulated, GPU-billboarded particle pool. One draw call per pool; the
 * vertex shader expands each instance into a camera-facing quad.
 */
export class ParticlePool {
  readonly mesh: Mesh;
  private readonly max: number;
  private count = 0;
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly col: Float32Array;
  private readonly drag: Float32Array;
  private readonly grav: Float32Array;
  private readonly aOffset: InstancedBufferAttribute;
  private readonly aData: InstancedBufferAttribute; // size, alpha, seed, ageFrac
  private readonly aColor: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;

  constructor(max: number, additive: boolean, soft = true) {
    this.max = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.col = new Float32Array(max * 3);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    const base = new PlaneGeometry(1, 1);
    const geo = new InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.aOffset = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.aData = new InstancedBufferAttribute(new Float32Array(max * 4), 4);
    this.aColor = new InstancedBufferAttribute(new Float32Array(max * 3), 3);
    geo.setAttribute('aOffset', this.aOffset);
    geo.setAttribute('aData', this.aData);
    geo.setAttribute('aColor', this.aColor);
    geo.instanceCount = 0;
    this.geo = geo;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const off: any = instancedDynamicBufferAttribute(this.aOffset, 'vec3');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = instancedDynamicBufferAttribute(this.aData, 'vec4');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const color: any = instancedDynamicBufferAttribute(this.aColor, 'vec3');
    const mat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    mat.blending = additive ? AdditiveBlending : NormalBlending;
    mat.vertexNode = Fn(() => {
      const vp = cameraViewMatrix.mul(vec4(off, 1)).toVar();
      vp.xy.addAssign(positionLocal.xy.mul(data.x));
      return cameraProjectionMatrix.mul(vp);
    })();
    mat.colorNode = Fn(() => color)();
    mat.opacityNode = Fn(() => {
      const d = uv().sub(0.5).length().mul(2);
      let a = float(1).sub(smoothstep(soft ? 0.2 : 0.6, 1.0, d));
      if (soft) {
        const n = mx_noise_float(vec3(uv().mul(3.2), data.z.mul(17).add(data.w.mul(1.5))));
        a = a.mul(n.mul(0.45).add(0.75));
      }
      return a.mul(data.y);
    })();
    this.mesh = new Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
  }

  spawn(o: SpawnOpts) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.p[i * 3] = o.pos.x;
    this.p[i * 3 + 1] = o.pos.y;
    this.p[i * 3 + 2] = o.pos.z;
    this.v[i * 3] = o.vel.x;
    this.v[i * 3 + 1] = o.vel.y;
    this.v[i * 3 + 2] = o.vel.z;
    this.age[i] = 0;
    this.life[i] = o.life;
    this.s0[i] = o.size0;
    this.s1[i] = o.size1;
    this.a0[i] = o.alpha;
    this.col[i * 3] = o.r;
    this.col[i * 3 + 1] = o.g;
    this.col[i * 3 + 2] = o.b;
    this.drag[i] = o.drag ?? 1.5;
    this.grav[i] = o.gravity ?? 0;
    this.aData.array[i * 4 + 2] = Math.random();
  }

  get capacityLeft() {
    return this.max - this.count;
  }

  update(dt: number) {
    let i = 0;
    const off = this.aOffset.array as Float32Array;
    const data = this.aData.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // swap-remove
        const j = --this.count;
        if (i !== j) this.copy(j, i);
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k;
      this.v[i * 3 + 1] = this.v[i * 3 + 1] * k - this.grav[i] * dt;
      this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt;
      this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt;
      this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      if (this.p[i * 3 + 1] < 0.02 && this.grav[i] > 0) {
        this.p[i * 3 + 1] = 0.02;
        this.v[i * 3 + 1] *= -0.3;
      }
      const t = this.age[i] / this.life[i];
      off[i * 3] = this.p[i * 3];
      off[i * 3 + 1] = this.p[i * 3 + 1];
      off[i * 3 + 2] = this.p[i * 3 + 2];
      data[i * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      data[i * 4 + 1] = this.a0[i] * (1 - t) * Math.min(1, t * 8 + 0.2);
      data[i * 4 + 3] = t;
      col[i * 3] = this.col[i * 3];
      col[i * 3 + 1] = this.col[i * 3 + 1];
      col[i * 3 + 2] = this.col[i * 3 + 2];
      i++;
    }
    this.geo.instanceCount = this.count;
    this.aOffset.needsUpdate = true;
    this.aData.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aOffset.clearUpdateRanges();
    this.aOffset.addUpdateRange(0, this.count * 3);
    this.aData.clearUpdateRanges();
    this.aData.addUpdateRange(0, this.count * 4);
    this.aColor.clearUpdateRanges();
    this.aColor.addUpdateRange(0, this.count * 3);
  }

  private copy(from: number, to: number) {
    for (let c = 0; c < 3; c++) {
      this.p[to * 3 + c] = this.p[from * 3 + c];
      this.v[to * 3 + c] = this.v[from * 3 + c];
      this.col[to * 3 + c] = this.col[from * 3 + c];
    }
    this.age[to] = this.age[from];
    this.life[to] = this.life[from];
    this.s0[to] = this.s0[from];
    this.s1[to] = this.s1[from];
    this.a0[to] = this.a0[from];
    this.drag[to] = this.drag[from];
    this.grav[to] = this.grav[from];
    this.aData.array[to * 4 + 2] = this.aData.array[from * 4 + 2];
  }

  clear() {
    this.count = 0;
    this.geo.instanceCount = 0;
  }
}
