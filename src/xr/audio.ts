/**
 * Every sound is synthesised with Web Audio, so there are no audio files to
 * license or download. Positions are world-space metres; the listener follows
 * the head. Nothing speaks: noise is the enemy in this heist.
 */

import { Music } from './music';

interface P {
  x: number;
  y: number;
  z: number;
}

class Sound {
  ctx: AudioContext | null = null;
  music: Music | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private eyeGain: GainNode | null = null;
  private eyePan: PannerNode | null = null;

  /** Call from a user gesture (the Enter button). */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.ambience();
    this.music = new Music(ctx, this.master);
  }

  listener(p: P, fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) {
    const l = this.ctx?.listener;
    if (!l) return;
    if (l.positionX) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
      l.forwardX.value = fx;
      l.forwardY.value = fy;
      l.forwardZ.value = fz;
      l.upX.value = ux;
      l.upY.value = uy;
      l.upZ.value = uz;
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  private out(p?: P): AudioNode {
    const ctx = this.ctx!;
    if (!p) return this.master;
    const pan = ctx.createPanner();
    pan.panningModel = 'HRTF';
    pan.distanceModel = 'inverse';
    pan.refDistance = 0.4;
    pan.rolloffFactor = 0.6;
    pan.positionX.value = p.x;
    pan.positionY.value = p.y;
    pan.positionZ.value = p.z;
    pan.connect(this.master);
    return pan;
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, dest: AudioNode, at = 0, slideTo = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, freq: number, q: number, vol: number, dest: AudioNode, at = 0, sweepTo = 0) {
    const ctx = this.ctx!;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(t, Math.random());
    src.stop(t + dur + 0.05);
  }

  private ok() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Signal confirmed: lower for the left hand, higher for the right. */
  tick(left: boolean, p?: P) {
    if (this.ok()) this.tone(left ? 520 : 820, 0.07, 'triangle', 0.35, this.out(p));
  }
  no(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    this.tone(440, 0.1, 'sine', 0.25, o);
    this.tone(330, 0.14, 'sine', 0.25, o, 0.1);
  }
  check(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    this.tone(880, 0.08, 'sine', 0.12, o);
    this.tone(1320, 0.12, 'sine', 0.1, o, 0.07);
  }
  spotted(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    for (const [f, v] of [[660, 0.3], [1650, 0.12], [2420, 0.08]] as const) this.tone(f, 1.3, 'sine', v, o);
  }
  rewind() {
    if (this.ok()) this.burst(0.7, 3000, 1.2, 0.25, this.master, 0, 300);
  }
  question(p?: P) {
    if (this.ok()) this.tone(600, 0.18, 'sine', 0.2, this.out(p), 0, 900);
  }
  buzz(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    this.tone(110, 0.45, 'sawtooth', 0.18, o);
    this.burst(0.3, 2400, 2, 0.15, o);
  }
  lift(p?: P) {
    if (this.ok()) this.tone(300, 2.0, 'sine', 0.18, this.out(p), 0, 620);
  }
  /** The rubber stamp hitting the end card. */
  stamp() {
    if (!this.ctx) return;
    this.tone(90, 0.25, 'sine', 0.5, this.master, 0, 40);
    this.tone(1400, 0.05, 'square', 0.04, this.master);
  }

  win() {
    if (!this.ok()) return;
    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.5, 'triangle', 0.22, this.master, i * 0.13));
  }
  step(p?: P) {
    if (this.ok()) this.burst(0.06, 180, 1, 0.22, this.out(p));
  }
  work(p?: P) {
    if (this.ok()) this.tone(1500, 0.03, 'square', 0.05, this.out(p));
  }
  /** A coin skittering across a floor. */
  coin(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    for (const [at, f] of [[0, 3200], [0.09, 2900], [0.16, 3400], [0.21, 3000]] as const) this.tone(f, 0.05, 'sine', 0.09, o, at);
  }
  /** The vault sensor's warning blink. */
  beep(p?: P) {
    if (this.ok()) this.tone(1760, 0.06, 'square', 0.05, this.out(p));
  }
  /** The vault door's bolts drawing back. */
  vault(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    this.tone(70, 0.6, 'sine', 0.4, o, 0, 45);
    this.burst(0.25, 900, 1.5, 0.15, o, 0.05);
    this.tone(140, 0.4, 'triangle', 0.12, o, 0.35, 90);
  }
  scan() {
    if (this.ok()) this.tone(200, 1.6, 'sine', 0.08, this.master, 0, 800);
  }
  spark(p?: P) {
    if (!this.ok()) return;
    const o = this.out(p);
    this.burst(0.15, 4000, 3, 0.15, o);
    this.tone(1200, 0.2, 'triangle', 0.12, o, 0.05, 1800);
  }

  /** The camera's hum; silent once it's cut. */
  eye(on: boolean, p: P) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.eyeGain) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 210;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.25;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 15;
      lfo.connect(lfoGain).connect(o.frequency);
      this.eyeGain = ctx.createGain();
      this.eyeGain.gain.value = 0;
      this.eyePan = this.out(p) as PannerNode;
      o.connect(this.eyeGain).connect(this.eyePan);
      o.start();
      lfo.start();
    }
    this.eyeGain.gain.setTargetAtTime(on ? 0.035 : 0, ctx.currentTime, 0.2);
    if (this.eyePan) {
      this.eyePan.positionX.value = p.x;
      this.eyePan.positionY.value = p.y;
      this.eyePan.positionZ.value = p.z;
    }
  }

  /** Rain on the van roof and the hologram's low hum. */
  private ambience() {
    const ctx = this.ctx!;
    const rain = ctx.createBufferSource();
    rain.buffer = this.noise;
    rain.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1300;
    const g = ctx.createGain();
    g.gain.value = 0.07;
    rain.connect(lp).connect(g).connect(this.master);
    rain.start();
    const drip = () => {
      if (!this.ctx) return;
      if (this.ok()) this.burst(0.04, 2500 + Math.random() * 2500, 4, 0.03 + Math.random() * 0.04, this.master);
      setTimeout(drip, 60 + Math.random() * 260);
    };
    drip();
    for (const [f, v] of [[58, 0.025], [116, 0.012]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      const hg = ctx.createGain();
      hg.gain.value = v;
      o.connect(hg).connect(this.master);
      o.start();
    }
  }
}

export const sound = new Sound();
