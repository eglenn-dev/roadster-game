import {
  BackSide,
  BoxGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  MeshBasicNodeMaterial,
  PMREMGenerator,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  SpotLight,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu';
import {
  Fn,
  abs,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  normalize,
  positionLocal,
  pow,
  smoothstep,
  time,
  uniform,
  vec3,
  dot,
  sin,
} from 'three/tsl';

// Night at SpaceX McGregor: clear Texas sky, faint light pollution from Waco
// on the north-east horizon, stars, and a waxing moon.

export const MOON_DIR = new Vector3(-0.45, 0.42, -0.55).normalize();

export function skyColorNode(starAmount: number) {
  const moonDir = uniform(MOON_DIR.clone());
  return Fn(() => {
    const d = normalize(positionLocal);
    const h = d.y;
    const zenith = vec3(0.004, 0.007, 0.018);
    const horizon = vec3(0.035, 0.04, 0.055);
    const base = mix(horizon, zenith, smoothstep(0.0, 0.45, h)).toVar();
    // light pollution glow towards Waco (north-east, -z +x)
    const glowDir = normalize(vec3(0.6, 0.0, -0.8));
    const g = max(dot(normalize(vec3(d.x, 0, d.z)), glowDir), 0);
    base.addAssign(vec3(0.09, 0.05, 0.025).mul(pow(g, 3)).mul(smoothstep(0.25, 0.0, h)));
    // stars
    if (starAmount > 0) {
      const p = d.mul(260);
      const cell = floor(p);
      const f = fract(p).sub(0.5);
      const r = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113)));
      const star = smoothstep(0.08, 0.0, f.length()).mul(smoothstep(0.985, 1.0, r));
      const twinkle = float(0.7).add(sin(time.mul(2.0).add(r.mul(100))).mul(0.3));
      base.addAssign(vec3(0.9, 0.92, 1.0).mul(star).mul(twinkle).mul(smoothstep(0.02, 0.25, h)).mul(starAmount * 2.2));
    }
    // moon
    const md = dot(d, moonDir);
    base.addAssign(vec3(1.0, 0.97, 0.9).mul(smoothstep(0.99955, 0.9997, md)).mul(6));
    base.addAssign(vec3(0.12, 0.13, 0.16).mul(pow(max(md, 0), 64)));
    // below horizon: dark ground silhouette
    base.mulAssign(smoothstep(-0.02, 0.01, h).mul(0.9).add(0.1));
    return abs(base);
  })();
}

export function buildSky(): Mesh {
  const mat = new MeshBasicNodeMaterial({ side: BackSide, depthWrite: false, fog: false });
  mat.colorNode = skyColorNode(1);
  const sky = new Mesh(new SphereGeometry(6000, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

/**
 * Reflection probe: a small scene with the sky plus the floodlight banks and
 * the ground so the white paint and gold glass pick up believable highlights.
 */
export function buildEnvironmentMap(renderer: WebGPURenderer) {
  const env = new Scene();
  const skyMat = new MeshBasicNodeMaterial({ side: BackSide });
  skyMat.colorNode = skyColorNode(0).mul(2.5);
  env.add(new Mesh(new SphereGeometry(50, 32, 16), skyMat));
  const ground = new Mesh(new PlaneGeometry(200, 200), new MeshBasicNodeMaterial({ color: new Color(0.035, 0.034, 0.032) }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.2;
  env.add(ground);
  // floodlight banks around the horizon
  const lampMat = new MeshBasicNodeMaterial({ color: new Color(1, 0.95, 0.85).multiplyScalar(14) });
  const coolMat = new MeshBasicNodeMaterial({ color: new Color(0.75, 0.85, 1).multiplyScalar(6) });
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.2;
    const m = new Mesh(new BoxGeometry(4.5, 1.2, 0.2), i % 3 === 0 ? coolMat : lampMat);
    m.position.set(Math.cos(a) * 30, 9 + (i % 2) * 3, Math.sin(a) * 30);
    m.lookAt(0, 0, 0);
    env.add(m);
  }
  // a broad softbox overhead (stage truss lighting) for long highlights on the roof
  const soft = new Mesh(new PlaneGeometry(30, 6), new MeshBasicNodeMaterial({ color: new Color(0.5, 0.52, 0.56) }));
  soft.position.set(0, 25, 0);
  soft.rotation.x = Math.PI / 2;
  env.add(soft);
  const pmrem = new PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env, 0.02, 0.1, 200);
  pmrem.dispose();
  return rt.texture;
}

export interface Lighting {
  key: SpotLight;
  hemi: HemisphereLight;
  setShadowSize(n: number): void;
  follow(target: Vector3): void;
}

export function buildLighting(scene: Scene): Lighting {
  scene.fog = new FogExp2(0x0b0d12, 0.00042);
  const hemi = new HemisphereLight(0x8a9bc0, 0x2a2420, 0.2);
  scene.add(hemi);
  // dim moonlight for global fill
  const moon = new DirectionalLight(0xaabbdd, 0.16);
  moon.position.copy(MOON_DIR).multiplyScalar(100);
  scene.add(moon);
  // "Key": a broadcast follow-spot tracking the car. It gives the night scene a
  // pool of light around the action plus crisp shadows wherever the car goes.
  const key = new SpotLight(0xfff1dc, 2.4, 0, 0.52, 0.75, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 20;
  key.shadow.camera.far = 140;
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const offset = new Vector3(-24, 52, 30);
  return {
    key,
    hemi,
    setShadowSize(n: number) {
      key.shadow.mapSize.set(n, n);
      key.shadow.map?.dispose();
      key.shadow.map = null as never;
    },
    follow(target: Vector3) {
      key.target.position.copy(target);
      key.position.copy(target).add(offset);
    },
  };
}
