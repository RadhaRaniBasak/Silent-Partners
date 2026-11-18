import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  ShaderMaterial,
  SphereGeometry,
} from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { COLOR, CanvasPlane, FONT } from './draw';

/** What the van's screens show; filled in by the view each frame. */
export interface VanInfo {
  /** Seconds into the job, for the CCTV clocks. */
  clock: number;
  eyeLive: boolean;
  /** What the second screen watches. */
  eyeLabel: string;
  alarm: boolean;
}

const MONO = '"Atkinson Hyperlegible", ui-monospace, monospace';

/** 11:42 PM plus the time on the job. */
export function jobClock(seconds: number) {
  const t = 23 * 3600 + 42 * 60 + Math.floor(seconds);
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * The surveillance van around the player: ribbed walls, a CCTV bank on the
 * left, a rack on the right, the planning board up front and rain on the
 * rear windows. Screens repaint a few times a second; the rest is static.
 */
export class Van {
  readonly group = new Group();
  private readonly screens: CanvasPlane[] = [];
  private readonly rack: CanvasPlane;
  private readonly rec: Mesh;
  private readonly rain: ShaderMaterial;
  private readonly lines: string[] = [];
  private lastPaint = -1;
  private seed = 1;
  private statics: HTMLCanvasElement[] = [];

  constructor() {
    const g = this.group;
    // Shell: the inside of a box, with steel ribs along both walls.
    const shell = new Mesh(new BoxGeometry(2.2, 1.9, 3.2), new MeshStandardMaterial({ color: '#221c18', roughness: 0.92, side: DoubleSide }));
    shell.position.y = 0.95;
    const ribs = [];
    for (let i = 0; i < 7; i++) {
      for (const x of [-1.08, 1.08]) {
        const r = new BoxGeometry(0.04, 1.8, 0.07);
        r.translate(x, 0.95, -1.35 + i * 0.45);
        ribs.push(r);
      }
      const top = new BoxGeometry(2.1, 0.04, 0.07);
      top.translate(0, 1.86, -1.35 + i * 0.45);
      ribs.push(top);
    }
    const ribMesh = new Mesh(mergeGeometries(ribs), new MeshStandardMaterial({ color: '#3a322b', roughness: 0.6, metalness: 0.5 }));
    const floor = new Mesh(new PlaneGeometry(2.2, 3.2), new MeshStandardMaterial({ color: '#141210', roughness: 0.85, map: plateTexture() }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.002;
    const strip = new Mesh(new BoxGeometry(1.6, 0.015, 0.03), new MeshBasicMaterial({ color: '#ffb36b', toneMapped: false }));
    strip.position.set(0, 1.84, -0.7);
    const bulb = new Mesh(new SphereGeometry(0.035, 12, 8), new MeshBasicMaterial({ color: '#ffd9a0', toneMapped: false }));
    bulb.position.set(0.45, 1.78, 0.35);
    g.add(shell, ribMesh, floor, strip, bulb);

    // CCTV bank on the left, angled toward the seat.
    const bezelMat = new MeshStandardMaterial({ color: '#111316', roughness: 0.5, metalness: 0.3 });
    const angles = [52, 78, 104];
    for (let i = 0; i < 3; i++) {
      const a = (angles[i] * Math.PI) / 180;
      const d = 0.98;
      const screen = new CanvasPlane(0.4, 0.27, 900);
      const bezel = new Mesh(new BoxGeometry(0.46, 0.33, 0.06), bezelMat);
      const holder = new Group();
      holder.position.set(-Math.sin(a) * d, 1.26, -Math.cos(a) * d);
      holder.rotation.y = a;
      bezel.position.z = -0.035;
      holder.add(bezel, screen.mesh);
      g.add(holder);
      this.screens.push(screen);
    }
    this.rec = new Mesh(new SphereGeometry(0.008, 8, 6), new MeshBasicMaterial({ color: '#ff3040', toneMapped: false }));
    this.rec.position.set(-0.68, 1.47, -0.7);
    g.add(this.rec);

    // Equipment rack on the right.
    this.rack = new CanvasPlane(0.42, 0.62, 700);
    const rackHolder = new Group();
    const ra = (-80 * Math.PI) / 180;
    rackHolder.position.set(-Math.sin(ra) * 1.0, 0.95, -Math.cos(ra) * 1.0);
    rackHolder.rotation.y = ra;
    const rackBox = new Mesh(new BoxGeometry(0.48, 0.7, 0.2), bezelMat);
    rackBox.position.z = -0.105;
    rackHolder.add(rackBox, this.rack.mesh);
    g.add(rackHolder);

    // The planning board, high on the front wall so it never sits behind a prompt.
    const board = new CanvasPlane(1.0, 0.5, 900);
    board.draw('board', drawBoard);
    board.material.transparent = false;
    board.material.color = new Color(0.55, 0.55, 0.55);
    board.mesh.position.set(-0.62, 1.66, -1.57);
    board.mesh.scale.setScalar(0.85);
    g.add(board.mesh);

    // Rain on the two rear windows.
    this.rain = new ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `
        uniform float uTime; varying vec2 vUv;
        float h(float n){ return fract(sin(n) * 43758.5453); }
        void main(){
          vec3 c = mix(vec3(0.02, 0.03, 0.06), vec3(0.05, 0.08, 0.14), vUv.y);
          for (int i = 0; i < 3; i++) {
            vec2 b = vec2(h(float(i) * 7.1), 0.25 + 0.5 * h(float(i) * 3.7));
            c += vec3(1.0, 0.7, 0.35) * 0.06 / (1.0 + 400.0 * dot(vUv - b, vUv - b));
          }
          float col = floor(vUv.x * 60.0);
          float speed = 0.6 + h(col) * 0.9;
          float y = fract(vUv.y + uTime * speed + h(col * 1.3));
          float streak = smoothstep(0.0, 0.03, y) * (1.0 - smoothstep(0.03, 0.16, y)) * step(0.72, h(col * 2.9));
          c += vec3(0.35, 0.45, 0.6) * streak * 0.5;
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    for (const x of [-0.32, 0.32]) {
      const win = new Mesh(new PlaneGeometry(0.42, 0.3), this.rain);
      win.position.set(x, 1.35, 1.585);
      win.rotation.y = Math.PI;
      g.add(win);
    }
  }

  /** A line for the signal terminal, newest last. */
  log(line: string, clock: number) {
    this.lines.push(`${jobClock(clock)}  ${line}`);
    if (this.lines.length > 7) this.lines.shift();
    this.lastPaint = -1;
  }

  clearLog() {
    this.lines.length = 0;
    this.lastPaint = -1;
  }

  update(info: VanInfo, now: number) {
    this.rain.uniforms.uTime.value = now / 1000;
    (this.rec.material as MeshBasicMaterial).color.set(Math.floor(now / 600) % 2 ? '#ff3040' : '#3a0a10');
    // Each screen repaints four times a second, but in turn: no frame pays for
    // more than one canvas repaint and texture upload.
    const tick = Math.floor(now / 62.5);
    if (tick === this.lastPaint) return;
    this.lastPaint = tick;
    this.seed = tick;
    const time = jobClock(info.clock);
    const slot = tick % 4;
    if (slot === 0) this.screens[0].draw(`cam|${tick}`, (ctx, w, h) => this.cctv(ctx, w, h, 'CAM 02  WEST STAIR', time, false));
    else if (slot === 1)
      this.screens[1].draw(`eye|${tick}|${info.eyeLive}|${info.eyeLabel}`, (ctx, w, h) =>
        info.eyeLive ? this.cctv(ctx, w, h, info.eyeLabel, time, true) : this.noSignal(ctx, w, h, time, tick),
      );
    // The terminal only changes with its lines.
    else if (slot === 2) this.screens[2].draw(`log|${this.lines.join('|')}|${info.alarm}`, (ctx, w, h) => this.terminal(ctx, w, h, info.alarm));
    else this.rack.draw(`rack|${Math.floor(now / 400)}`, (ctx, w, h) => this.drawRack(ctx, w, h));
  }

  private rand() {
    this.seed = (this.seed * 16807 + 11) % 2147483647;
    return this.seed / 2147483647;
  }

  private screenBase(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.fillStyle = '#05080a';
    ctx.fillRect(0, 0, w, h);
  }

  private overlay(ctx: CanvasRenderingContext2D, w: number, h: number, label: string, time: string, live: boolean) {
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
    ctx.font = `700 ${h * 0.075}px ${MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#d8f0e0';
    ctx.fillText(label, w * 0.04, h * 0.05);
    ctx.textAlign = 'right';
    ctx.fillText(time, w * 0.96, h * 0.86);
    if (live) {
      ctx.fillStyle = COLOR.eye;
      ctx.beginPath();
      ctx.arc(w * 0.89, h * 0.09, h * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText('LIVE', w * 0.86, h * 0.05);
    }
  }

  /** A grainy line drawing of a gallery corridor. */
  private cctv(ctx: CanvasRenderingContext2D, w: number, h: number, label: string, time: string, live: boolean) {
    this.screenBase(ctx, w, h);
    const vx = w * 0.55;
    const vy = h * 0.45;
    ctx.strokeStyle = 'rgba(150, 210, 170, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      ctx.moveTo(x, y);
      ctx.lineTo(vx + (x - vx) * 0.22, vy + (y - vy) * 0.22);
    }
    ctx.rect(vx - w * 0.11, vy - h * 0.11, w * 0.22, h * 0.22);
    for (let k = 1; k < 4; k++) {
      const u = 1 - k * 0.22;
      ctx.rect(vx - (vx * u), vy - vy * u, w * u, h * u);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(150, 210, 170, 0.25)';
    ctx.fillRect(vx + w * 0.2, vy - h * 0.12, w * 0.07, h * 0.1);
    ctx.fillRect(vx - w * 0.3, vy - h * 0.14, w * 0.08, h * 0.11);
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(200,255,220,${this.rand() * 0.18})`;
      ctx.fillRect(this.rand() * w, this.rand() * h, 2, 2);
    }
    this.overlay(ctx, w, h, label, time, live);
  }

  /** Four frames of static, drawn once and cycled. */
  private staticFrame(w: number, h: number, i: number) {
    if (this.statics[0]?.width !== w || this.statics[0]?.height !== h) {
      this.statics = [0, 1, 2, 3].map(() => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const x2 = c.getContext('2d')!;
        for (let y = 0; y < h; y += 6) {
          for (let x = 0; x < w; x += 6) {
            const v = Math.floor(this.rand() * 90);
            x2.fillStyle = `rgb(${v},${v},${v})`;
            x2.fillRect(x, y, 6, 6);
          }
        }
        return c;
      });
    }
    return this.statics[i % 4];
  }

  private noSignal(ctx: CanvasRenderingContext2D, w: number, h: number, time: string, tick: number) {
    ctx.drawImage(this.staticFrame(w, h, tick), 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h * 0.38, w, h * 0.24);
    ctx.font = `700 ${h * 0.12}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('NO SIGNAL', w / 2, h / 2);
    this.overlay(ctx, w, h, 'THE EYE  EAST HALL', time, false);
  }

  private terminal(ctx: CanvasRenderingContext2D, w: number, h: number, alarm: boolean) {
    this.screenBase(ctx, w, h);
    ctx.font = `700 ${h * 0.075}px ${MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = alarm ? COLOR.warn : '#7dffb0';
    ctx.fillText(alarm ? 'SIGNALS  ! ALERT' : 'SIGNALS', w * 0.04, h * 0.05);
    ctx.font = `400 ${h * 0.068}px ${MONO}`;
    this.lines.forEach((l, i) => {
      ctx.fillStyle = l.includes('LARK') ? COLOR.lark : l.includes('ROOK') ? COLOR.rook : l.includes('!') ? COLOR.warn : '#b8e8c8';
      ctx.fillText(l, w * 0.04, h * (0.2 + i * 0.105));
    });
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  }

  private drawRack(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.fillStyle = '#0d0f12';
    ctx.fillRect(0, 0, w, h);
    const units = 6;
    for (let u = 0; u < units; u++) {
      const y = (u / units) * h;
      ctx.fillStyle = u % 2 ? '#1a1d22' : '#16181c';
      ctx.fillRect(w * 0.03, y + 4, w * 0.94, h / units - 8);
      for (let k = 0; k < 8; k++) {
        const on = this.rand() > 0.45;
        ctx.fillStyle = on ? (k % 3 === 0 ? '#ffb36b' : '#5dffa0') : '#1f2a22';
        ctx.fillRect(w * (0.08 + k * 0.05), y + h / units / 2 - 4, 8, 8);
      }
      const level = this.rand();
      ctx.fillStyle = '#2a3138';
      ctx.fillRect(w * 0.55, y + h / units / 2 - 6, w * 0.36, 12);
      ctx.fillStyle = level > 0.8 ? '#ff7b54' : '#7fdcff';
      ctx.fillRect(w * 0.55, y + h / units / 2 - 6, w * 0.36 * level, 12);
    }
  }
}

/** Diamond tread on the van floor. */
function plateTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#2a2622';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#3d3731';
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  for (const [x, y, d] of [[24, 24, 1], [88, 24, -1], [24, 88, -1], [88, 88, 1]]) {
    ctx.beginPath();
    ctx.moveTo(x - 12, y - 12 * d);
    ctx.lineTo(x + 12, y + 12 * d);
    ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(10, 14);
  return t;
}

/** The crew's planning board: floor plan, two polaroids, red string. */
function drawBoard(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = '#6b4b32';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(${40 + Math.random() * 30}, ${25 + Math.random() * 20}, 10, 0.25)`;
    ctx.fillRect(Math.random() * w, Math.random() * h, 3, 3);
  }
  // Blueprint.
  ctx.fillStyle = '#16407a';
  ctx.fillRect(w * 0.05, h * 0.1, w * 0.45, h * 0.78);
  ctx.strokeStyle = '#cfe6ff';
  ctx.lineWidth = 3;
  ctx.strokeRect(w * 0.09, h * 0.2, w * 0.37, h * 0.55);
  ctx.beginPath();
  ctx.moveTo(w * 0.27, h * 0.2);
  ctx.lineTo(w * 0.27, h * 0.4);
  ctx.moveTo(w * 0.09, h * 0.52);
  ctx.lineTo(w * 0.2, h * 0.52);
  ctx.stroke();
  ctx.font = `700 ${h * 0.06}px ${FONT}`;
  ctx.fillStyle = '#cfe6ff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('VANCE GALLERY  2F', w * 0.09, h * 0.12);
  // Polaroids of the crew.
  const polaroid = (x: number, name: string, color: string, tri: boolean) => {
    ctx.save();
    ctx.translate(x, h * 0.35);
    ctx.rotate(tri ? 0.08 : -0.06);
    ctx.fillStyle = '#efe9dc';
    ctx.fillRect(-w * 0.07, -h * 0.2, w * 0.14, h * 0.4);
    ctx.fillStyle = '#20252b';
    ctx.fillRect(-w * 0.06, -h * 0.17, w * 0.12, h * 0.26);
    ctx.fillStyle = color;
    ctx.beginPath();
    if (tri) {
      ctx.moveTo(0, -h * 0.12);
      ctx.lineTo(w * 0.035, -h * 0.0);
      ctx.lineTo(-w * 0.035, -h * 0.0);
    } else ctx.arc(0, -h * 0.05, h * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2b2b2b';
    ctx.font = `700 ${h * 0.055}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(name, 0, h * 0.11);
    ctx.restore();
  };
  polaroid(w * 0.64, 'LARK', COLOR.lark, false);
  polaroid(w * 0.84, 'ROOK', COLOR.rook, true);
  // Sticky note and string.
  ctx.save();
  ctx.translate(w * 0.74, h * 0.76);
  ctx.rotate(-0.05);
  ctx.fillStyle = '#ffe36b';
  ctx.fillRect(-w * 0.09, -h * 0.1, w * 0.18, h * 0.2);
  ctx.fillStyle = '#3a3000';
  ctx.font = `700 ${h * 0.055}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('NO TALKING', 0, 0);
  ctx.restore();
  ctx.strokeStyle = '#c0392b';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h * 0.45);
  ctx.lineTo(w * 0.64, h * 0.3);
  ctx.lineTo(w * 0.84, h * 0.3);
  ctx.stroke();
  for (const [x, y] of [[0.3, 0.45], [0.64, 0.3], [0.84, 0.3]]) {
    ctx.fillStyle = '#d93a2b';
    ctx.beginPath();
    ctx.arc(w * x, h * y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

