import { CAMERA_LABEL, type CameraMode } from './camera';
import { MODES, type ModeId, type ModeResult, type ModeStatus } from './modes';
import { EVENT, MPH, TRIMS, type TrimId } from '../sim/specs';
import type { Vehicle } from '../sim/vehicle';
import type { Quality } from '../render/engine';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export interface Settings {
  units: 'mph' | 'kmh';
  quality: Quality;
  dynamicRes: boolean;
  volume: number;
  showKeys: boolean;
  traction: boolean;
  stability: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  units: 'mph',
  quality: 'high',
  dynamicRes: true,
  volume: 0.8,
  showKeys: true,
  traction: true,
  stability: true,
};

// ---------------------------------------------------------------------------

export class Hud {
  readonly root = el('div', 'hud');
  private speedNum = el('div', 'num', '0');
  private speedUnit = el('div', 'unit', 'mph');
  private gears = el('div', 'gears');
  private regen = el('div', 'regen');
  private drive = el('div', 'drive');
  private kw = el('div', 'kw');
  private gcanvas = el('canvas');
  private gvals = el('div', 'vals');
  private systems = el('div', 'systems panel');
  private topleft = el('div', 'topleft');
  private topright = el('div', 'topright');
  private objective = el('div', 'objective panel');
  private big = el('div', 'bigtime');
  private toasts = el('div', 'toasts');
  private banner = el('div', 'banner panel hidden');
  private keys = el('div', 'keys panel');
  ratedRange = 300;
  private gtrail: [number, number][] = [];
  private lastSystems = '';
  private lastObjective = '';

  constructor(parent: HTMLElement) {
    const speedo = el('div', 'speedo panel');
    const power = el('div', 'power');
    power.append(this.regen, this.drive, el('div', 'zero'));
    speedo.append(this.speedNum, this.speedUnit, power, this.kw, this.gears);
    const gm = el('div', 'gmeter panel');
    this.gcanvas.width = 232;
    this.gcanvas.height = 232;
    gm.append(this.gcanvas, this.gvals);
    this.keys.innerHTML = [
      ['W S', 'Drive / brake · reverse'],
      ['A D', 'Steer'],
      ['W+S', 'Launch control'],
      ['SPACE', 'Lift thrusters · drop'],
      ['SHIFT', 'Rear thrusters'],
      ['Q E', 'Roll (air)'],
      ['F', 'Suction fan mode'],
      ['T', 'Track Mode'],
      ['C', 'Camera'],
      ['R', 'Restart'],
      ['V', 'Replay'],
      ['O', 'Optimus autopilot'],
      ['H', 'Hide keys'],
    ]
      .map(([k, d]) => `<div><kbd>${k}</kbd>${d}</div>`)
      .join('');
    this.root.append(speedo, gm, this.systems, this.topleft, this.topright, this.objective, this.big, this.toasts, this.banner, this.keys);
    parent.append(this.root);
  }

  set visible(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  set keysVisible(v: boolean) {
    this.keys.classList.toggle('hidden', !v);
  }

  toast(msg: string, kind: 'good' | 'bad' | 'info' = 'info') {
    const t = el('div', `toast ${kind}`, msg);
    this.toasts.append(t);
    setTimeout(() => t.remove(), 2700);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
  }

  setBanner(kind: 'none' | 'autopilot' | 'replay', progress = 0) {
    this.root.classList.toggle('replaying', kind === 'replay');
    if (kind === 'none') {
      this.banner.classList.add('hidden');
      return;
    }
    this.banner.classList.remove('hidden');
    this.banner.classList.toggle('replay', kind === 'replay');
    if (kind === 'autopilot') this.banner.innerHTML = '<span class="dot"></span>Optimus is driving · press any drive key to take over';
    else this.banner.innerHTML = `<span class="dot"></span>Replay · V to exit <span class="prog"><div style="width:${(progress * 100).toFixed(1)}%"></div></span>`;
  }

  update(v: Vehicle, s: Settings, info: { fps: number; backend: string; scale: number; camera: CameraMode; mode: string; status: ModeStatus | null; hint: string; autopilot: boolean }) {
    const mph = s.units === 'mph';
    const spd = Math.abs(v.fwdSpeed) * (mph ? 1 / MPH : 3.6);
    this.speedNum.textContent = spd < 0.5 ? '0' : spd.toFixed(0);
    this.speedUnit.textContent = mph ? 'mph' : 'km/h';
    const gear = v.reverse ? 'R' : v.speed < 0.2 && v.launchArmed ? 'L' : 'D';
    this.gears.innerHTML = ['P', 'R', 'N', 'D'].map((g) => (g === gear || (gear === 'L' && g === 'D') ? `<b>${g}</b>` : g)).join(' ') + (v.launchArmed ? ' · <b>LAUNCH</b>' : '');
    const p = v.powerKW;
    const maxP = v.spec.powerKW;
    this.drive.style.width = `${Math.max(0, Math.min(1, p / maxP)) * 70}%`;
    this.regen.style.width = `${Math.max(0, Math.min(1, -p / 250)) * 30}%`;
    this.kw.textContent = `${p >= 0 ? '' : '−'}${Math.abs(p).toFixed(0)} kW`;

    this.drawG(v);

    const t = v.spec.thrusters;
    const fanMode = v.suctionMode === 'auto' ? 'Auto' : v.suctionMode[0].toUpperCase() + v.suctionMode.slice(1);
    const rangeMi = (v.batteryKWh / v.spec.batteryKWh) * this.ratedRange;
    const wingState = v.airbrake > 0.3 ? 'Airbrake' : v.wingHeight > 0.5 ? (v.wing > 0.5 ? 'High downforce' : 'Raised') : 'Stowed';
    const sysHtml = `
      <div class="sys-row"><span>Suction fans · ${fanMode}</span><b>${v.suctionLevel.toFixed(1)} G</b></div>
      <div class="meter fan"><div style="width:${(v.suctionLevel / 2) * 100}%"></div></div>
      ${
        t
          ? `<div class="sys-row"><span>N₂ · ${t.tankLiters} L @ ${t.pressureBar} bar</span><b>${Math.round(v.tankFraction * 100)}%</b></div>
      <div class="meter n2"><div style="width:${v.tankFraction * 100}%"></div></div>`
          : ''
      }
      <div class="sys-row"><span>Battery · ${mph ? rangeMi.toFixed(0) + ' mi' : (rangeMi * 1.609).toFixed(0) + ' km'}</span><b>${((v.batteryKWh / v.spec.batteryKWh) * 100).toFixed(0)}%</b></div>
      <div class="meter batt"><div style="width:${(v.batteryKWh / v.spec.batteryKWh) * 100}%"></div></div>
      <div class="sys-row"><span>Wing</span><b>${wingState}</b></div>
      <div class="chips">
        <span class="chip ${v.trackMode ? 'on' : ''}">Track</span>
        <span class="chip ${v.assists.traction ? 'on' : ''}">TC</span>
        ${v.canFly ? `<span class="chip ${v.assists.flight ? 'on' : 'warn'}">Flight assist</span>` : ''}
        ${v.thrustOut.rear > 0.05 || v.thrustOut.lift > 0.05 ? '<span class="chip on" style="background:var(--n2);border-color:var(--n2)">Thrust</span>' : ''}
      </div>`;
    if (sysHtml !== this.lastSystems) {
      this.systems.innerHTML = sysHtml;
      this.lastSystems = sysHtml;
    }

    this.topleft.innerHTML = `<div class="trim">Roadster · ${v.spec.name}</div><div class="sub">${info.mode} · ${CAMERA_LABEL[info.camera]} camera</div>`;
    this.topright.innerHTML = `<span class="badge ${info.backend === 'WebGPU' ? '' : 'gl'}">${info.backend}</span><br>${info.fps.toFixed(0)} fps · ${(info.scale * 100).toFixed(0)}% res`;

    const st = info.status;
    if (st && (st.steps.length || st.objective)) {
      const html = `<div class="title">${info.mode}</div><div class="goal">${st.objective}</div>${
        st.steps.length ? `<ul>${st.steps.map((x) => `<li class="${x.done ? 'done' : x.active ? 'active' : ''}">${x.label}</li>`).join('')}</ul>` : ''
      }<div class="hint">${info.hint}</div>`;
      if (html !== this.lastObjective) {
        this.objective.innerHTML = html;
        this.lastObjective = html;
      }
      this.objective.classList.remove('hidden');
    } else this.objective.classList.add('hidden');
    if (st?.big) {
      this.big.innerHTML = `<div class="v">${st.big}</div><div class="l">${st.bigLabel ?? ''}</div>`;
      this.big.classList.remove('hidden');
    } else this.big.classList.add('hidden');
  }

  private drawG(v: Vehicle) {
    const c = this.gcanvas.getContext('2d')!;
    const W = 232;
    const R = 104;
    c.clearRect(0, 0, W, W);
    c.strokeStyle = 'rgba(255,255,255,0.14)';
    c.lineWidth = 2;
    for (const r of [R, R * 0.5]) {
      c.beginPath();
      c.arc(W / 2, W / 2, r, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(W / 2 - R, W / 2);
    c.lineTo(W / 2 + R, W / 2);
    c.moveTo(W / 2, W / 2 - R);
    c.lineTo(W / 2, W / 2 + R);
    c.stroke();
    const scale = R / 4; // 4 G full scale
    const gx = Math.max(-4, Math.min(4, v.gLat));
    const gy = Math.max(-4, Math.min(4, v.gLong));
    this.gtrail.push([gx, gy]);
    if (this.gtrail.length > 40) this.gtrail.shift();
    c.strokeStyle = 'rgba(255,255,255,0.35)';
    c.beginPath();
    this.gtrail.forEach(([x, y], i) => (i ? c.lineTo(W / 2 + x * scale, W / 2 - y * scale) : c.moveTo(W / 2 + x * scale, W / 2 - y * scale)));
    c.stroke();
    c.fillStyle = '#fff';
    c.beginPath();
    c.arc(W / 2 + gx * scale, W / 2 - gy * scale, 7, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = 'rgba(255,255,255,0.4)';
    c.font = '18px sans-serif';
    c.fillText('2G', W / 2 + 4, W / 2 - R * 0.5 - 4);
    c.fillText('4G', W / 2 + 4, W / 2 - R + 18);
    const total = Math.hypot(v.gLat, v.gLong);
    this.gvals.innerHTML = `Long <b>${v.gLong.toFixed(2)}</b><br>Lat <b>${v.gLat.toFixed(2)}</b><br>Total <b>${total.toFixed(2)} G</b><br>Height <b>${Math.max(0, v.pos.y - 0.4).toFixed(1)} m</b>`;
  }
}

// ---------------------------------------------------------------------------

export interface MenuCallbacks {
  play(mode: ModeId, trim: TrimId, autopilot: boolean): void;
  trimChanged(trim: TrimId): void;
  settings(): void;
  specs(): void;
  controls(): void;
}

export class Menu {
  readonly root = el('div', 'menu');
  mode: ModeId = 'arch';
  trim: TrimId = 'rocket';
  private modeList = el('div', 'modes');
  private trimList = el('div', '');
  private watchBtn!: HTMLButtonElement;

  constructor(parent: HTMLElement, private cb: MenuCallbacks) {
    const left = el('div', 'left');
    left.innerHTML = `<div class="wordmark">ROADSTER</div><div class="event">Unveiling demo · ${EVENT.date}<br>${EVENT.venue}</div>`;
    left.append(this.modeList);
    const actions = el('div', 'actions');
    const drive = el('button', 'btn primary', 'Drive');
    drive.onclick = () => this.cb.play(this.mode, this.trim, false);
    this.watchBtn = el('button', 'btn', 'Watch Optimus drive');
    this.watchBtn.onclick = () => this.cb.play(this.mode, this.trim, true);
    actions.append(drive, this.watchBtn);
    left.append(actions);
    const links = el('div', 'links');
    const mk = (label: string, fn: () => void) => {
      const b = el('button', '', label);
      b.onclick = fn;
      links.append(b);
    };
    mk('Spec verification', () => this.cb.specs());
    mk('Settings', () => this.cb.settings());
    mk('Controls', () => this.cb.controls());
    left.append(links);

    const right = el('div', 'right');
    right.append(el('div', 'section-label', 'Choose your Roadster'));
    right.append(this.trimList);
    this.root.append(left, el('div', ''), right);
    parent.append(this.root);
    this.render();
  }

  set visible(v: boolean) {
    this.root.classList.toggle('hidden', !v);
  }

  private render() {
    this.modeList.innerHTML = '';
    for (const m of MODES) {
      const b = el('button', `mode ${m.id === this.mode ? 'sel' : ''}`);
      b.innerHTML = `<div class="k">${m.kicker}</div><div class="t">${m.title}</div><div class="d">${m.description}</div><div class="e">${m.eventNote}</div>`;
      b.onclick = () => {
        this.mode = m.id;
        if (m.recommendedTrim && m.needsFlight) this.setTrim(m.recommendedTrim);
        this.render();
      };
      this.modeList.append(b);
    }
    this.watchBtn.disabled = this.mode === 'free';
    this.watchBtn.style.opacity = this.mode === 'free' ? '0.35' : '1';
    this.trimList.innerHTML = '';
    this.trimList.style.display = 'flex';
    this.trimList.style.flexDirection = 'column';
    this.trimList.style.gap = '10px';
    for (const t of Object.values(TRIMS)) {
      const c = el('div', `card ${t.id === this.trim ? 'sel' : ''}`);
      c.innerHTML = `<div class="row1"><div class="n">${t.name}</div><div class="r">${t.readiness}</div></div>
        <div class="tag">${t.tagline}</div>
        <div class="stats"><div><b>${t.claims.zeroTo60Label.replace('< ', '<')}</b><span>0–60 mph</span></div><div><b>230+</b><span>mph top</span></div><div><b>300+</b><span>mi range</span></div></div>
        <div class="feat">${t.seats} seat${t.seats > 1 ? 's' : ''} · ${t.availability}<br>${t.features.join(' · ')}</div>
        <div class="res">${t.reservation}</div>`;
      c.onclick = () => this.setTrim(t.id);
      this.trimList.append(c);
    }
  }

  setTrim(t: TrimId) {
    if (this.trim === t) return;
    this.trim = t;
    this.cb.trimChanged(t);
    this.render();
  }
}

// ---------------------------------------------------------------------------

export class Modal {
  readonly wrap = el('div', 'modal-wrap hidden');
  readonly box = el('div', 'modal');
  onClose: (() => void) | null = null;
  constructor(parent: HTMLElement) {
    this.wrap.append(this.box);
    this.wrap.addEventListener('pointerdown', (e) => {
      if (e.target === this.wrap) this.close();
    });
    parent.append(this.wrap);
  }
  get open() {
    return !this.wrap.classList.contains('hidden');
  }
  show(html: string, buttons: { label: string; primary?: boolean; fn: () => void }[] = []) {
    this.box.innerHTML = html;
    if (buttons.length) {
      const row = el('div', 'actions');
      for (const b of buttons) {
        const btn = el('button', `btn ${b.primary ? 'primary' : ''}`, b.label);
        btn.onclick = b.fn;
        row.append(btn);
      }
      this.box.append(row);
    }
    this.wrap.classList.remove('hidden');
  }
  close() {
    this.wrap.classList.add('hidden');
    const f = this.onClose;
    this.onClose = null;
    f?.();
  }
}

export function resultHtml(r: ModeResult) {
  return `<h2 class="${r.success ? 'ok' : ''}">${r.title}</h2><div class="sub">${r.subtitle}</div>
    <table>${r.lines.map(([a, b, c]) => `<tr><td>${a}</td><td class="v">${b}</td><td class="ref">${c ?? ''}</td></tr>`).join('')}</table>`;
}

export function controlsHtml() {
  const rows: [string, string][] = [
    ['Throttle / brake', 'W S · ↑ ↓ · RT LT'],
    ['Steer', 'A D · ← → · left stick'],
    ['Launch control', 'hold W + S, release S'],
    ['Lift thrusters / drop', 'SPACE · A'],
    ['Rear thrusters', 'SHIFT · X'],
    ['Handbrake', 'X · B'],
    ['Air pitch / yaw', 'W S / A D · right stick'],
    ['Air roll (kickflip)', 'Q E · LB RB'],
    ['Flight assist', 'G'],
    ['Suction fan mode', 'F'],
    ['Track Mode', 'T'],
    ['Camera', 'C · Y'],
    ['Restart demo', 'R'],
    ['Replay', 'V'],
    ['Optimus autopilot', 'O'],
    ['Pause', 'Esc · P'],
    ['Mute', 'M'],
    ['Hide HUD', 'U'],
  ];
  return `<h2>Controls</h2><div class="sub">Keyboard and gamepad. With Flight assist on, the Rocket levels itself and fires a landing burn automatically.</div>
    <div class="controls-grid">${rows.map(([a, b]) => `<div><span>${a}</span><kbd>${b}</kbd></div>`).join('')}</div>`;
}
