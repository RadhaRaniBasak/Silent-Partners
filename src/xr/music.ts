/**
 * The score: a brushed, walking-bass heist groove in D minor, synthesised
 * note by note. A tension layer (muted ostinato and a low drone) fades in
 * as the guard closes in. Works on a live AudioContext, scheduled a little
 * ahead each frame, or on an OfflineAudioContext for the trailer.
 */

const BPM = 96;
const SWING = 0.62;
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

// Dm9 | Gm9 | Bbmaj7/A | A7b9, a walking line under each.
const BASS = [
  [38, 41, 45, 44],
  [43, 46, 50, 45],
  [34, 38, 41, 46],
  [33, 37, 40, 39],
];
const PAD = [
  [53, 57, 60, 64],
  [58, 62, 65, 69],
  [57, 62, 65, 70],
  [61, 64, 67, 70],
];
const ROOT = [38, 43, 34, 33];
// Vibraphone motif: [bar, eighth, note, eighths long]. Plays every other pass.
const VIBES: [number, number, number, number][] = [
  [0, 0, 69, 2], [0, 3, 72, 1], [0, 6, 74, 2],
  [1, 0, 77, 4], [1, 5, 76, 2],
  [2, 2, 74, 2], [2, 4, 69, 3],
  [3, 0, 73, 2], [3, 2, 76, 3],
];

export class Music {
  readonly bus: GainNode;
  private readonly duckG: GainNode;
  private readonly calm: GainNode;
  private readonly tense: GainNode;
  private readonly lp: BiquadFilterNode;
  private readonly noise: AudioBuffer;
  private readonly eighth = 60 / BPM / 2;
  private next = -1;
  private step = 0;
  private playing = false;
  private level = 0.36;
  private tension = 0;

  constructor(private readonly ctx: BaseAudioContext, dest: AudioNode) {
    this.bus = ctx.createGain();
    this.bus.gain.value = this.level;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.calm = ctx.createGain();
    this.tense = ctx.createGain();
    this.tense.gain.value = 0;
    this.duckG = ctx.createGain();
    this.calm.connect(this.lp);
    this.tense.connect(this.lp);
    this.lp.connect(this.duckG).connect(this.bus);
    this.bus.connect(dest);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let s = 7;
    for (let i = 0; i < d.length; i++) {
      s = (s * 16807) % 2147483647;
      d[i] = (s / 2147483647) * 2 - 1;
    }
  }

  setEnabled(on: boolean, at = this.ctx.currentTime) {
    this.bus.gain.cancelScheduledValues(at);
    this.bus.gain.setTargetAtTime(on ? this.level : 0, at, 0.3);
  }

  /** Starts the groove on the next bar line. */
  start(at = this.ctx.currentTime + 0.05) {
    if (this.playing) return;
    this.playing = true;
    this.next = at;
    this.step = 0;
  }

  stop() {
    this.playing = false;
  }

  /** 0 calm .. 1 the torch is on you. */
  setTension(v: number, at = this.ctx.currentTime) {
    v = Math.min(1, Math.max(0, v));
    if (Math.abs(v - this.tension) < 0.02) return;
    this.tension = v;
    this.tense.gain.setTargetAtTime(v, at, 0.5);
    this.calm.gain.setTargetAtTime(1 - 0.35 * v, at, 0.5);
  }

  /** Muffled while paused. */
  setPaused(on: boolean, at = this.ctx.currentTime) {
    this.lp.frequency.setTargetAtTime(on ? 500 : 18000, at, 0.15);
  }

  /** The floor drops out when someone is spotted, and creeps back over the rewind. */
  duck(at = this.ctx.currentTime) {
    const g = this.duckG.gain;
    g.cancelScheduledValues(at);
    g.setTargetAtTime(0.05, at, 0.04);
    g.setTargetAtTime(1, at + 1.2, 0.5);
    this.hit(at, 0.5, 1.4);
  }

  /** Called every frame; schedules notes a quarter second ahead. */
  update(horizon = this.ctx.currentTime + 0.25) {
    if (!this.playing) return;
    // Fell behind (a stalled frame, a paused session): pick up from now, never in a rush.
    if (this.next < horizon - 1) this.next = horizon - 0.2;
    while (this.next < horizon) {
      this.play(this.step, this.next);
      // Swung eighths: long-short pairs.
      this.next += this.eighth * 2 * (this.step % 2 === 0 ? SWING : 1 - SWING);
      this.step++;
    }
  }

  /** A slow swell and a rising vibes line under the title card. */
  title(at = this.ctx.currentTime) {
    this.pad(PAD[0], at, 3.6, 0.09, 1.6, this.calm);
    [57, 62, 65, 69, 72].forEach((n, i) => this.vibe(n, at + 0.6 + i * 0.32, 1.6, 0.12));
    this.swell(at + 1.2, 2.6);
  }

  /** The job is done: the groove stops on a D major ninth. */
  finale(at = this.ctx.currentTime) {
    this.playing = false;
    this.setTension(0, at);
    this.bass(38, at, 3.5, 0.5);
    this.pad([54, 57, 61, 64], at, 4.5, 0.1, 0.4, this.calm);
    [62, 66, 69, 73, 76].forEach((n, i) => this.vibe(n, at + 0.15 + i * 0.16, 2.5, 0.13));
    this.hit(at, 0.35, 2.5);
  }

  private play(step: number, t: number) {
    const bar = Math.floor(step / 8) % 4;
    const e = step % 8;
    const pass = Math.floor(step / 32);
    // Walking bass on the beat.
    if (e % 2 === 0) this.bass(BASS[bar][e / 2], t, this.eighth * 1.7, 0.42);
    // Brushes: every eighth, swish on 2 and 4, a soft kick on 1 and 3.
    this.brush(t, e % 2 ? 0.05 : 0.08);
    if (e === 2 || e === 6) this.swish(t);
    if (e === 0 || e === 4) this.kick(t, 0.5);
    if (e === 5 && pass % 2) this.kick(t, 0.25);
    // Pad on the bar; vibes every other pass.
    if (e === 0) this.pad(PAD[bar], t, this.eighth * 7.5, 0.045, 0.25, this.calm);
    if (pass % 2 === 1) for (const [b, at, n, len] of VIBES) if (b === bar && at === e) this.vibe(n, t, this.eighth * len * 1.6, 0.09);
    // Tension layer: muted eighths on the root, a drone, double-time hats.
    if (this.tension < 0.01) return;
    this.pluck(ROOT[bar] + 12 + (e === 3 || e === 7 ? 7 : 0), t, 0.1, 0.24);
    if (e === 0) this.drone(ROOT[bar], t, this.eighth * 8, 0.17);
    this.brush(t + this.eighth * 0.5, 0.035, this.tense);
  }

  private env(t: number, attack: number, dur: number, vol: number, dest: AudioNode) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(attack + 0.02, dur));
    g.connect(dest);
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number, dest: AudioNode, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private bass(n: number, t: number, dur: number, vol: number) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    lp.connect(this.env(t, 0.006, dur, vol, this.calm));
    this.osc('triangle', midi(n), t, dur, lp);
    this.osc('sine', midi(n - 12), t, dur, lp);
  }

  private pad(notes: number[], t: number, dur: number, vol: number, attack: number, dest: AudioNode) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.connect(this.env(t, attack, dur, vol, dest));
    for (const n of notes) {
      this.osc('sawtooth', midi(n), t, dur, lp, -6);
      this.osc('sawtooth', midi(n), t, dur, lp, 6);
    }
  }

  private vibe(n: number, t: number, dur: number, vol: number) {
    const trem = this.ctx.createGain();
    trem.gain.value = 0.75;
    const depth = this.ctx.createGain();
    depth.gain.value = 0.25;
    depth.connect(trem.gain);
    this.osc('sine', 5.5, t, dur, depth);
    trem.connect(this.env(t, 0.004, dur, vol, this.calm));
    this.osc('sine', midi(n), t, dur, trem);
    this.osc('sine', midi(n) * 4, t, dur * 0.25, this.env(t, 0.002, dur * 0.2, vol * 0.25, this.calm));
  }

  private noiseHit(t: number, dur: number, vol: number, type: BiquadFilterType, f: number, q: number, dest: AudioNode) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = this.ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.value = f;
    bp.Q.value = q;
    src.connect(bp).connect(this.env(t, 0.003, dur, vol, dest));
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  private brush(t: number, vol: number, dest: AudioNode = this.calm) {
    this.noiseHit(t, 0.06, vol, 'bandpass', 7500, 0.8, dest);
  }

  private swish(t: number) {
    this.noiseHit(t, 0.22, 0.11, 'bandpass', 2600, 0.6, this.calm);
  }

  private kick(t: number, vol: number) {
    const o = this.osc('sine', 110, t, 0.3, this.env(t, 0.004, 0.28, vol, this.calm));
    o.frequency.exponentialRampToValueAtTime(42, t + 0.2);
  }

  private pluck(n: number, t: number, dur: number, vol: number) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + dur);
    lp.connect(this.env(t, 0.003, dur, vol, this.tense));
    this.osc('sawtooth', midi(n), t, dur, lp);
  }

  private drone(n: number, t: number, dur: number, vol: number) {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 420;
    lp.connect(this.env(t, 0.5, dur, vol, this.tense));
    this.osc('sawtooth', midi(n - 12), t, dur, lp, -8);
    this.osc('sawtooth', midi(n - 12), t, dur, lp, 8);
  }

  private swell(t: number, dur: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp).connect(g).connect(this.calm);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  /** A low, filtered impact for the spotted sting and the final chord. */
  private hit(t: number, vol: number, dur: number) {
    const o = this.osc('sine', 70, t, dur, this.env(t, 0.005, dur, vol, this.bus));
    o.frequency.exponentialRampToValueAtTime(34, t + dur);
    this.noiseHit(t, 0.5, vol * 0.4, 'lowpass', 900, 0.5, this.bus);
  }
}
