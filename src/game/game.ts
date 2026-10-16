import { Color, Group, SpotLight, Vector3 } from 'three/webgpu';
import type { Engine } from '../render/engine';
import { buildEnvironmentMap, buildLighting, buildSky, type Lighting } from '../render/environment';
import { buildGround } from '../render/ground';
import { buildVenue, type Venue } from '../render/venue';
import { RoadsterModel } from '../models/roadster';
import { ParticlePool } from '../fx/particles';
import { PlumeSet } from '../fx/plumes';
import { Skidmarks } from '../fx/skidmarks';
import { buildWorld } from '../sim/layout';
import { TRIMS, type TrimId } from '../sim/specs';
import { Vehicle, makeControls, SUCTION_MODES } from '../sim/vehicle';
import type { Autopilot } from '../sim/autopilot';
import type { ArchRamp, PhysWorld } from '../sim/world';
import { SIM_DT, runInvertedHold, runLaunch, runRange, runTopSpeed } from '../sim/benchmarks';
import { CameraRig } from './camera';
import { Input } from './input';
import { GameAudio } from './audio';
import { Replay } from './replay';
import { createMode, type GameMode, type ModeContext, type ModeId } from './modes';
import { DEFAULT_SETTINGS, Hud, Menu, Modal, controlsHtml, resultHtml, type Settings } from './ui';

type State = 'menu' | 'play' | 'pause' | 'results' | 'replay';

const SHOWCASE = { x: 0, z: 128, heading: Math.PI * 0.82 };
const MAX_STEPS = 12;

const _v = new Vector3();
const _w = new Vector3();

export class Game {
  state: State = 'menu';
  world!: PhysWorld;
  arch!: ArchRamp;
  venue!: Venue;
  lighting!: Lighting;
  vehicle!: Vehicle;
  ghost!: Vehicle;
  model!: RoadsterModel;
  plumes = new PlumeSet();
  smoke!: ParticlePool;
  glow!: ParticlePool;
  skids = new Skidmarks();
  cam: CameraRig;
  input = new Input(window);
  audio = new GameAudio();
  replay = new Replay(40);
  hud!: Hud;
  menu!: Menu;
  modal!: Modal;
  mode: GameMode = createMode('free');
  autopilot: Autopilot | null = null;
  controls = makeControls();
  settings: Settings = { ...DEFAULT_SETTINGS };
  trim: TrimId = 'rocket';
  private acc = 0;
  private last = performance.now();
  private fps = 60;
  private resultTimer = -1;
  private ratedRange: Record<string, number> = {};
  private padToastCooldown = 0;
  private headlight!: SpotLight;

  constructor(public engine: Engine) {
    this.cam = new CameraRig(engine.camera, engine.canvas);
    try {
      const saved = JSON.parse(localStorage.getItem('roadster.settings') ?? '{}');
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      /* ignore */
    }
  }

  async init(progress: (p: number, msg: string) => void) {
    const { scene, renderer } = this.engine;
    if (this.settings.quality !== this.engine.quality) this.engine.setQuality(this.settings.quality);
    this.engine.dynamicRes = this.settings.dynamicRes;
    progress(0.1, 'Night sky over McGregor');
    scene.background = new Color(0x020306);
    scene.add(buildSky());
    scene.environment = buildEnvironmentMap(renderer);
    scene.environmentIntensity = 0.85;
    this.lighting = buildLighting(scene);
    this.lighting.setShadowSize(this.engine.preset.shadowSize);
    await tick();
    progress(0.25, 'Pouring the test pad');
    scene.add(buildGround());
    const built = buildWorld();
    this.world = built.world;
    this.arch = built.arch;
    await tick();
    progress(0.4, 'Building the arch, the lineup and the stage');
    this.venue = buildVenue(scene, this.arch, this.engine.preset.crowd);
    // showcase light for the menu turntable
    const show = new SpotLight(0xffffff, 26, 40, 0.5, 0.6, 1);
    show.position.set(SHOWCASE.x + 3, 14, SHOWCASE.z - 4);
    show.target.position.set(SHOWCASE.x, 0, SHOWCASE.z);
    scene.add(show, show.target);
    await tick();
    progress(0.6, 'Assembling the Roadster');
    this.vehicle = new Vehicle(TRIMS[this.trim]);
    this.ghost = new Vehicle(TRIMS[this.trim]);
    this.model = new RoadsterModel();
    this.model.setTrim(TRIMS[this.trim]);
    this.plumes.rebuild(this.model.nozzles);
    this.model.root.add(this.plumes.group);
    scene.add(this.model.root);
    this.headlight = new SpotLight(0xe8f0ff, 40, 140, 0.42, 0.55, 1);
    this.headlight.position.set(0, -0.0, -2.1);
    const hlTarget = new Group();
    hlTarget.position.set(0, -0.9, -30);
    this.model.root.add(this.headlight, hlTarget);
    this.headlight.target = hlTarget;
    const n = this.engine.preset.particles;
    this.smoke = new ParticlePool(n, false, true);
    this.glow = new ParticlePool(Math.floor(n / 3), true, false);
    scene.add(this.smoke.mesh, this.glow.mesh, this.skids.mesh);
    this.parkShowcase();
    await tick();
    progress(0.75, 'Compiling shaders');
    // warm up pipelines so the first frames don't hitch
    this.model.update(this.vehicle, 0);
    this.cam.updateMenu(this.vehicle.pos, 0);
    await renderer.compileAsync(scene, this.engine.camera);
    progress(0.9, 'Rating range');
    for (const id of Object.keys(TRIMS) as TrimId[]) this.ratedRange[id] = runRange(id).rangeMi;
    this.buildUi();
    this.hud.ratedRange = this.ratedRange[this.trim];
    progress(1, 'Ready');
    renderer.setAnimationLoop(() => this.frame());
  }

  private buildUi() {
    const ui = document.getElementById('ui')!;
    this.hud = new Hud(ui);
    this.hud.visible = false;
    this.hud.keysVisible = this.settings.showKeys;
    this.menu = new Menu(ui, {
      play: (mode, trim, ap) => this.startMode(mode, trim, ap),
      trimChanged: (t) => this.setTrim(t),
      settings: () => this.showSettings(),
      specs: () => this.showSpecs(),
      controls: () => this.modal.show(controlsHtml(), [{ label: 'Close', primary: true, fn: () => this.modal.close() }]),
    });
    this.menu.setTrim(this.trim);
    this.modal = new Modal(ui);
  }

  // ---------------------------------------------------------------------------

  private setTrim(t: TrimId) {
    this.trim = t;
    this.vehicle.setSpec(TRIMS[t]);
    this.ghost.setSpec(TRIMS[t]);
    if (this.hud) this.hud.ratedRange = this.ratedRange[t] ?? 300;
    this.model.setTrim(TRIMS[t]);
    this.plumes.rebuild(this.model.nozzles);
    if (this.state === 'menu') this.parkShowcase();
  }

  private parkShowcase() {
    this.vehicle.reset(SHOWCASE.x, SHOWCASE.z, SHOWCASE.heading);
    this.vehicle.suctionMode = 'auto';
    this.vehicle.trackMode = false;
  }

  private modeCtx(): ModeContext {
    return {
      vehicle: this.vehicle,
      world: this.world,
      arch: this.arch,
      units: this.settings.units,
      toast: (m, k) => this.hud.toast(m, k),
      cheer: (s) => this.audio.cheer(s),
      beep: (f) => this.audio.beep(f),
      setBoard: (l) => this.venue.setBoard(l),
      setTree: (s) => this.venue.setTree(s),
    };
  }

  startMode(id: ModeId, trim: TrimId, autopilot: boolean) {
    this.audio.start();
    this.audio.setVolume(this.settings.volume);
    if (trim !== this.trim) this.setTrim(trim);
    this.mode = createMode(id);
    this.restart(autopilot);
    this.menu.visible = false;
    this.hud.visible = true;
    this.modal.close();
    this.state = 'play';
    this.engine.canvas.focus();
  }

  private restart(autopilot = this.autopilot !== null) {
    const v = this.vehicle;
    v.refill();
    v.assists.traction = this.settings.traction;
    v.assists.stability = this.settings.stability;
    v.trackMode = false;
    v.suctionMode = 'auto';
    this.mode.start(this.modeCtx());
    this.autopilot = autopilot ? this.mode.autopilot(this.modeCtx()) : null;
    this.model.showDriver = !!this.autopilot;
    this.input.reset();
    this.cam.snap(v);
    this.replay.clear();
    this.skids.clear();
    this.smoke.clear();
    this.glow.clear();
    this.resultTimer = -1;
    this.acc = 0;
    if (id(this.mode) === 'free') this.venue.setTree('off');
    function id(m: GameMode) {
      return m.info.id;
    }
  }

  private toMenu() {
    this.state = 'menu';
    this.modal.close();
    this.hud.visible = false;
    this.menu.visible = true;
    this.autopilot = null;
    this.model.showDriver = false;
    this.parkShowcase();
    this.skids.clear();
  }

  private pause() {
    if (this.state !== 'play') return;
    this.state = 'pause';
    this.modal.show(`<h2>Paused</h2><div class="sub">${this.mode.info.title} · ${this.vehicle.spec.name}</div>`, [
      { label: 'Resume', primary: true, fn: () => this.resume() },
      { label: 'Restart', fn: () => (this.restart(), this.resume()) },
      { label: 'Settings', fn: () => this.showSettings(() => this.pause()) },
      { label: 'Main menu', fn: () => this.toMenu() },
    ]);
    this.modal.onClose = () => {
      if (this.state === 'pause') this.state = 'play';
    };
  }

  private resume() {
    this.state = 'play';
    this.modal.onClose = null;
    this.modal.close();
  }

  private showResults() {
    const r = this.mode.result;
    if (!r) return;
    this.state = 'results';
    this.modal.show(resultHtml(r), [
      { label: 'Retry', primary: true, fn: () => (this.restart(false), this.resume()) },
      { label: 'Watch replay', fn: () => this.startReplay() },
      { label: 'Optimus', fn: () => (this.restart(true), this.resume()) },
      { label: 'Menu', fn: () => this.toMenu() },
    ]);
    this.modal.onClose = () => {
      if (this.state === 'results') this.state = 'play';
    };
  }

  private startReplay() {
    this.modal.onClose = null;
    this.modal.close();
    if (this.replay.start()) {
      this.state = 'replay';
    } else this.state = 'play';
  }

  private stopReplay() {
    this.replay.stop();
    if (this.mode.result) this.showResults();
    else this.state = 'play';
  }

  private saveSettings() {
    localStorage.setItem('roadster.settings', JSON.stringify(this.settings));
  }

  private showSettings(back?: () => void) {
    const s = this.settings;
    const seg = (key: string, opts: [string, string][], cur: string) =>
      `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    this.modal.show(
      `<h2>Settings</h2><div class="sub">Renderer: <b>${this.engine.backend}</b>. Dynamic resolution keeps the frame rate up by lowering render scale when the GPU falls behind.</div>
      <div class="settings-grid">
        <label>Graphics quality</label>${seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']], s.quality)}
        <label>Dynamic resolution</label>${seg('dynamicRes', [['true', 'On'], ['false', 'Off']], String(s.dynamicRes))}
        <label>Units</label>${seg('units', [['mph', 'mph'], ['kmh', 'km/h']], s.units)}
        <label>Traction control</label>${seg('traction', [['true', 'On'], ['false', 'Off']], String(s.traction))}
        <label>Stability control</label>${seg('stability', [['true', 'On'], ['false', 'Off']], String(s.stability))}
        <label>Key hints</label>${seg('showKeys', [['true', 'Show'], ['false', 'Hide']], String(s.showKeys))}
        <label>Volume</label><input type="range" min="0" max="1" step="0.05" value="${s.volume}" data-key="volume">
      </div>`,
      [{ label: 'Done', primary: true, fn: () => (this.modal.close(), back?.()) }],
    );
    this.modal.box.querySelectorAll<HTMLElement>('.seg').forEach((segEl) => {
      segEl.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        b.onclick = () => {
          const key = segEl.dataset.key as keyof Settings;
          const raw = b.dataset.v!;
          const val = raw === 'true' ? true : raw === 'false' ? false : raw;
          (this.settings as unknown as Record<string, unknown>)[key] = val;
          segEl.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          this.applySettings(key);
        };
      });
    });
    const vol = this.modal.box.querySelector<HTMLInputElement>('input[data-key=volume]')!;
    vol.oninput = () => {
      this.settings.volume = parseFloat(vol.value);
      this.audio.setVolume(this.settings.volume);
      this.saveSettings();
    };
  }

  private applySettings(key: keyof Settings) {
    const s = this.settings;
    if (key === 'quality') {
      this.engine.setQuality(s.quality);
      this.lighting.setShadowSize(this.engine.preset.shadowSize);
    }
    if (key === 'dynamicRes') {
      this.engine.dynamicRes = s.dynamicRes;
      if (!s.dynamicRes) {
        this.engine.scale = 1;
        this.engine.resize();
      }
    }
    if (key === 'traction') this.vehicle.assists.traction = s.traction;
    if (key === 'stability') this.vehicle.assists.stability = s.stability;
    if (key === 'showKeys') this.hud.keysVisible = s.showKeys;
    this.saveSettings();
  }

  private async showSpecs() {
    const ids = Object.keys(TRIMS) as TrimId[];
    const rows: string[] = [];
    const render = (running: boolean) =>
      this.modal.show(
        `<h2>Spec verification</h2><div class="sub">Each trim runs through Tesla's published claims in the same physics engine you drive — 240 Hz rigid body, tire slip model, two rear motors, suction fans, aero and cold-gas thrusters. Times use the 1-ft rollout Tesla quotes.</div>
        <table><tr><th>Trim</th><th>0–60 mph</th><th>¼ mile</th><th>Top speed</th><th>Range @65</th><th>Inverted hold</th></tr>${rows.join('')}</table>
        <div class="sub">${running ? '<span class="spin"></span> Running…' : `On-stage demo run: ${'0.81'} s (Thrust reproduces it). Claims from the ${'Oct 15, 2026'} unveiling.`}</div>`,
        [{ label: 'Close', primary: true, fn: () => this.modal.close() }],
      );
    render(true);
    for (const id of ids) {
      await tick();
      const spec = TRIMS[id];
      const l = runLaunch(id);
      const ts = runTopSpeed(id);
      const rg = runRange(id);
      const h = runInvertedHold(id);
      const ok = (b: boolean) => `<span class="${b ? 'pass' : 'fail'}">${b ? '✓' : '✗'}</span>`;
      rows.push(
        `<tr><td>${spec.name}</td><td>${l.zeroTo60.toFixed(2)} s ${ok(l.zeroTo60 < spec.claims.zeroTo60)}<br><span style="color:var(--dim);font-size:11px">claim ${spec.claims.zeroTo60Label}</span></td><td>${l.quarterMile.toFixed(2)} s<br><span style="color:var(--dim);font-size:11px">${l.trapMph.toFixed(0)} mph</span></td><td>${ts.topMph.toFixed(1)} mph ${ok(ts.topMph > 230)}</td><td>${rg.rangeMi.toFixed(0)} mi ${ok(rg.rangeMi > 300)}</td><td>${ok(h.held)}</td></tr>`,
      );
      render(id !== ids[ids.length - 1]);
    }
  }

  // ---------------------------------------------------------------------------

  private handleActions() {
    for (const a of this.input.consumeActions()) {
      if (a === 'pause') {
        if (this.state === 'play') this.pause();
        else if (this.state === 'pause') this.resume();
        else if (this.state === 'replay') this.stopReplay();
        continue;
      }
      if (a === 'mute') {
        this.hud?.toast(this.audio.toggleMute() ? 'Muted' : 'Sound on');
        continue;
      }
      if (this.state === 'replay' && a === 'replay') {
        this.stopReplay();
        continue;
      }
      if (this.state === 'results' && a === 'reset') {
        this.restart(false);
        this.resume();
        continue;
      }
      if (this.state !== 'play') continue;
      const v = this.vehicle;
      switch (a) {
        case 'camera':
          this.cam.cycle();
          break;
        case 'reset':
          this.restart(false);
          break;
        case 'replay':
          this.startReplay();
          break;
        case 'suction': {
          const i = SUCTION_MODES.indexOf(v.suctionMode);
          v.suctionMode = SUCTION_MODES[(i + 1) % SUCTION_MODES.length];
          this.hud.toast(`Suction fans: ${v.suctionMode}`);
          break;
        }
        case 'track':
          v.trackMode = !v.trackMode;
          this.hud.toast(v.trackMode ? 'Track Mode — lowered, wing deployed' : 'Track Mode off');
          break;
        case 'flight':
          v.assists.flight = !v.assists.flight;
          this.hud.toast(`Flight assist ${v.assists.flight ? 'on' : 'off'}`);
          break;
        case 'autopilot':
          if (this.autopilot) {
            this.autopilot = null;
            this.model.showDriver = false;
            this.hud.toast('You have control');
          } else {
            this.restart(true);
          }
          break;
        case 'help':
          this.settings.showKeys = !this.settings.showKeys;
          this.hud.keysVisible = this.settings.showKeys;
          this.saveSettings();
          break;
        case 'hud':
          this.hud.root.style.opacity = this.hud.root.style.opacity === '0' ? '1' : '0';
          break;
      }
    }
  }

  private frame() {
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    const dt = Math.min(0.1, rawDt);
    this.fps += (1 / Math.max(rawDt, 1e-3) - this.fps) * 0.05;
    this.engine.trackFrame(rawDt * 1000, now);
    this.handleActions();

    const v = this.vehicle;
    let shown: Vehicle = v;
    if (this.state === 'menu') {
      this.acc += dt;
      while (this.acc >= SIM_DT) {
        v.step(SIM_DT, this.world, makeControls());
        this.acc -= SIM_DT;
      }
      v.impacts.length = 0;
      this.cam.updateMenu(v.pos, dt);
    } else if (this.state === 'play') {
      this.input.sample(this.controls, v, dt);
      if (this.autopilot && this.input.driveTouched) {
        this.autopilot = null;
        this.model.showDriver = false;
        this.hud.toast('You have control');
      }
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < MAX_STEPS) {
        if (this.autopilot) this.autopilot.update(v, this.controls, SIM_DT);
        v.step(SIM_DT, this.world, this.controls);
        this.acc -= SIM_DT;
        steps++;
      }
      if (steps === MAX_STEPS) this.acc = 0;
      this.mode.update(this.modeCtx(), dt);
      this.replay.record(v, dt);
      this.handlePads(dt);
      this.spawnFx(v, dt, true);
      v.impacts.length = 0;
      this.cam.update(v, dt);
      if (this.mode.result && this.resultTimer < 0) this.resultTimer = 1.6;
      if (this.resultTimer > 0) {
        this.resultTimer -= dt;
        if (this.resultTimer <= 0) this.showResults();
      }
    } else if (this.state === 'replay') {
      const alive = this.replay.play(this.ghost, dt, 1);
      shown = this.ghost;
      this.spawnFx(this.ghost, dt, false);
      this.cam.update(this.ghost, dt, 'cinematic');
      if (!alive) this.stopReplay();
    } else {
      // paused / results: keep the camera alive
      this.cam.update(v, 0);
    }

    this.model.update(shown, dt);
    this.plumes.update(shown.thrustOut.rear, shown.thrustOut.lift, shown.thrustOut.rcs);
    this.smoke.update(this.state === 'pause' ? 0 : dt);
    this.glow.update(this.state === 'pause' ? 0 : dt);
    this.lighting.follow(shown.pos);
    this.headlight.intensity = this.state === 'menu' ? 0 : 40;
    if (this.state !== 'menu') {
      this.hud.update(shown, this.settings, {
        fps: this.fps,
        backend: this.engine.backend,
        scale: this.engine.scale,
        camera: this.state === 'replay' ? 'cinematic' : this.cam.mode,
        mode: this.mode.info.title,
        status: this.mode.status(this.modeCtx()),
        hint: this.mode.info.hint,
        autopilot: !!this.autopilot,
      });
      this.hud.setBanner(this.state === 'replay' ? 'replay' : this.autopilot ? 'autopilot' : 'none', this.replay.progress);
    }
    this.audio.update(shown, this.engine.camera.position.distanceTo(shown.pos), this.state === 'pause' || this.state === 'menu');
    this.engine.render();
  }

  private handlePads(dt: number) {
    const v = this.vehicle;
    this.padToastCooldown -= dt;
    const active = this.world.pads.map((p) => Math.hypot(v.pos.x - p.x, v.pos.z - p.z) < p.radius);
    this.venue.setPadsActive(active);
    if (active.some(Boolean) && v.speed < 3) {
      const t = v.spec.thrusters;
      if (t && v.impulseLeft < t.impulseNs) {
        v.impulseLeft = Math.min(t.impulseNs, v.impulseLeft + t.impulseNs * dt * 0.5);
        if (this.padToastCooldown <= 0) {
          this.hud.toast('Refilling N₂ tanks', 'info');
          this.padToastCooldown = 4;
        }
      }
      v.batteryKWh = Math.min(v.spec.batteryKWh, v.batteryKWh + dt * 2);
    }
  }

  private spawnFx(v: Vehicle, dt: number, live: boolean) {
    // Tire smoke + skid marks
    if (live) {
      for (let i = 0; i < 4; i++) {
        const w = v.wheels[i];
        const slip = w.contact ? w.slipEnergy : 0;
        const strength = Math.min(1, slip / 160000);
        this.skids.add(i, w.contact && strength > 0.12 ? w.point : null, w.normal, w.sideW, i < 2 ? 0.25 : 0.29, strength);
        if (strength > 0.18 && this.smoke.capacityLeft > 10) {
          const nSpawn = Math.min(4, Math.floor(strength * 60 * dt + Math.random()));
          for (let k = 0; k < nSpawn; k++) {
            this.smoke.spawn({
              pos: _v.copy(w.point).addScaledVector(w.normal, 0.15),
              vel: _w.copy(v.vel).multiplyScalar(0.25).add(_v.set((Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2)),
              life: 2.2 + Math.random() * 1.5,
              size0: 0.5,
              size1: 3.8 + strength * 2,
              alpha: 0.35 * strength + 0.1,
              r: 0.42,
              g: 0.42,
              b: 0.44,
              drag: 1.2,
            });
          }
        }
      }
      // sparks & dust from body contacts
      for (const imp of v.impacts) {
        if (imp.scrape > 2 && this.glow.capacityLeft > 4) {
          for (let k = 0; k < 3; k++) {
            this.glow.spawn({
              pos: imp.point,
              vel: _w.copy(v.vel).multiplyScalar(0.6).add(_v.set((Math.random() - 0.5) * 5, Math.random() * 4, (Math.random() - 0.5) * 5)),
              life: 0.35 + Math.random() * 0.4,
              size0: 0.06,
              size1: 0.02,
              alpha: 1,
              r: 6,
              g: 2.4,
              b: 0.6,
              drag: 0.6,
              gravity: 9.8,
            });
          }
        }
        if (imp.impulse > 4000) {
          this.cam.addShake(Math.min(1, imp.impulse / 30000));
          this.audio.impact(Math.min(1, imp.impulse / 25000));
        }
      }
      // hard landings on the wheels
      if (v.maxImpactThisStep > 3) this.cam.addShake(0.3);
    }
    // N₂ vapour from active nozzles
    const out = v.thrustOut;
    if (out.rear + out.lift + out.rcs.lengthSq() > 0.02 && this.smoke.capacityLeft > 20) {
      for (const p of this.plumes.plumes) {
        const inten = p.intensity.value;
        if (inten < 0.05) continue;
        const n = p.nozzle;
        const count = Math.min(3, Math.floor(inten * 40 * dt + Math.random()));
        for (let k = 0; k < count; k++) {
          const wp = _v.copy(n.pos).addScaledVector(n.dir, 0.4).applyQuaternion(v.quat).add(v.pos);
          const dir = _w.copy(n.dir).applyQuaternion(v.quat);
          this.smoke.spawn({
            pos: wp,
            vel: dir.multiplyScalar(22 + Math.random() * 10).add(v.vel).add(_v.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3)),
            life: 0.9 + Math.random() * 0.8,
            size0: 0.3,
            size1: 2.6,
            alpha: 0.28 * inten,
            r: 0.8,
            g: 0.85,
            b: 0.92,
            drag: 3.2,
          });
        }
      }
    }
  }
}

function tick() {
  return new Promise((r) => setTimeout(r, 0));
}
