import type { Vehicle } from '../sim/vehicle';

// Everything is synthesised with WebAudio, so there are no audio assets to load.

function noiseBuffer(ctx: AudioContext, seconds = 2, pink = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (pink) {
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.18;
    } else d[i] = w;
  }
  return buf;
}

interface Voice {
  gain: GainNode;
}

export class GameAudio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private motorA!: OscillatorNode;
  private motorB!: OscillatorNode;
  private motorGain!: GainNode;
  private motorFilter!: BiquadFilterNode;
  private inverter!: OscillatorNode;
  private inverterGain!: GainNode;
  private wind!: Voice & { filter: BiquadFilterNode };
  private tires!: Voice & { filter: BiquadFilterNode };
  private fan!: Voice & { osc: OscillatorNode };
  private thrust!: Voice & { filter: BiquadFilterNode };
  private crowd!: Voice & { filter: BiquadFilterNode };
  private noise!: AudioBuffer;
  private crowdLevel = 0.04;
  muted = false;
  volume = 0.8;

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.noise = noiseBuffer(ctx, 3);
    const pink = noiseBuffer(ctx, 4, true);

    // Motor: two detuned saws through a resonant low-pass → EV gear whine
    this.motorFilter = ctx.createBiquadFilter();
    this.motorFilter.type = 'lowpass';
    this.motorFilter.Q.value = 6;
    this.motorGain = ctx.createGain();
    this.motorGain.gain.value = 0;
    this.motorA = ctx.createOscillator();
    this.motorA.type = 'sawtooth';
    this.motorB = ctx.createOscillator();
    this.motorB.type = 'triangle';
    this.motorA.connect(this.motorFilter);
    this.motorB.connect(this.motorFilter);
    this.motorFilter.connect(this.motorGain).connect(this.master);
    this.motorA.start();
    this.motorB.start();
    this.inverter = ctx.createOscillator();
    this.inverter.type = 'sine';
    this.inverterGain = ctx.createGain();
    this.inverterGain.gain.value = 0;
    this.inverter.connect(this.inverterGain).connect(this.master);
    this.inverter.start();

    const noiseVoice = (buf: AudioBuffer, type: BiquadFilterType, freq: number, q = 1) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start(0, Math.random() * 2);
      return { gain, filter };
    };
    this.wind = noiseVoice(pink, 'bandpass', 600, 0.4);
    this.tires = noiseVoice(this.noise, 'bandpass', 1400, 2.5);
    this.thrust = noiseVoice(this.noise, 'lowpass', 2400, 0.7);
    this.crowd = noiseVoice(pink, 'bandpass', 1200, 0.6);

    const fanOsc = ctx.createOscillator();
    fanOsc.type = 'sawtooth';
    const fanF = ctx.createBiquadFilter();
    fanF.type = 'bandpass';
    fanF.frequency.value = 900;
    fanF.Q.value = 3;
    const fanG = ctx.createGain();
    fanG.gain.value = 0;
    fanOsc.connect(fanF).connect(fanG).connect(this.master);
    fanOsc.start();
    this.fan = { gain: fanG, osc: fanOsc };
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = this.muted ? 0 : v;
  }

  toggleMute() {
    this.muted = !this.muted;
    this.setVolume(this.volume);
    return this.muted;
  }

  private set(p: AudioParam, v: number, tc = 0.05) {
    p.setTargetAtTime(v, this.ctx!.currentTime, tc);
  }

  update(v: Vehicle, listenerDist: number, paused: boolean) {
    if (!this.ctx) return;
    const att = paused ? 0 : 1 / (1 + Math.max(0, listenerDist - 8) * 0.04);
    const rear = v.wheels[2];
    const om = Math.abs(rear.omega);
    const load = Math.min(1, Math.abs(v.powerKW) / 600);
    // gear whine pitch follows motor speed (≈9:1 reduction)
    const f = 40 + om * 9 * 0.9;
    this.set(this.motorA.frequency, f);
    this.set(this.motorB.frequency, f * 2.003);
    this.set(this.motorFilter.frequency, 400 + f * 3 + load * 2500);
    this.set(this.motorGain.gain, (0.02 + load * 0.16 + Math.min(0.06, om * 0.0006)) * att);
    this.set(this.inverter.frequency, 2200 + om * 30);
    this.set(this.inverterGain.gain, (load * 0.025 + (om > 1 ? 0.004 : 0)) * att);
    const sp = v.speed;
    this.set(this.wind.gain.gain, Math.min(0.5, sp * sp * 0.00004) * att);
    this.set(this.wind.filter.frequency, 300 + sp * 12);
    let slip = 0;
    for (const w of v.wheels) slip += w.contact ? w.slipEnergy : 0;
    this.set(this.tires.gain.gain, Math.min(0.35, Math.max(0, slip / 60000 - 0.05)) * att, 0.03);
    this.set(this.tires.filter.frequency, 1100 + Math.min(900, slip / 300));
    this.set(this.fan.gain.gain, v.fanRpm * 0.05 * att);
    this.set(this.fan.osc.frequency, 120 + v.fanRpm * 900);
    const th = v.thrustOut.rear + v.thrustOut.lift + (Math.abs(v.thrustOut.rcs.x) + Math.abs(v.thrustOut.rcs.y) + Math.abs(v.thrustOut.rcs.z)) * 0.25;
    this.set(this.thrust.gain.gain, Math.min(0.9, th * 0.5) * att, 0.02);
    this.set(this.thrust.filter.frequency, 1500 + th * 3000, 0.02);
    this.crowdLevel += (0.035 - this.crowdLevel) * 0.01;
    this.set(this.crowd.gain.gain, paused ? 0 : this.crowdLevel, 0.3);
  }

  cheer(strength = 1) {
    this.crowdLevel = Math.min(0.5, 0.18 + strength * 0.3);
  }

  impact(strength: number) {
    if (!this.ctx || strength < 0.05) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 300 + strength * 1500;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(Math.min(0.9, strength * 0.7), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.4);
  }

  beep(freq: number, dur = 0.12, vol = 0.15) {
    if (!this.ctx) return;
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    const t = this.ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
}
