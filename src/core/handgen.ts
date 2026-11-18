import { DEG } from '../tuning';

/**
 * Synthetic hands: joint positions for a pose, in hand space. Used by the
 * checks and by the ghost hand that demonstrates a signal.
 * Hand space: origin at the wrist, x toward the thumb, y along the fingers,
 * z out of the palm. Built as a right hand; a left hand mirrors x.
 */

export interface HandShape {
  curls: [number, number, number, number];
  /** 0 thumb tucked across the fingers, 1 thumb up. */
  thumb: number;
  /** Blend toward a relaxed, sideways thumb (open hand). */
  side: number;
}

export const SHAPES = {
  fist: { curls: [1, 1, 1, 1], thumb: 0, side: 0 },
  point: { curls: [0, 1, 1, 1], thumb: 0, side: 0 },
  thumb: { curls: [1, 1, 1, 1], thumb: 1, side: 0 },
  two: { curls: [0, 0, 1, 1], thumb: 0, side: 0 },
  open: { curls: [0, 0, 0, 0], thumb: 0, side: 1 },
  relaxed: { curls: [0.35, 0.4, 0.45, 0.5], thumb: 0.3, side: 0.5 },
} satisfies Record<string, HandShape>;

const KNUCKLE = [[0.024, 0.086], [0.004, 0.089], [-0.014, 0.084], [-0.03, 0.076]];
const META = [[0.014, 0.02], [0.004, 0.02], [-0.008, 0.02], [-0.018, 0.018]];
const SEG = [[0.042, 0.025, 0.021], [0.046, 0.029, 0.022], [0.043, 0.027, 0.021], [0.034, 0.021, 0.019]];
const FLEX = [85 * DEG, 105 * DEG, 70 * DEG];
const THUMB_TUCK = [[0.018, 0.012, 0.008], [0.04, 0.04, 0.022], [0.03, 0.062, 0.04], [0.012, 0.072, 0.046]];
const THUMB_UP = [[0.018, 0.012, 0.008], [0.046, 0.038, 0.01], [0.074, 0.05, 0.008], [0.098, 0.058, 0.006]];
const THUMB_SIDE = [[0.018, 0.012, 0.008], [0.045, 0.04, 0.012], [0.066, 0.06, 0.012], [0.082, 0.078, 0.01]];

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export function lerpShape(a: HandShape, b: HandShape, u: number): HandShape {
  return {
    curls: [0, 1, 2, 3].map((k) => lerp(a.curls[k], b.curls[k], u)) as HandShape['curls'],
    thumb: lerp(a.thumb, b.thumb, u),
    side: lerp(a.side, b.side, u),
  };
}

export function handJoints(sh: HandShape, left = false, scale = 1, out = new Float32Array(75)): Float32Array {
  const set = (i: number, x: number, y: number, z: number) => {
    out[i * 3] = (left ? -x : x) * scale;
    out[i * 3 + 1] = y * scale;
    out[i * 3 + 2] = z * scale;
  };
  set(0, 0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const a = THUMB_TUCK[i], b = THUMB_UP[i], c = THUMB_SIDE[i];
    set(
      1 + i,
      lerp(lerp(a[0], b[0], sh.thumb), c[0], sh.side),
      lerp(lerp(a[1], b[1], sh.thumb), c[1], sh.side),
      lerp(lerp(a[2], b[2], sh.thumb), c[2], sh.side),
    );
  }
  for (let f = 0; f < 4; f++) {
    const base = 5 + f * 5;
    set(base, META[f][0], META[f][1], 0);
    const x = KNUCKLE[f][0];
    let y = KNUCKLE[f][1];
    let z = 0;
    set(base + 1, x, y, z);
    let ang = 0;
    for (let s = 0; s < 3; s++) {
      ang += FLEX[s] * sh.curls[f];
      y += Math.cos(ang) * SEG[f][s];
      z += Math.sin(ang) * SEG[f][s];
      set(base + 2 + s, x, y, z);
    }
  }
  return out;
}
