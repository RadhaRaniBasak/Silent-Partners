import { Matrix4, type PerspectiveCamera, Quaternion, Vector3 } from '@iwsdk/core';
import { botStep, safe } from '../core/bot';
import { DEFAULT_SETTINGS, Game, type GameEvent, type HandId, type HandInput } from '../core/game';
import { type HandShape, SHAPES, handJoints, lerpShape } from '../core/handgen';
import type { Cmd } from '../core/recognize';
import type { JobId, SpotId } from '../level';
import { T } from '../tuning';
import { type HandFrame, type View, toModel } from './view';

/**
 * Cinema mode (?cinema): the bot plays the heist through the real input
 * path while synthetic hands make each signal, so the trailer and the store
 * shots show exactly what a player sees. Time only moves when asked, one
 * frame at a time, so a headless browser can capture every frame.
 * Autoplay (?autoplay) runs the same bot live inside a real XR session.
 */

const HANDS: HandId[] = ['left', 'right'];
const SHAPE: Record<Cmd, HandShape> = { fist: SHAPES.fist, point: SHAPES.point, thumb: SHAPES.thumb, two: SHAPES.two };
/** Where the hands rest over the near edge of the table, in the anchor's frame. */
const REST: Record<HandId, [number, number, number]> = { left: [-0.15, 0.16, 0.25], right: [0.15, 0.16, 0.25] };
/** Job 2's plan fills the table: the hands wait lower, by its front edge, so they don't hide the back rooms. */
const REST2: Record<HandId, [number, number, number]> = { left: [-0.2, 0.09, 0.33], right: [0.2, 0.09, 0.33] };
const IDLE: HandShape = { curls: [0.12, 0.18, 0.24, 0.3], thumb: 0.3, side: 0.6 };
const FORM = 0.22;
/** From the bot's decision to the signal landing: forming, confirming, dwelling. */
const LAG = 0.45;
const HOLD = 0.72;
const DONE = 0.95;

interface Gesture {
  cmd: Cmd;
  spot?: SpotId;
  t0: number;
}

export interface CinemaOptions {
  /** Once, walk Lark out under the Eye's gaze in beat 2: shows a rewind. */
  blunder?: boolean;
  assist?: boolean;
  /** Seconds between the bot's decisions; longer reads better live. */
  gap?: number;
  job?: JobId;
  /** Job 2's night: which rounds the guards walk. */
  seed?: number;
}

export class Cinema {
  game!: Game;
  t = 0;
  pending = 0;
  /** Seconds and labels of everything worth cutting to. */
  marks: [number, string][] = [];
  cam: { pos: number[]; look: number[]; fov: number } | null = null;
  /** Film time the heist ended, for timing the end card after a seek. */
  endedAt = 0;
  /** Hide prompts and name tags: for key art with a title over it. */
  clean = false;
  /** Open the Settings panel: for showing the accessibility options. */
  settings = false;
  private gestures: Record<HandId, Gesture | null> = { left: null, right: null };
  private nextBot = 0;
  private opts: CinemaOptions = {};
  private blundered = false;
  /** The planted mistake is playing out: hands off until it lands. */
  private planted = false;
  private readonly m = new Matrix4();
  private readonly rot = new Matrix4();
  private readonly q = new Quaternion();
  private readonly x = new Vector3();
  private readonly y = new Vector3();
  private readonly z = new Vector3();
  private readonly p = new Vector3();
  private readonly tmp = new Vector3();
  private readonly joints = new Float32Array(75);

  /** Game events since the last drawn frame, for the headset layer to act on. */
  events: GameEvent[] = [];

  constructor() {
    this.reset();
  }

  reset(opts: CinemaOptions = {}) {
    this.opts = opts;
    this.game = new Game({ ...DEFAULT_SETTINGS, hints: false, assist: !!opts.assist }, opts.job ?? 'gallery', opts.seed ?? 1);
    this.t = 0;
    this.pending = 0;
    this.nextBot = 0;
    this.blundered = false;
    this.planted = false;
    this.endedAt = 0;
    this.marks = [];
    this.events = [];
    this.gestures = { left: null, right: null };
  }

  /** Runs the whole heist without drawing, for planning the cut; then starts over. */
  dry(maxS = 400) {
    const opts = this.opts;
    while (!this.game.ended && this.t < maxS) this.advance(1 / 30);
    const marks = this.marks;
    this.reset(opts);
    return marks;
  }

  seek(t: number) {
    while (this.t < t - 1e-6) this.advance(1 / 30);
  }

  advance(dt: number) {
    const g = this.game;
    this.t += dt;
    const now = this.t * 1000;
    const idle = !this.gestures.left && !this.gestures.right;
    const issue = (h: HandId, cmd: Cmd, spot?: SpotId) => {
      this.gestures[h] = { cmd, spot, t0: this.t };
      this.marks.push([+this.t.toFixed(2), `${h} ${cmd}${spot ? ` ${spot}` : ''}`]);
    };
    if (idle && !this.planted && !g.blocked() && this.t >= this.nextBot) {
      const s = g.sim.s;
      // The planted mistake: wait on the plinth until the Eye is watching the path, then go.
      const plant = this.opts.blunder && !g.open && !this.blundered && g.beat === 2 && g.sub === 1 && s.lark.at === 'plinth';
      if (plant) {
        if (!safe(g, (x) => x.go('lark', 'pillar'), 4, LAG)) {
          this.blundered = true;
          this.planted = true;
          issue('left', 'point', 'pillar');
          this.nextBot = this.t + (this.opts.gap ?? 0.4);
        }
      } else if (botStep(g, false, issue, LAG)) this.nextBot = this.t + (this.opts.gap ?? 0.4);
    }
    for (const h of HANDS) g.hand(h, this.input(h), now);
    g.update(dt, now);
    for (const e of g.takeEvents()) {
      this.events.push(e);
      const mark = (what: string) => this.marks.push([+this.t.toFixed(2), what]);
      if (e.type === 'beat') mark(`beat ${e.beat}`);
      else if (e.type === 'rewind') {
        mark('rewound');
        // Take a breath before trying again, so a replay never repeats itself exactly.
        this.nextBot = this.t + 0.5 + 0.6 * this.game.beatRewinds;
      }
      else if (e.type === 'end') {
        mark('end');
        this.endedAt = this.t;
      }
      else if (e.type === 'sim') {
        const se = e.e;
        if (se.type === 'spotted') {
          mark(`spotted ${se.thief} by ${se.by}`);
          this.planted = false;
        } else if (se.type === 'arrived') this.planted = false;
        else if (se.type === 'done') mark(`done ${se.action}`);
        else if (se.type === 'heard') mark(`heard ${se.thief}`);
        else if (se.type === 'coin') mark('coin');
        else if (se.type === 'escaped' || se.type === 'climbed') mark(se.type);
      }
    }
    for (const h of HANDS) {
      const gs = this.gestures[h];
      if (gs && this.t - gs.t0 > DONE) this.gestures[h] = null;
    }
  }

  /** What the game's input sees: the sign is held from FORM to HOLD seconds. */
  private input(h: HandId): HandInput {
    const gs = this.gestures[h];
    const u = gs ? this.t - gs.t0 : -1;
    // Hold the pose so the signal lands exactly LAG after the decision, as the bot planned.
    // (A point's confirm and its aim dwell run side by side.)
    const lead = gs ? Math.max(T.confirmMs[gs.cmd], gs.cmd === 'point' ? T.aimDwellMs : 0) / 1000 : 0;
    const held = !!gs && u >= LAG - lead - 1 / 60 && u <= HOLD;
    return {
      tracked: true,
      inZone: true,
      pose: held ? gs.cmd : 'none',
      aim: held && gs.cmd === 'point' ? (gs.spot ?? null) : null,
      palmUp: false,
      pinch: false,
    };
  }

  /** Synthetic hands, posed over the table in world space. */
  frames(view: View, out: Record<HandId, HandFrame>) {
    const anchor = view.anchor;
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldQuaternion(this.q);
    for (const h of HANDS) {
      const fr = out[h];
      const gs = this.gestures[h];
      const u = gs ? this.t - gs.t0 : -1;
      const k = !gs ? 0 : u < FORM ? u / FORM : u < HOLD ? 1 : Math.max(0, 1 - (u - HOLD) / (DONE - HOLD));
      const e = k * k * (3 - 2 * k);
      const shape = gs ? lerpShape(IDLE, SHAPE[gs.cmd], e) : IDLE;
      const left = h === 'left';
      const r = (this.game.open ? REST2 : REST)[h];
      const sway = Math.sin(this.t * 0.8 + (left ? 0 : 1.7));
      // Signals are offered up and toward the table.
      this.p.set(r[0] * (1 - 0.15 * e), r[1] + 0.025 * e + sway * 0.003, r[2] - 0.05 * e);
      // Hand basis in the anchor's frame: y along the fingers, z out of the palm.
      if (gs?.cmd === 'thumb' && e > 0) {
        this.y.set(0, 0.15, -1).normalize();
        this.z.set(left ? 1 : -1, -0.6 * (1 - e), 0).normalize();
      } else if ((gs?.cmd === 'point' || gs?.cmd === 'two') && gs.spot && e > 0) {
        const sp = this.game.level.spot[gs.spot];
        view.anchorPoint(sp.x, sp.z, this.tmp, 0);
        this.y.subVectors(this.tmp, this.p).normalize().lerp(this.tmp.set(0, -0.18, -1).normalize(), 1 - e).normalize();
        this.z.set(0, -1, 0);
      } else {
        this.y.set(left ? 0.12 : -0.12, -0.18, -1).normalize();
        this.z.set(0, -1, 0);
      }
      this.z.addScaledVector(this.y, -this.z.dot(this.y)).normalize();
      this.x.crossVectors(this.y, this.z);
      this.m.makeBasis(this.x, this.y, this.z).premultiply(this.rot.makeRotationFromQuaternion(this.q));
      const wrist = anchor.localToWorld(this.tmp.copy(this.p));
      this.m.setPosition(wrist);
      handJoints(shape, left, 1, this.joints);
      for (let i = 0; i < 25; i++) {
        this.p.set(this.joints[i * 3], this.joints[i * 3 + 1], this.joints[i * 3 + 2]).applyMatrix4(this.m);
        fr.joints[i * 3] = this.p.x;
        fr.joints[i * 3 + 1] = this.p.y;
        fr.joints[i * 3 + 2] = this.p.z;
      }
      fr.tracked = true;
      fr.inZone = true;
      fr.nearEdge = false;
      // The glyph floats above the back of the hand.
      fr.palm.set(fr.joints[27], fr.joints[28], fr.joints[29]).lerp(this.tmp.set(fr.joints[0], fr.joints[1], fr.joints[2]), 0.5);
      fr.palm.y += 0.07;
      const pointing = (gs?.cmd === 'point' || gs?.cmd === 'two') && gs.spot && u >= FORM * 0.7 && u <= HOLD;
      const sp = pointing ? this.game.level.spot[gs.spot!] : null;
      fr.aimSpot = sp ? sp.id : null;
      fr.aimHit = sp ? toModel(sp.x, sp.z, fr.aimHit ?? new Vector3(), 0) : null;
    }
  }

  /** Applies the requested camera. */
  aim(camera: PerspectiveCamera) {
    if (!this.cam) return;
    const { pos, look, fov } = this.cam;
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(look[0], look[1], look[2]);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld(true);
  }
}

/** A cue for the trailer's score: [seconds, what, value]. */
export type Cue = [number, 'title' | 'start' | 'tension' | 'duck' | 'finale', number?];

/**
 * Renders the trailer's soundtrack offline (the score plus rain) and returns
 * it as a base64 WAV, so the film script can lay it under the frames.
 */
export async function renderScore(duration: number, cues: Cue[]): Promise<string> {
  const { Music } = await import('./music');
  const rate = 48000;
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);
  const music = new Music(ctx, ctx.destination);
  // Rain on the van roof: filtered noise, gently moving.
  const noise = ctx.createBuffer(2, rate * 4, rate);
  for (let c = 0; c < 2; c++) {
    const d = noise.getChannelData(c);
    let s = 11 + c;
    for (let i = 0; i < d.length; i++) {
      s = (s * 16807) % 2147483647;
      d[i] = (s / 2147483647) * 2 - 1;
    }
  }
  const rain = ctx.createBufferSource();
  rain.buffer = noise;
  rain.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800;
  bp.Q.value = 0.4;
  const rg = ctx.createGain();
  rg.gain.value = 0.05;
  rain.connect(bp).connect(rg).connect(ctx.destination);
  rain.start(0);
  rg.gain.setValueAtTime(0.05, Math.max(0, duration - 2));
  rg.gain.linearRampToValueAtTime(0, duration);
  // Walk the timeline as the live game would: cues as they come, notes a little ahead.
  const queue = [...cues].sort((a, b) => a[0] - b[0]);
  for (let t = 0; t <= duration; t += 0.05) {
    while (queue.length && queue[0][0] <= t) {
      const [at, what, v] = queue.shift()!;
      if (what === 'title') music.title(at);
      else if (what === 'start') music.start(at);
      else if (what === 'tension') music.setTension(v ?? 0, at);
      else if (what === 'duck') music.duck(at);
      else if (what === 'finale') music.finale(at);
    }
    music.update(t + 0.25);
  }
  const buf = await ctx.startRendering();
  // 16-bit PCM WAV.
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((ch, i) => out.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, n * 4, true);
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  for (let i = 0; i < n; i++) {
    out.setInt16(44 + i * 4, Math.max(-1, Math.min(1, l[i])) * 32767, true);
    out.setInt16(46 + i * 4, Math.max(-1, Math.min(1, r[i])) * 32767, true);
  }
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A run of title text: plain words, or a crew name in its colour. */
export type Words = [string, string?][];

/** Titles drawn over a film frame, all optional; `a` is opacity. */
export interface Titles {
  black?: number;
  card?: { words: Words; a: number };
  lower?: { words: Words; a: number };
  badge?: number;
  logo?: number;
  /** Small label in the top-right corner, e.g. how the footage was made. */
  tag?: string;
  /** Shown under the logo card. */
  url?: string;
}

/**
 * Draws trailer titles straight onto the frame, so a frame is one render and
 * one encode: no page screenshot. Sizes are for 1080p and scale with height.
 */
export function drawTitles(ctx: CanvasRenderingContext2D, w: number, h: number, t: Titles, mark: HTMLImageElement) {
  const k = h / 1080;
  const font = (weight: number, px: number) => `${weight} ${px * k}px "Atkinson Hyperlegible", system-ui, sans-serif`;
  const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, h * 1.05);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);
  if (t.black) {
    ctx.globalAlpha = t.black;
    ctx.fillStyle = '#07090d';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  const words = (ws: Words, x: number, y: number, align: 'left' | 'center') => {
    const total = ws.reduce((s, [txt]) => s + ctx.measureText(txt).width, 0);
    let cx = align === 'center' ? x - total / 2 : x;
    ctx.textAlign = 'left';
    for (const [txt, color] of ws) {
      ctx.fillStyle = color ?? '#ffffff';
      ctx.fillText(txt, cx, y);
      cx += ctx.measureText(txt).width;
    }
    return total;
  };
  ctx.textBaseline = 'middle';
  if (t.card?.a) {
    ctx.globalAlpha = t.card.a;
    ctx.font = font(700, 64);
    words(t.card.words, w / 2, h / 2, 'center');
    ctx.globalAlpha = 1;
  }
  if (t.lower?.a) {
    ctx.globalAlpha = t.lower.a;
    // A soft dark band so the words hold over a busy frame.
    const band = ctx.createLinearGradient(0, 0, w * 0.62, 0);
    band.addColorStop(0, 'rgba(4, 6, 10, 0.7)');
    band.addColorStop(1, 'rgba(4, 6, 10, 0)');
    ctx.fillStyle = band;
    ctx.fillRect(0, h * 0.86 - 52 * k, w * 0.62, 112 * k);
    ctx.font = font(700, 48);
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 18 * k;
    words(t.lower.words, w * 0.06, h * 0.86, 'left');
    ctx.shadowBlur = 0;
    const g = ctx.createLinearGradient(w * 0.06, 0, w * 0.06 + 120 * k, 0);
    g.addColorStop(0, '#2ec4b6');
    g.addColorStop(1, '#f4a261');
    ctx.fillStyle = g;
    ctx.fillRect(w * 0.06, h * 0.86 + 40 * k, 120 * k, 4 * k);
    ctx.globalAlpha = 1;
  }
  const rule = (x: number, y: number, len: number) => {
    const g = ctx.createLinearGradient(x, 0, x + len, 0);
    g.addColorStop(0, '#2ec4b6');
    g.addColorStop(1, '#f4a261');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, len, 4 * k);
  };
  if (t.badge) {
    ctx.globalAlpha = t.badge;
    ctx.drawImage(mark, w * 0.045, h * 0.06, 92 * k, 92 * k);
    ctx.shadowColor = 'rgba(127, 220, 255, 0.5)';
    ctx.shadowBlur = 30 * k;
    ctx.font = font(700, 84);
    ctx.letterSpacing = `${4 * k}px`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText('SILENT PARTNERS', w * 0.045 + 114 * k, h * 0.06 + 34 * k);
    ctx.letterSpacing = '0px';
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 16 * k;
    ctx.font = font(400, 34);
    ctx.fillStyle = '#dfe8f0';
    ctx.fillText('A hands-only VR heist', w * 0.045 + 116 * k, h * 0.06 + 98 * k);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }
  if (t.logo) {
    ctx.globalAlpha = t.logo;
    const cy = h * 0.42;
    ctx.drawImage(mark, w / 2 - 60 * k, cy - 170 * k, 120 * k, 120 * k);
    ctx.font = font(700, 92);
    ctx.letterSpacing = `${5 * k}px`;
    ctx.shadowColor = 'rgba(127, 220, 255, 0.45)';
    ctx.shadowBlur = 30 * k;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText('SILENT PARTNERS', w / 2, cy + 20 * k);
    ctx.shadowBlur = 0;
    ctx.letterSpacing = '0px';
    rule(w / 2 - 320 * k, cy + 82 * k, 640 * k);
    ctx.font = font(400, 34);
    ctx.fillStyle = '#c8d3de';
    ctx.fillText('A hands-only heist for Meta Quest', w / 2, cy + 140 * k);
    ctx.font = font(700, 32);
    ctx.fillStyle = '#ffffff';
    ctx.fillText('Play free in Meta Quest Browser', w / 2, cy + 200 * k);
    if (t.url) {
      ctx.font = font(400, 30);
      ctx.fillStyle = '#7fdcff';
      ctx.fillText(t.url, w / 2, cy + 252 * k);
    }
    ctx.globalAlpha = 1;
  }
  if (t.tag) {
    ctx.font = font(700, 22);
    ctx.letterSpacing = `${2 * k}px`;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(223, 232, 240, 0.8)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 10 * k;
    ctx.fillText(t.tag, w * 0.965, h * 0.055);
    ctx.shadowBlur = 0;
    ctx.letterSpacing = '0px';
  }
}
