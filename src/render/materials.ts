import {
  Color,
  DoubleSide,
  Material,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  Object3D,
  BufferGeometry as BufferGeometryCtor,
  Float32BufferAttribute,
  type BufferGeometry,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function paint(hex: number, opts: { roughness?: number; metalness?: number; clearcoat?: number } = {}) {
  return new MeshPhysicalNodeMaterial({
    color: new Color(hex),
    roughness: opts.roughness ?? 0.3,
    metalness: opts.metalness ?? 0.05,
    clearcoat: opts.clearcoat ?? 1,
    clearcoatRoughness: 0.035,
  });
}

export function standard(hex: number, roughness = 0.6, metalness = 0, extra: Partial<MeshStandardNodeMaterial> = {}) {
  const m = new MeshStandardNodeMaterial({ color: new Color(hex), roughness, metalness });
  Object.assign(m, extra);
  return m;
}

export function emissive(hex: number, intensity = 1) {
  const m = new MeshStandardNodeMaterial({ color: new Color(0x000000), roughness: 0.4, metalness: 0 });
  m.emissive = new Color(hex);
  m.emissiveIntensity = intensity;
  return m;
}

export function unlit(hex: number, intensity = 1, transparent = false, opacity = 1) {
  const m = new MeshBasicNodeMaterial({ color: new Color(hex).multiplyScalar(intensity), transparent, opacity });
  if (transparent) m.depthWrite = false;
  return m;
}

export function goldGlass() {
  return new MeshPhysicalNodeMaterial({
    color: new Color(0xd9b46a),
    metalness: 0.92,
    roughness: 0.05,
    transparent: true,
    opacity: 0.86,
    side: DoubleSide,
  });
}

export function darkGlass() {
  return new MeshPhysicalNodeMaterial({ color: new Color(0x0b0d10), metalness: 0.4, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.02 });
}

export const SHARED = {
  trim: standard(0x0b0b0d, 0.5, 0.25),
  rubber: standard(0x121212, 0.88, 0),
  carbon: standard(0x151618, 0.32, 0.4),
  graphite: standard(0x2c2e33, 0.32, 0.85),
  chrome: standard(0xd9dce0, 0.12, 1),
  steel: standard(0x8d939b, 0.42, 0.9),
  darkSteel: standard(0x3c4046, 0.55, 0.8),
  caliper: standard(0xb9bcc2, 0.35, 0.7),
  interior: standard(0x17171a, 0.75, 0),
  black: standard(0x050505, 0.9, 0),
};

/**
 * Merge every mesh under `root` into one mesh per material (world transforms
 * baked in). Used for static props to keep draw calls low.
 */
export function bakeStatic(root: Object3D, castShadow = true, receiveShadow = true): Object3D {
  root.updateMatrixWorld(true);
  const byMat = new Map<Material, BufferGeometry[]>();
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !mesh.visible) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    // normalise attributes so geometries can merge
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const parts: [Material, BufferGeometry][] = [];
    if (Array.isArray(mesh.material)) {
      for (const grp of g.groups) {
        const mat = mesh.material[grp.materialIndex ?? 0];
        if (mat) parts.push([mat, subGeometry(g, grp.start, grp.count)]);
      }
    } else {
      const ng = g.index ? g.toNonIndexed() : g;
      ng.clearGroups();
      parts.push([mesh.material, ng]);
    }
    for (const [mat, geo] of parts) {
      if (!byMat.has(mat)) byMat.set(mat, []);
      byMat.get(mat)!.push(geo);
    }
  });
  const out = new Object3D();
  for (const [mat, geos] of byMat) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const m = new Mesh(merged, mat);
    m.castShadow = castShadow;
    m.receiveShadow = receiveShadow;
    m.matrixAutoUpdate = false;
    out.add(m);
  }
  out.matrixAutoUpdate = false;
  return out;
}

function subGeometry(g: BufferGeometry, start: number, count: number): BufferGeometry {
  const src = g.index ? g.toNonIndexed() : g;
  const out = new BufferGeometryCtor();
  for (const name of ['position', 'normal']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const arr = (a.array as Float32Array).slice(start * a.itemSize, (start + count) * a.itemSize);
    out.setAttribute(name, new Float32BufferAttribute(arr, a.itemSize));
  }
  return out;
}

/** Split a grouped geometry into meshes for an array of materials. */
export function groupedMesh(geo: BufferGeometry, mats: Material[]): Mesh {
  const m = new Mesh(geo, mats);
  return m;
}
