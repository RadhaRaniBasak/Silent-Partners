import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
} from '@iwsdk/core';
import type { Cmd } from '../core/recognize';
import type { Level } from '../level';

export const FONT = '"Atkinson Hyperlegible", system-ui, sans-serif';

export const COLOR = {
  lark: '#2ec4b6',
  rook: '#f4a261',
  bert: '#ff7b54',
  marge: '#ff5c9d',
  eye: '#ff3b4e',
  holo: '#7fdcff',
  text: '#ffffff',
  dim: '#a9b4c0',
  kite: '#1f4fd8',
  warn: '#ff5a5a',
} as const;

/** A flat plane showing canvas-drawn content. Call draw() to repaint. */
export class CanvasPlane {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: CanvasTexture;
  readonly material: MeshBasicMaterial;
  readonly mesh: Mesh;
  private key = '';

  constructor(
    readonly widthM: number,
    readonly heightM: number,
    pxPerM = 2400,
  ) {
    this.canvas.width = Math.round(widthM * pxPerM);
    this.canvas.height = Math.round(heightM * pxPerM);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.material = new MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(new PlaneGeometry(widthM, heightM), this.material);
  }

  get w() {
    return this.canvas.width;
  }

  get h() {
    return this.canvas.height;
  }

  /** Repaints only when the key changes. */
  draw(key: string, fn: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
    if (key === this.key) return;
    this.key = key;
    this.ctx.clearRect(0, 0, this.w, this.h);
    fn(this.ctx, this.w, this.h);
    this.texture.needsUpdate = true;
  }
}

/** Panel background with rounded corners. */
export function plate(ctx: CanvasRenderingContext2D, w: number, h: number, alpha = 0.78, radius = 0.12) {
  ctx.fillStyle = `rgba(10, 14, 22, ${alpha})`;
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, Math.min(w, h) * radius);
  ctx.fill();
}

/** Splits text into lines that fit a width. */
export function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxW && line) {
      out.push(line);
      line = word;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

/** The font size, at most `size`, at which `text` fits on one line of `maxW`. */
export function fitSize(ctx: CanvasRenderingContext2D, text: string, maxW: number, size: number, weight: 400 | 700): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  return size * Math.min(1, maxW / ctx.measureText(text).width);
}

/** Draws a centred line, colouring the crew's names. */
export function richLine(ctx: CanvasRenderingContext2D, line: string, cx: number, y: number, base: string) {
  const parts = line.split(/(Lark|Rook)/);
  let x = cx - ctx.measureText(line).width / 2;
  ctx.textAlign = 'left';
  for (const p of parts) {
    if (!p) continue;
    ctx.fillStyle = p === 'Lark' ? COLOR.lark : p === 'Rook' ? COLOR.rook : base;
    ctx.fillText(p, x, y);
    x += ctx.measureText(p).width;
  }
}

/** Text block: wrapped, centred, crew names coloured. */
export function textBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  w: number,
  y: number,
  size: number,
  weight: 400 | 700,
  color: string,
): number {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const line of wrap(ctx, text, w * 0.9)) {
    richLine(ctx, line, w / 2, y, color);
    y += size * 1.2;
  }
  return y;
}

/** Simple line icons for the three signals. */
export function glyph(ctx: CanvasRenderingContext2D, cmd: Cmd, cx: number, cy: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(3, s * 0.07);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const body = (x: number, y: number, w: number, h: number) => {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, s * 0.1);
    ctx.stroke();
  };
  if (cmd === 'thumb') {
    body(cx - 0.2 * s, cy - 0.08 * s, 0.48 * s, 0.42 * s);
    for (let k = 1; k <= 3; k++) {
      ctx.beginPath();
      ctx.moveTo(cx - 0.02 * s, cy - 0.08 * s + k * 0.105 * s);
      ctx.lineTo(cx + 0.28 * s, cy - 0.08 * s + k * 0.105 * s);
      ctx.stroke();
    }
    body(cx - 0.2 * s, cy - 0.5 * s, 0.15 * s, 0.46 * s);
  } else {
    body(cx - 0.3 * s, cy - 0.12 * s, 0.6 * s, 0.44 * s);
    for (let k = cmd === 'point' ? 1 : cmd === 'two' ? 2 : 0; k < 4; k++) {
      ctx.beginPath();
      ctx.arc(cx - 0.225 * s + k * 0.15 * s, cy - 0.12 * s, 0.075 * s, Math.PI, 0);
      ctx.stroke();
    }
    if (cmd === 'point' || cmd === 'two') body(cx - 0.3 * s, cy - 0.6 * s, 0.15 * s, 0.52 * s);
    if (cmd === 'two') body(cx - 0.15 * s, cy - 0.64 * s, 0.15 * s, 0.56 * s);
    ctx.beginPath();
    ctx.moveTo(cx - 0.3 * s, cy + 0.08 * s);
    ctx.lineTo(cx + 0.06 * s, cy + 0.08 * s);
    ctx.stroke();
  }
  ctx.restore();
}

export function checkMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = s * 0.14;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 0.32 * s, cy);
  ctx.lineTo(cx - 0.08 * s, cy + 0.25 * s);
  ctx.lineTo(cx + 0.35 * s, cy - 0.28 * s);
  ctx.stroke();
  ctx.restore();
}

/** A ring that fills clockwise from the top; the unfilled track stays faint. */
export function ringMaterial(color: string) {
  return new ShaderMaterial({
    uniforms: {
      color: { value: new Color(color) },
      progress: { value: 0 },
      opacity: { value: 1 },
      inner: { value: 0.72 },
      track: { value: 0.2 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform vec3 color; uniform float progress; uniform float opacity; uniform float inner; uniform float track;
      varying vec2 vUv;
      void main(){
        vec2 p = vUv * 2.0 - 1.0; float r = length(p);
        if (r > 1.0 || r < inner) discard;
        float a = atan(p.x, p.y); float u = (a < 0.0 ? a + 6.2831853 : a) / 6.2831853;
        float on = step(u, progress);
        float edge = smoothstep(1.0, 0.9, r) * smoothstep(inner, inner + 0.08, r);
        gl_FragColor = vec4(color, opacity * edge * mix(track, 1.0, on));
      }`,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    forceSinglePass: true,
  });
}

export function ringMesh(color: string, size: number) {
  const m = new Mesh(new PlaneGeometry(size, size), ringMaterial(color));
  m.renderOrder = 5;
  return m;
}

/**
 * A light cone on the model floor as a triangle fan, rebuilt each frame and
 * clipped to the room. Stripes (torch) or hatching (camera) keep the two
 * threats distinguishable without colour.
 */
export class Fan {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly pos: BufferAttribute;
  private readonly rays: number;

  constructor(color: string, hatch: boolean, rays = 20) {
    this.rays = rays;
    const geometry = new BufferGeometry();
    this.pos = new BufferAttribute(new Float32Array((rays + 2) * 3), 3);
    geometry.setAttribute('position', this.pos);
    const index: number[] = [];
    for (let i = 0; i < rays; i++) index.push(0, i + 1, i + 2);
    geometry.setIndex(index);
    this.material = new ShaderMaterial({
      uniforms: {
        color: { value: new Color(color) },
        opacity: { value: 0.5 },
        origin: { value: [0, 0] },
        range: { value: 1 },
        hatch: { value: hatch ? 1 : 0 },
      },
      vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform vec3 color; uniform float opacity; uniform vec2 origin; uniform float range; uniform float hatch;
        varying vec2 vP;
        void main(){
          float r = length(vP - origin) / range;
          float fade = (1.0 - smoothstep(0.7, 1.0, r)) * smoothstep(0.0, 0.06, r);
          float s = hatch > 0.5 ? sin((vP.x + vP.y) * 420.0) : sin(length(vP - origin) * 700.0);
          gl_FragColor = vec4(color, opacity * fade * (0.55 + 0.45 * step(0.0, s)));
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: DoubleSide,
      forceSinglePass: true,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  /**
   * Rebuilds the fan in model coordinates. ox/oz and range are in room metres;
   * toModel converts room coordinates to the model's local x/z. Rays stop at
   * the room's edge (w by d) and wherever `clip` says a wall is.
   */
  update(
    ox: number,
    oz: number,
    angle: number,
    half: number,
    range: number,
    scale: number,
    offX: number,
    offZ: number,
    y: number,
    w = 12,
    d = 8,
    clip?: (x: number, z: number, dx: number, dz: number, t: number) => number,
  ) {
    const a = this.pos.array as Float32Array;
    a[0] = ox * scale + offX;
    a[1] = y;
    a[2] = oz * scale + offZ;
    for (let i = 0; i <= this.rays; i++) {
      const ang = angle - half + (2 * half * i) / this.rays;
      const dx = Math.cos(ang);
      const dz = Math.sin(ang);
      let t = range;
      // Clip to the room, then to its walls.
      if (dx > 1e-6) t = Math.min(t, (w - ox) / dx);
      if (dx < -1e-6) t = Math.min(t, -ox / dx);
      if (dz > 1e-6) t = Math.min(t, (d - oz) / dz);
      if (dz < -1e-6) t = Math.min(t, -oz / dz);
      if (clip) t = clip(ox, oz, dx, dz, t);
      t = Math.max(0, t);
      a[(i + 1) * 3] = (ox + dx * t) * scale + offX;
      a[(i + 1) * 3 + 1] = y;
      a[(i + 1) * 3 + 2] = (oz + dz * t) * scale + offZ;
    }
    this.pos.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    const u = this.material.uniforms;
    (u.origin.value as number[])[0] = a[0];
    (u.origin.value as number[])[1] = a[2];
    u.range.value = range * scale;
  }
}

/** The Blue Kite (Ines Varga, 1931): an original drawing for this game. */
export function drawKite(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#0b2a8f');
  sky.addColorStop(1, '#2f6fe8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d9b44a';
  ctx.lineWidth = w * 0.05;
  ctx.strokeRect(0, 0, w, h);
  const cx = w * 0.58, cy = h * 0.4, k = w * 0.16;
  ctx.fillStyle = '#f7f3e3';
  ctx.beginPath();
  ctx.moveTo(cx, cy - k);
  ctx.lineTo(cx + k * 0.75, cy);
  ctx.lineTo(cx, cy + k * 1.3);
  ctx.lineTo(cx - k * 0.75, cy);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#f7f3e3';
  ctx.lineWidth = w * 0.012;
  ctx.beginPath();
  ctx.moveTo(cx, cy + k * 1.3);
  ctx.bezierCurveTo(cx - k, cy + k * 2, cx + k * 0.2, cy + k * 2.4, cx - k * 1.4, h * 0.95);
  ctx.stroke();
  for (let i = 1; i <= 3; i++) {
    ctx.fillStyle = '#ffcf4a';
    ctx.beginPath();
    ctx.arc(cx - k * 0.35 * i, cy + k * (1.45 + 0.28 * i), w * 0.02, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Aurelio Vance, smug in oils. Also original. */
export function drawVance(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#3b2a1f';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d9b44a';
  ctx.lineWidth = w * 0.06;
  ctx.strokeRect(0, 0, w, h);
  ctx.fillStyle = '#e6c3a5';
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.5, w * 0.25, h * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#1b1b1b';
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.27, w * 0.27, h * 0.1, 0, Math.PI, 0);
  ctx.fill();
  ctx.lineWidth = w * 0.035;
  ctx.strokeStyle = '#1b1b1b';
  ctx.beginPath();
  ctx.moveTo(w * 0.36, h * 0.6);
  ctx.quadraticCurveTo(w * 0.5, h * 0.55, w * 0.64, h * 0.6);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.4, h * 0.68);
  ctx.quadraticCurveTo(w * 0.52, h * 0.72, w * 0.6, h * 0.66);
  ctx.stroke();
  ctx.fillStyle = '#1b1b1b';
  for (const x of [0.41, 0.59]) {
    ctx.beginPath();
    ctx.ellipse(w * x, h * 0.46, w * 0.03, h * 0.012, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The mark: Lark's circle over Rook's triangle make a keyhole. */
export function drawMark(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.fillStyle = COLOR.rook;
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 0.12);
  ctx.lineTo(cx + s * 0.3, cy + s * 0.5);
  ctx.lineTo(cx - s * 0.3, cy + s * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = COLOR.lark;
  ctx.beginPath();
  ctx.arc(cx, cy - s * 0.18, s * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The title card over the table at the start of a run. */
export function drawTitle(ctx: CanvasRenderingContext2D, w: number, h: number, L: Level) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgba(6, 14, 22, 0)');
  g.addColorStop(0.5, 'rgba(6, 14, 22, 0.55)');
  g.addColorStop(1, 'rgba(6, 14, 22, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  drawMark(ctx, w * 0.12, h * 0.44, h * 0.5);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.shadowColor = 'rgba(127, 220, 255, 0.8)';
  ctx.shadowBlur = h * 0.05;
  ctx.fillStyle = '#ffffff';
  const size = fitSize(ctx, 'SILENT PARTNERS', w * 0.72, h * 0.26, 700);
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.letterSpacing = `${size * 0.06}px`;
  ctx.fillText('SILENT PARTNERS', w * 0.22, h * 0.4);
  ctx.shadowBlur = 0;
  ctx.letterSpacing = `${h * 0.012}px`;
  ctx.font = `400 ${h * 0.085}px ${FONT}`;
  ctx.fillStyle = COLOR.dim;
  ctx.fillText(L.id === 'gallery' ? 'THE VANCE GALLERY  ·  23:42  ·  RAIN' : 'JOB 2  ·  HALLORAN’S  ·  02:10', w * 0.225, h * 0.68);
  const line = ctx.createLinearGradient(w * 0.22, 0, w * 0.94, 0);
  line.addColorStop(0, COLOR.lark);
  line.addColorStop(1, COLOR.rook);
  ctx.fillStyle = line;
  ctx.fillRect(w * 0.225, h * 0.55, w * 0.71, h * 0.012);
  ctx.letterSpacing = '0px';
}

/** The projector's glass bed: frame, rulers, north, scale and the room's name. */
export function drawBed(ctx: CanvasRenderingContext2D, w: number, h: number, L: Level) {
  const k = w / 0.72;
  ctx.fillStyle = 'rgba(3, 10, 16, 0.94)';
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 0.02 * k);
  ctx.fill();
  const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.5);
  glow.addColorStop(0, 'rgba(60, 170, 220, 0.18)');
  glow.addColorStop(1, 'rgba(60, 170, 220, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  // The model's footprint on the bed, centred.
  const RW = L.job.w;
  const RD = L.job.d;
  const mw = RW * L.scale * k;
  const mh = RD * L.scale * k;
  const x0 = (w - mw) / 2;
  const y0 = (h - mh) / 2;
  ctx.strokeStyle = 'rgba(127, 220, 255, 0.45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x0 - 6, y0 - 6, mw + 12, mh + 12);
  // A ruler tick every metre of the room.
  ctx.strokeStyle = 'rgba(127, 220, 255, 0.5)';
  for (let i = 0; i <= RW; i++) {
    const x = x0 + (i / RW) * mw;
    const len = i % 2 ? 6 : 12;
    ctx.beginPath();
    ctx.moveTo(x, y0 + mh + 8);
    ctx.lineTo(x, y0 + mh + 8 + len);
    ctx.moveTo(x, y0 - 8);
    ctx.lineTo(x, y0 - 8 - len);
    ctx.stroke();
  }
  for (let i = 0; i <= RD; i++) {
    const y = y0 + (i / RD) * mh;
    const len = i % 2 ? 6 : 12;
    ctx.beginPath();
    ctx.moveTo(x0 - 8, y);
    ctx.lineTo(x0 - 8 - len, y);
    ctx.moveTo(x0 + mw + 8, y);
    ctx.lineTo(x0 + mw + 8 + len, y);
    ctx.stroke();
  }
  // Corner brackets.
  ctx.strokeStyle = COLOR.holo;
  ctx.lineWidth = 4;
  const c = 0.03 * k;
  for (const [x, y, dx, dy] of [[8, 8, 1, 1], [w - 8, 8, -1, 1], [8, h - 8, 1, -1], [w - 8, h - 8, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * c);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * c, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(190, 235, 255, 0.85)';
  ctx.font = `700 ${0.014 * k}px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.letterSpacing = `${0.002 * k}px`;
  const ty = h - 0.017 * k;
  ctx.fillText(L.id === 'gallery' ? 'THE VANCE GALLERY  ·  LEVEL 2' : 'HALLORAN’S AUCTION HOUSE  ·  GROUND FLOOR', Math.max(x0, 0.06 * k), ty);
  // Scale bar: two metres.
  const sx = x0 + mw - (2 / RW) * mw;
  ctx.fillRect(sx, ty - 0.002 * k, (2 / RW) * mw, 3);
  ctx.textAlign = 'right';
  ctx.fillText('2 m', sx - 0.006 * k, ty);
  // North.
  ctx.textAlign = 'center';
  ctx.fillText('N', x0 + mw - 0.01 * k, 0.022 * k);
  ctx.beginPath();
  ctx.moveTo(x0 + mw + 0.012 * k, 0.012 * k);
  ctx.lineTo(x0 + mw + 0.018 * k, 0.03 * k);
  ctx.lineTo(x0 + mw + 0.006 * k, 0.03 * k);
  ctx.closePath();
  ctx.fill();
  ctx.letterSpacing = '0px';
}

/** Two pieces from the Vance collection: original compositions, gilt frames. */
export function drawAbstract(i: number) {
  return (ctx: CanvasRenderingContext2D, w: number, h: number) => {
    if (i === 0) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#f2b45a');
      sky.addColorStop(1, '#c4462e');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
      for (let r = 4; r >= 1; r--) {
        ctx.fillStyle = `rgba(255, 236, 190, ${0.12 * r})`;
        ctx.beginPath();
        ctx.arc(w * 0.62, h * 0.58, (r * h) / 7, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#3b1f2b';
      ctx.fillRect(0, h * 0.72, w, h * 0.28);
    } else {
      for (const [x, cw, col] of [[0, 0.38, '#2d5a6b'], [0.38, 0.3, '#d9c9a3'], [0.68, 0.32, '#8a2f3c']] as const) {
        ctx.fillStyle = col;
        ctx.fillRect(x * w, 0, cw * w, h);
      }
    }
    ctx.strokeStyle = '#d9b44a';
    ctx.lineWidth = w * 0.06;
    ctx.strokeRect(0, 0, w, h);
  };
}
