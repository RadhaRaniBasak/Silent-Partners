import { T } from '../tuning';

/**
 * Hand signal recognition. Input is 25 joint positions per hand (x, y, z per
 * joint, WebXR order). Features are ratios of distances, so they don't depend
 * on hand size, handedness or orientation.
 */

export type Pose = 'fist' | 'point' | 'thumb' | 'two' | 'open' | 'none';
export type Cmd = 'fist' | 'point' | 'thumb' | 'two';
export const CMDS: readonly Cmd[] = ['fist', 'point', 'thumb', 'two'];

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal',
  'thumb-phalanx-proximal',
  'thumb-phalanx-distal',
  'thumb-tip',
  'index-finger-metacarpal',
  'index-finger-phalanx-proximal',
  'index-finger-phalanx-intermediate',
  'index-finger-phalanx-distal',
  'index-finger-tip',
  'middle-finger-metacarpal',
  'middle-finger-phalanx-proximal',
  'middle-finger-phalanx-intermediate',
  'middle-finger-phalanx-distal',
  'middle-finger-tip',
  'ring-finger-metacarpal',
  'ring-finger-phalanx-proximal',
  'ring-finger-phalanx-intermediate',
  'ring-finger-phalanx-distal',
  'ring-finger-tip',
  'pinky-finger-metacarpal',
  'pinky-finger-phalanx-proximal',
  'pinky-finger-phalanx-intermediate',
  'pinky-finger-phalanx-distal',
  'pinky-finger-tip',
] as const;

export const J = { wrist: 0, thumbTip: 4, indexProx: 6, indexTip: 9, middleProx: 11, pinkyProx: 21 } as const;

/** Bone pairs for drawing a hand. */
export const BONES: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8], [8, 9],
  [0, 10], [10, 11], [11, 12], [12, 13], [13, 14],
  [0, 15], [15, 16], [16, 17], [17, 18], [18, 19],
  [0, 20], [20, 21], [21, 22], [22, 23], [23, 24],
  [6, 11], [11, 16], [16, 21],
];

const FINGERS: readonly [number, number][] = [
  [6, 9],
  [11, 14],
  [16, 19],
  [21, 24],
];

const jd = (j: ArrayLike<number>, a: number, b: number) =>
  Math.hypot(j[a * 3] - j[b * 3], j[a * 3 + 1] - j[b * 3 + 1], j[a * 3 + 2] - j[b * 3 + 2]);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Four finger curls (0 straight, 1 curled) and how far the thumb sticks out. */
export function features(j: ArrayLike<number>, out: number[] = [0, 0, 0, 0, 0]): number[] {
  const span = T.curlOpenRatio - T.curlFistRatio;
  for (let k = 0; k < 4; k++) {
    const [prox, tip] = FINGERS[k];
    out[k] = clamp01((T.curlOpenRatio - jd(j, tip, 0) / jd(j, prox, 0)) / span);
  }
  const thumb = jd(j, J.thumbTip, J.indexProx) / jd(j, J.indexProx, 0);
  out[4] = clamp01((thumb - T.thumbInRatio) / (T.thumbOutRatio - T.thumbInRatio));
  return out;
}

export interface Template {
  pose: Pose;
  f: number[];
  w: number[];
}

/** Default poses. "Open" never commands anything; it gives relaxed hands somewhere to land. */
export const DEFAULT_TEMPLATES: readonly Template[] = [
  { pose: 'fist', f: [1, 1, 1, 1, 0], w: [1, 1, 1, 1, 1] },
  { pose: 'point', f: [0, 1, 1, 1, 0], w: [1, 1, 1, 1, 0] },
  { pose: 'thumb', f: [1, 1, 1, 1, 1], w: [1, 1, 1, 1, 1] },
  // Two fingers up (index and middle): tosses a coin where they aim.
  { pose: 'two', f: [0, 0, 1, 1, 0], w: [1, 1, 1, 1, 0] },
  { pose: 'open', f: [0, 0, 0, 0, 0], w: [1, 1, 1, 1, 0] },
];

export function templateDistance(f: ArrayLike<number>, t: Template): number {
  let s = 0;
  for (let k = 0; k < 5; k++) s += t.w[k] * (f[k] - t.f[k]) ** 2;
  return Math.sqrt(s);
}

/**
 * Default templates with any re-recorded signals swapped in. A recorded pose
 * uses every feature. If one sits near the open hand, the open template is
 * dropped so the two can't cancel each other out.
 */
export function buildTemplates(recorded: Partial<Record<Cmd, number[]>>): Template[] {
  const out = DEFAULT_TEMPLATES.map((t) => {
    const f = t.pose !== 'open' && recorded[t.pose as Cmd];
    return f ? { pose: t.pose, f: f.slice(), w: [1, 1, 1, 1, 1] } : { ...t, f: t.f.slice(), w: t.w.slice() };
  });
  const open = out.find((t) => t.pose === 'open')!;
  const clash = out.some((t) => t.pose !== 'open' && templateDistance(t.f, open) < 0.5);
  return clash ? out.filter((t) => t !== open) : out;
}

/** Nearest template, if it's close enough and clearly closer than the runner-up. */
export function classify(f: ArrayLike<number>, templates: readonly Template[]): Pose {
  let best: Pose = 'none';
  let b = Infinity;
  let second = Infinity;
  for (const t of templates) {
    const v = templateDistance(f, t);
    if (v < b) {
      second = b;
      b = v;
      best = t.pose;
    } else if (v < second) second = v;
  }
  return b < T.accept && second - b > T.margin ? best : 'none';
}

/** Upward component of the palm's normal (1 = palm facing the ceiling). */
export function palmUp(j: ArrayLike<number>, left: boolean): number {
  const ax = j[18] - j[0], ay = j[19] - j[1], az = j[20] - j[2]; // index knuckle
  const bx = j[63] - j[0], by = j[64] - j[1], bz = j[65] - j[2]; // little-finger knuckle
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return (left ? -ny : ny) / len;
}

/**
 * Confirms a pose over time: it must hold for its confirm time, then fires
 * once. Frames of another pose shorter than the release time are ignored, so
 * a one-frame tracking glitch can neither fire nor restart a command.
 */
export class PoseFilter {
  held: Pose = 'none';
  fired = false;
  private since = 0;
  private lastSeen = 0;

  update(pose: Pose, t: number): Cmd | null {
    if (pose === this.held) this.lastSeen = t;
    else if (this.held !== 'none' && t - this.lastSeen < T.releaseMs) return null;
    else {
      this.held = pose;
      this.since = t;
      this.lastSeen = t;
      this.fired = false;
    }
    const need = T.confirmMs[this.held];
    if (need !== undefined && !this.fired && t - this.since >= need) {
      this.fired = true;
      return this.held as Cmd;
    }
    return null;
  }

  /** 0..1 confirm-ring progress for the held pose. */
  progress(t: number): number {
    const need = T.confirmMs[this.held];
    if (need === undefined) return 0;
    return this.fired ? 1 : clamp01((t - this.since) / need);
  }

  reset() {
    this.held = 'none';
    this.fired = false;
  }
}

/**
 * Re-records one signal: three steady samples of half a second each, with a
 * one-second gap between them. A sample restarts if the hand moves.
 */
export class Recorder {
  samples: number[][] = [];
  phase: 'hold' | 'gap' | 'done' = 'hold';
  private sum = [0, 0, 0, 0, 0];
  private n = 0;
  private holdT = 0;
  private gapT = 0;

  update(f: readonly number[] | null, dt: number) {
    if (this.phase === 'done') return;
    if (this.phase === 'gap') {
      this.gapT -= dt;
      if (this.gapT <= 0) this.phase = 'hold';
      return;
    }
    if (!f) return this.restart();
    if (this.n > 0) {
      for (let k = 0; k < 5; k++) if (Math.abs(f[k] - this.sum[k] / this.n) > 0.15) return this.restart(f);
    }
    for (let k = 0; k < 5; k++) this.sum[k] += f[k];
    this.n++;
    this.holdT += dt;
    if (this.holdT >= 0.5) {
      const sample = this.sum.map((v) => v / this.n);
      // The three samples must agree: a new shape (say, the hand still
      // changing from the last sign) starts the sign over from this sample.
      if (this.samples.length && sample.some((v, k) => Math.abs(v - this.samples[0][k]) > 0.15)) this.samples = [];
      this.samples.push(sample);
      this.restart();
      if (this.samples.length === 3) this.phase = 'done';
      else {
        this.phase = 'gap';
        this.gapT = 1;
      }
    }
  }

  /** 0..1 across all three samples. */
  get progress() {
    return Math.min(1, (this.samples.length + Math.min(1, this.holdT / 0.5)) / 3);
  }

  get template(): number[] {
    const t = [0, 0, 0, 0, 0];
    for (const s of this.samples) for (let k = 0; k < 5; k++) t[k] += s[k] / this.samples.length;
    return t;
  }

  private restart(f?: readonly number[]) {
    this.sum = f ? f.slice() : [0, 0, 0, 0, 0];
    this.n = f ? 1 : 0;
    this.holdT = 0;
  }
}

/** The other signal a new template is too close to, if any. */
export function clashWith(f: readonly number[], cmd: Cmd, templates: readonly Template[]): Cmd | null {
  for (const t of templates) {
    if (t.pose === cmd || t.pose === 'open' || t.pose === 'none') continue;
    let s = 0;
    for (let k = 0; k < 5; k++) s += (f[k] - t.f[k]) ** 2;
    if (Math.sqrt(s) < 0.3) return t.pose as Cmd;
  }
  return null;
}
