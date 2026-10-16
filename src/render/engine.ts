import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';
import { float, pass, renderOutput, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  maxPixelRatio: number;
  minScale: number;
  shadowSize: number;
  bloom: boolean;
  aa: 'none' | 'fxaa' | 'smaa';
  particles: number;
  crowd: number;
}

export const PRESETS: Record<Quality, QualityPreset> = {
  low: { maxPixelRatio: 1, minScale: 0.5, shadowSize: 1024, bloom: false, aa: 'fxaa', particles: 400, crowd: 600 },
  medium: { maxPixelRatio: 1.25, minScale: 0.6, shadowSize: 2048, bloom: true, aa: 'fxaa', particles: 900, crowd: 1400 },
  high: { maxPixelRatio: 1.75, minScale: 0.65, shadowSize: 2048, bloom: true, aa: 'smaa', particles: 1600, crowd: 2600 },
  ultra: { maxPixelRatio: 2, minScale: 0.75, shadowSize: 4096, bloom: true, aa: 'smaa', particles: 2400, crowd: 4000 },
};

export class Engine {
  readonly renderer: WebGPURenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(55, 1, 0.1, 9000);
  pipeline!: RenderPipeline;
  backend = 'WebGPU';
  quality: Quality = 'high';
  scale = 1;
  dynamicRes = true;
  readonly bloomStrength = uniform(0.55);
  readonly vignette = uniform(0.32);
  private frameTimes: number[] = [];
  private lastAdjust = 0;
  private onResize: Array<() => void> = [];

  constructor(public canvas: HTMLCanvasElement) {
    const forceWebGL = new URLSearchParams(location.search).has('webgl');
    this.renderer = new WebGPURenderer({ canvas, antialias: false, powerPreference: 'high-performance', alpha: false, forceWebGL });
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
  }

  async init() {
    await this.renderer.init();
    const backend = this.renderer.backend as unknown as { isWebGPUBackend?: boolean };
    this.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL 2';
    this.pipeline = new RenderPipeline(this.renderer);
    this.buildPipeline();
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get preset() {
    return PRESETS[this.quality];
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.scale = 1;
    this.buildPipeline();
    this.resize();
  }

  addResizeListener(fn: () => void) {
    this.onResize.push(fn);
  }

  private buildPipeline() {
    const p = this.preset;
    const scenePass = pass(this.scene, this.camera);
    const color = scenePass.getTextureNode('output');
    let hdr = color;
    if (p.bloom) {
      const b = bloom(color, 0.55, 0.42, 1.0);
      b.strength = this.bloomStrength;
      hdr = color.add(b) as typeof color;
    }
    this.pipeline.outputColorTransform = false;
    let out = renderOutput(hdr);
    if (p.aa === 'fxaa') out = fxaa(out) as unknown as typeof out;
    else if (p.aa === 'smaa') out = smaa(out) as unknown as typeof out;
    const d = uv().sub(0.5).length();
    const vig = float(1).sub(smoothstep(0.35, 0.85, d).mul(this.vignette));
    this.pipeline.outputNode = vec4(out.rgb.mul(vig), 1);
    this.pipeline.needsUpdate = true;
    // shadow map size for all shadow-casting lights is applied by the world builder
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(w, h, false);
    for (const fn of this.onResize) fn();
  }

  pixelRatio() {
    return Math.min(window.devicePixelRatio || 1, this.preset.maxPixelRatio) * this.scale;
  }

  /** Feed real frame time (ms); adjusts render resolution to hold the target frame rate. */
  trackFrame(ms: number, now: number) {
    if (document.hidden || !document.hasFocus()) return; // throttled tabs aren't a GPU signal
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    if (!this.dynamicRes || now - this.lastAdjust < 1500 || this.frameTimes.length < 60) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)];
    let next = this.scale;
    if (p80 > 19.5) next = Math.max(this.preset.minScale, this.scale - 0.1);
    else if (p80 < 15 && this.scale < 1) next = Math.min(1, this.scale + 0.05);
    if (next !== this.scale) {
      this.scale = next;
      this.renderer.setPixelRatio(this.pixelRatio());
      this.renderer.setSize(window.innerWidth, window.innerHeight, false);
      this.frameTimes.length = 0;
    }
    this.lastAdjust = now;
  }

  render() {
    this.pipeline.render();
  }
}
