import {
  AdditiveBlending,
  BoxGeometry,
  EdgesGeometry,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DEG, T } from '../tuning';
import { type Level, type SpotId, level as levelOf } from '../level';
import type { Game, HandId } from '../core/game';
import { BONES, type Cmd } from '../core/recognize';
import { ACTION_TIME, type Thief, type ThiefId } from '../core/sim';
import { type HandShape, SHAPES, handJoints, lerpShape } from '../core/handgen';
import { COLOR, CanvasPlane, FONT, Fan, checkMark, drawAbstract, drawBed, drawKite, drawTitle, drawVance, fitSize, glyph, plate, ringMesh, textBlock, wrap } from './draw';
import { Figure, type FigurePose } from './figure';
import { HOLO, holoize } from './holo';
import { eyeProps, fuseProps, galleryProps, halloranProps, heronProps, PropBatch } from './props';
import { Van } from './van';

/**
 * Room metres to hologram metres: the room's centre sits at the anchor. A
 * bigger job is scaled down as a whole (the hologram group's scale), so S is
 * the same for every job and everything inside keeps its proportions.
 */
export const S = T.modelScale;
let OX = -6 * S;
let OZ = -4 * S;
export const toModel = (x: number, z: number, out: Vector3, y = 0) => out.set(x * S + OX, y, z * S + OZ);
export const fromModel = (v: Vector3) => [(v.x - OX) / S, (v.z - OZ) / S] as const;

/** What the headset layer knows about a hand this frame, in world space. */
export interface HandFrame {
  tracked: boolean;
  joints: Float32Array;
  inZone: boolean;
  nearEdge: boolean;
  aimHit: Vector3 | null;
  aimSpot: SpotId | null;
  palm: Vector3;
}

/** A hand drawn as glowing joints and bones. */
export class HandMesh {
  readonly group = new Group();
  readonly material = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: DoubleSide, forceSinglePass: true });
  readonly glowMaterial = new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.12, toneMapped: false, depthWrite: false, blending: AdditiveBlending });
  private readonly dots: InstancedMesh;
  private readonly glow: InstancedMesh;
  private readonly palm: Mesh;
  private readonly palmPos = new Float32Array(6 * 3);
  private readonly bones: InstancedMesh;
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly v = new Vector3();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly s = new Vector3();
  private static readonly UP = new Vector3(0, 1, 0);

  constructor() {
    this.dots = new InstancedMesh(new SphereGeometry(1, 10, 8), this.material, 25);
    this.bones = new InstancedMesh(new CylinderGeometry(1, 1, 1, 6, 1, true), this.material, BONES.length);
    this.glow = new InstancedMesh(new SphereGeometry(1, 8, 6), this.glowMaterial, 6);
    // The palm: a fan from the wrist across the thumb base and the knuckles.
    const pg = new BufferGeometry();
    pg.setAttribute('position', new BufferAttribute(this.palmPos, 3));
    pg.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5]);
    this.palm = new Mesh(pg, this.material);
    this.palm.frustumCulled = false;
    this.palm.renderOrder = 10;
    this.group.add(this.palm);
    for (const m of [this.dots, this.bones, this.glow]) {
      m.frustumCulled = false;
      m.renderOrder = 10;
      this.group.add(m);
    }
  }

  update(j: ArrayLike<number>) {
    this.q.identity();
    for (let i = 0; i < 25; i++) {
      const r = i === 0 ? 0.0095 : i % 5 === 4 ? 0.0066 : i < 5 ? 0.0068 : 0.0062;
      this.v.set(j[i * 3], j[i * 3 + 1], j[i * 3 + 2]);
      this.s.setScalar(r);
      this.m.compose(this.v, this.q, this.s);
      this.dots.setMatrixAt(i, this.m);
      // A soft glow on the wrist and each fingertip only.
      if (i === 0 || i % 5 === 4) {
        this.s.setScalar(r * 2.3);
        this.m.compose(this.v, this.q, this.s);
        this.glow.setMatrixAt(i === 0 ? 0 : (i + 1) / 5, this.m);
      }
    }
    for (let k = 0; k < BONES.length; k++) {
      const [ia, ib] = BONES[k];
      this.a.set(j[ia * 3], j[ia * 3 + 1], j[ia * 3 + 2]);
      this.b.set(j[ib * 3], j[ib * 3 + 1], j[ib * 3 + 2]);
      this.v.subVectors(this.b, this.a);
      const len = this.v.length();
      if (len < 1e-5) this.s.set(0, 0, 0);
      else {
        this.q.setFromUnitVectors(HandMesh.UP, this.v.divideScalar(len));
        this.s.set(0.0056, len, 0.0056);
      }
      this.v.addVectors(this.a, this.b).multiplyScalar(0.5);
      this.m.compose(this.v, this.q, this.s);
      this.bones.setMatrixAt(k, this.m);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
    [0, 2, 6, 11, 16, 21].forEach((jt, k) => {
      this.palmPos[k * 3] = j[jt * 3];
      this.palmPos[k * 3 + 1] = j[jt * 3 + 1];
      this.palmPos[k * 3 + 2] = j[jt * 3 + 2];
    });
    (this.palm.geometry.attributes.position as BufferAttribute).needsUpdate = true;
  }
}

interface Icon {
  plane: CanvasPlane;
  until: number;
}

const THIEVES: ThiefId[] = ['lark', 'rook'];
const HANDS: HandId[] = ['left', 'right'];

interface GuardLook {
  fig: Figure;
  fan: Fan;
  mark: CanvasPlane;
  route: LineSegments;
}
const GUARD_COLORS = [COLOR.bert, COLOR.marge];

/** Job 2's recon labels: text, where (room metres), and how high they float. */
const LABELS: [string, number, number, number][] = [
  ['POWER', 4.9, 0.7, 0.07],
  ['LIGHTS', 11.2, 0.8, 0.07],
  ['LASERS', 12.0, 5.5, 0.088],
  ['KEY', 13.6, 5.0, 0.066],
  ['KEY', 17.2, 5.0, 0.066],
  ['SENSOR', 15.8, 2.9, 0.08],
  ['HERON', 14.0, 1.8, 0.068],
  ['DOCK', 0.7, 9.6, 0.07],
];

type MatFn = (color: string, opacity: number) => MeshBasicMaterial;
type LineFn = (color: string, opacity: number) => LineBasicMaterial;

/**
 * Job 2's moving parts: the laser grid, the sensor's field, lit rooms, the
 * vault door, the Heron, recon labels and a tossed coin. Built into the
 * job's model, so they go when the next job is built.
 */
class Job2Look {
  private group = new Group();
  private lasers = new Group();
  private laserMat = new LineBasicMaterial();
  private lit: Mesh[] = [];
  private sensor = new Fan('#ff3b4e', true, 48);
  private sensorFor = -1;
  private door = new Group();
  private doorA = 0;
  private heron = new Group();
  private glass = new Group();
  private readonly heronHome = new Vector3();
  private labels: CanvasPlane[] = [];
  private coin = new Mesh();
  private level!: Level;

  build(L: Level, mat: MatFn, line: LineFn): Group {
    this.level = L;
    const g = (this.group = new Group());
    const v = new Vector3();
    const w = new Vector3();
    // Lasers: five beams and two diagonals across the vault hall's door, between two posts.
    const [lx, lz0, , lz1] = L.job.lasers!;
    const pts: number[] = [];
    const beam = (y0: number, y1: number) => {
      toModel(lx, lz0, v, y0 * S);
      toModel(lx, lz1, w, y1 * S);
      pts.push(v.x, v.y, v.z, w.x, w.y, w.z);
    };
    for (const y of [0.15, 0.35, 0.55, 0.75, 0.95]) beam(y, y);
    beam(0.15, 0.95);
    beam(0.95, 0.15);
    const lg = new BufferGeometry();
    lg.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
    this.laserMat = new LineBasicMaterial({ color: '#ff2a3c', transparent: true, opacity: 0.9, blending: AdditiveBlending, toneMapped: false, depthWrite: false });
    this.lasers = new Group();
    this.lasers.add(new LineSegments(lg, this.laserMat));
    const sheet = mat('#ff2a3c', 0.16);
    sheet.blending = AdditiveBlending;
    const curtain = new Mesh(new PlaneGeometry((lz1 - lz0) * S, 0.9 * S), sheet);
    toModel(lx, (lz0 + lz1) / 2, curtain.position, 0.55 * S);
    curtain.rotation.y = Math.PI / 2;
    this.lasers.add(curtain);
    g.add(this.lasers);
    g.add(new PropBatch().box(0.1, 1.05, 0.1, lx, 0.52, lz0 - 0.05).box(0.1, 1.05, 0.1, lx, 0.52, lz1 + 0.05).build(S, OX, OZ, mat('#ff8a94', 0.45), line('#ffb0b8', 0.9)));
    // Lit rooms: a warm wash on the floor until the breaker goes.
    this.lit = (L.job.lit ?? []).map(([x0, z0, x1, z1]) => {
      const m = mat('#ffb84d', 0.2);
      m.blending = AdditiveBlending;
      const p = new Mesh(new PlaneGeometry((x1 - x0) * S, (z1 - z0) * S), m);
      p.rotation.x = -Math.PI / 2;
      toModel((x0 + x1) / 2, (z0 + z1) / 2, p.position, 0.0007);
      g.add(p);
      return p;
    });
    // The sensor's field, and the sensor itself on a stalk.
    const c = L.job.sensor!;
    this.sensor = new Fan('#ff3b4e', true, 48);
    this.sensorFor = -1;
    g.add(this.sensor.mesh);
    g.add(new PropBatch().cyl(0.02, 0.5, c.x, 0.75, c.z, 6).ball(0.09, c.x, 0.5, c.z).build(S, OX, OZ, mat('#ff6b78', 0.6), line('#ffb0b8', 0.9)));
    // The vault door, hinged at its west end; it swings north into the vault.
    const [vx0, vz] = L.job.vaultDoor!;
    const dg = new BoxGeometry(1.2 * S, 1.0 * S, 0.12 * S);
    dg.translate(0.6 * S, 0.5 * S, 0);
    this.door = new Group();
    this.door.add(new Mesh(dg, mat('#9fd8ff', 0.4)), new LineSegments(new EdgesGeometry(dg), line('#e6fbff', 0.9)));
    toModel(vx0, vz, this.door.position, 0);
    this.doorA = 0;
    g.add(this.door);
    // The Heron, gold, on its plinth in the glass case.
    this.heron = heronProps().build(S * 1.8, 0, 0, mat('#ffd166', 0.95), line('#fff1b8', 1));
    toModel(14.0, 1.3, this.heronHome, 0.9 * S);
    this.heron.position.copy(this.heronHome);
    g.add(this.heron);
    this.glass = new PropBatch().box(0.68, 1.15, 0.68, 14.0, 1.48, 1.3).build(S, OX, OZ, mat('#bfefff', 0.06), line('#e6fbff', 0.5));
    g.add(this.glass);
    // Labels for recon.
    this.labels = LABELS.map(([text, x, z, y]) => {
      const p = new CanvasPlane(0.05, 0.014, 2400);
      p.draw(`label|${text}`, (ctx, cw, ch) => {
        plate(ctx, cw, ch, 0.7, 0.35);
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 ${ch * 0.62}px ${FONT}`;
        ctx.letterSpacing = `${ch * 0.06}px`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, cw / 2, ch * 0.55);
        ctx.letterSpacing = '0px';
      });
      p.mesh.renderOrder = 15;
      toModel(x, z, p.mesh.position, y);
      g.add(p.mesh);
      return p;
    });
    // A tossed coin.
    this.coin = new Mesh(new CylinderGeometry(0.0034, 0.0034, 0.001, 14), new MeshBasicMaterial({ color: '#ffd166', toneMapped: false }));
    this.coin.visible = false;
    g.add(this.coin);
    return g;
  }

  sync(g: Game, alpha: number, now: number, dt: number, billboard: Quaternion, lark: Figure) {
    const s = g.sim.s;
    const L = this.level;
    // Lasers hum while powered.
    this.lasers.visible = s.lasersOn && alpha > 0.05;
    this.laserMat.opacity = alpha * (0.65 + 0.35 * Math.sin(now * 0.012));
    for (const m of this.lit) m.visible = s.lightsOn;
    // The sensor: faint while it rests, blinking before it looks, bright while armed.
    const key = s.vaultOpen ? 1 : 0;
    if (key !== this.sensorFor) {
      this.sensorFor = key;
      const c = L.job.sensor!;
      this.sensor.update(c.x, c.z, 0, Math.PI, c.r, S, OX, OZ, 0.0018, L.job.w, L.job.d, (x, z, dx, dz, t) => L.ray(x, z, dx, dz, t, s.vaultOpen));
    }
    const st = g.sim.sensor();
    const blink = Math.floor(now / 110) % 2 === 0;
    this.sensor.material.uniforms.opacity.value = alpha * (st === 'armed' ? 0.75 : st === 'warn' ? (blink ? 0.6 : 0.1) : 0.1);
    // The vault door swings open.
    this.doorA += ((s.vaultOpen ? Math.PI / 2 : 0) - this.doorA) * Math.min(1, dt * 3);
    this.door.rotation.y = this.doorA;
    // The Heron: in its case, then in Lark's hands.
    this.glass.visible = !s.loot;
    if (s.loot) {
      // Held in front of her, in both arms.
      this.heron.visible = lark.group.visible;
      this.heron.position.copy(lark.group.position).setY(0.04);
      this.heron.position.x += Math.cos(s.lark.face) * 0.013;
      this.heron.position.z += Math.sin(s.lark.face) * 0.013;
      this.heron.scale.setScalar(0.55);
    } else {
      this.heron.visible = true;
      this.heron.position.copy(this.heronHome);
      this.heron.scale.setScalar(1);
    }
    this.heron.rotation.y = s.loot ? -s.lark.face : 0.6;
    // Labels while planning (and when paused).
    const show = (g.beat === 1 || g.paused) && alpha > 0.2;
    for (const p of this.labels) {
      p.mesh.visible = show;
      p.mesh.quaternion.copy(billboard);
    }
    // A coin in the air, arcing to where it lands.
    const c = s.coin;
    this.coin.visible = !!c;
    if (c) {
      const u = Math.min(1, c.t / T.tossS);
      toModel(c.x0 + (c.x1 - c.x0) * u, c.z0 + (c.z1 - c.z0) * u, this.coin.position, 0.006 + 0.06 * u * (1 - u));
      this.coin.rotation.set(now * 0.02, 0, now * 0.013);
    }
  }
}

export class View {
  readonly root = new Group();
  readonly van = new Van();
  readonly anchor = new Group();
  readonly holo = new Group();
  readonly worldLayer = new Group();
  readonly prompt = new CanvasPlane(0.5, 0.075);
  readonly caption = new CanvasPlane(0.5, 0.05);
  readonly debug = new CanvasPlane(0.26, 0.2, 1600);
  private readonly holoMats: [Material, number][] = [];
  /** The job's own materials, dropped when the next job is built. */
  private modelMats: [Material, number][] = [];
  private mats = this.holoMats;
  /** Everything that belongs to the current job's plan. */
  private model = new Group();
  level: Level = levelOf('gallery');
  private readonly rings = new Map<SpotId, { ring: Mesh; fill: Mesh | null }>();
  private readonly figures: Record<ThiefId, Figure>;
  private readonly guards: GuardLook[] = [];
  private readonly beam = new Fan(COLOR.eye, true);
  private readonly bed = new CanvasPlane(0.72, 0.52, 1400);
  private readonly job2: Job2Look;
  private routesFor = '';
  private readonly meters: Record<ThiefId, Mesh>;
  private readonly progressRings: Record<ThiefId, Mesh>;
  private readonly checks: Record<ThiefId, Icon>;
  private readonly route: Line;
  private routeT = 0;
  private readonly hands: Record<HandId, HandMesh> = { left: new HandMesh(), right: new HandMesh() };
  private readonly ghost = new HandMesh();
  private readonly glyphs: Record<HandId, CanvasPlane> = { left: new CanvasPlane(0.055, 0.055, 2000), right: new CanvasPlane(0.055, 0.055, 2000) };
  private readonly labels: Record<HandId, CanvasPlane> = { left: new CanvasPlane(0.07, 0.022, 2000), right: new CanvasPlane(0.07, 0.022, 2000) };
  private readonly labelUntil: Record<HandId, number> = { left: 0, right: 0 };
  private readonly aimDots: Record<HandId, InstancedMesh>;
  private readonly aimMarks: Record<HandId, Mesh>;
  private readonly painting: Mesh;
  private readonly carried: Mesh;
  private readonly prize: Mesh;
  private readonly scanBar: Mesh;
  private stand!: Mesh;
  /** The crew's coffee and radio: set dressing that stays in the van. */
  private decor: Mesh[] = [];
  /** Mixed reality: the player's own room shows instead of the van. */
  mixed = false;
  private readonly flash: Mesh;
  private readonly title = new CanvasPlane(0.6, 0.2, 2000);
  private readonly eye = new Group();
  private readonly eyeLed: Mesh;
  private flashT = 0;
  private endT = -1;
  /** Key art: no name tags at the wrists. */
  clean = false;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();
  private readonly tmp3 = new Vector3();
  private readonly one = new Vector3(1, 1, 1);
  private readonly tmpQ = new Quaternion();
  private readonly billboard = new Quaternion();
  private readonly m4 = new Matrix4();
  private readonly ghostJoints = new Float32Array(75);

  constructor() {
    this.root.add(this.van.group, this.anchor, this.worldLayer);
    this.anchor.add(this.holo);
    this.root.add(new HemisphereLight('#ffe2c4', '#1a1a26', 1.6));
    this.buildTable();

    // The crew.
    this.figures = {
      lark: new Figure({ color: COLOR.lark, badge: 'circle', hat: 'ponytail' }),
      rook: new Figure({ color: COLOR.rook, badge: 'triangle', hat: 'beanie', scale: 1.06 }),
    };
    for (const f of Object.values(this.figures)) this.holo.add(f.group);
    this.holo.add(this.beam.mesh);

    this.meters = { lark: ringMesh(COLOR.bert, 0.026), rook: ringMesh(COLOR.bert, 0.026) };
    this.progressRings = { lark: ringMesh(COLOR.lark, 0.03), rook: ringMesh(COLOR.rook, 0.03) };
    this.checks = { lark: this.icon(), rook: this.icon() };
    for (const t of THIEVES) this.holo.add(this.meters[t], this.progressRings[t], this.checks[t].plane.mesh);

    const routeGeo = new BufferGeometry();
    routeGeo.setAttribute('position', new BufferAttribute(new Float32Array(10 * 3), 3));
    this.route = new Line(routeGeo, new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, toneMapped: false }));
    this.route.frustumCulled = false;
    this.holo.add(this.route);

    // Prompt and caption hover over the far edge of the model.
    this.prompt.mesh.position.set(0, 0.2, -0.27);
    this.caption.mesh.position.set(0, 0.145, -0.27);
    this.debug.mesh.position.set(-0.52, 0.15, -0.05);
    this.debug.mesh.rotation.y = 0.7;
    this.debug.mesh.visible = false;
    this.anchor.add(this.prompt.mesh, this.caption.mesh, this.debug.mesh);

    // The title card rises out of the table while the drone draws the room.
    this.title.mesh.position.set(0, 0.13, -0.06);
    this.title.mesh.rotation.x = -0.2;
    this.title.mesh.visible = false;
    this.anchor.add(this.title.mesh);

    // The prize, on the table at the end.
    const kite = new CanvasPlane(0.16, 0.12, 1600);
    kite.draw('kite', drawKite);
    this.prize = kite.mesh;
    this.prize.position.set(0, 0.07, -0.05);
    this.prize.rotation.x = -0.35;
    this.prize.visible = false;
    this.anchor.add(this.prize);

    // Painting on the east wall, turned toward the player so it reads.
    const painting = new CanvasPlane(0.08, 0.06, 2000);
    painting.draw('kite', drawKite);
    this.painting = painting.mesh;
    toModel(11.9, 3.6, this.painting.position, 0.045);
    this.painting.rotation.y = -1.1;
    this.holo.add(this.painting);
    // The same painting, between the two of them on the way out.
    const carried = new CanvasPlane(0.045, 0.034, 2000);
    carried.draw('kite', drawKite);
    carried.material.side = DoubleSide;
    carried.material.forceSinglePass = true;
    this.carried = carried.mesh;
    this.carried.visible = false;
    this.holo.add(this.carried);

    // Scan bar sweeps across while the drone draws the room.
    this.scanBar = new Mesh(new PlaneGeometry(0.004, 0.06), this.holoMat(COLOR.holo, 0.9));
    this.scanBar.position.y = 0.03;
    this.holo.add(this.scanBar);

    // A red flash around a spotted thief.
    this.flash = ringMesh(COLOR.warn, 0.08);
    this.flash.rotation.x = -Math.PI / 2;
    this.flash.visible = false;
    this.holo.add(this.flash);

    // The Eye turns with its sweep; its light goes out when the fuse is cut.
    const eyeRed = '#ff5a68';
    this.eye.add(eyeProps().build(S, 0, 0, this.holoMat(eyeRed, 0.5), this.lineMat(eyeRed, 0.95)));
    this.eyeLed = new Mesh(new SphereGeometry(0.0016, 8, 6), new MeshBasicMaterial({ color: COLOR.eye, toneMapped: false }));
    this.eyeLed.position.set(0.0045, 0.0045, 0);
    this.eye.add(this.eyeLed);
    this.holo.add(this.eye);
    this.job2 = new Job2Look();
    this.setJob(this.level);

    // Hands, glyphs and aim live in world space.
    this.aimDots = { left: this.dots(), right: this.dots() };
    this.aimMarks = { left: ringMesh('#ffffff', 0.016), right: ringMesh('#ffffff', 0.016) };
    for (const h of HANDS) {
      this.aimMarks[h].rotation.x = -Math.PI / 2;
      (this.aimMarks[h].material as any).uniforms.progress.value = 1;
      this.holo.add(this.aimMarks[h]);
      this.worldLayer.add(this.hands[h].group, this.glyphs[h].mesh, this.labels[h].mesh, this.aimDots[h]);
      this.glyphs[h].mesh.renderOrder = 20;
      this.labels[h].mesh.renderOrder = 20;
    }
    this.ghost.material.color.set('#ffffff');
    this.ghost.material.opacity = 0.35;
    this.worldLayer.add(this.ghost.group);
  }

  private holoMat(color: string, opacity: number) {
    const m = holoize(new MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: DoubleSide, forceSinglePass: true, toneMapped: false }));
    this.mats.push([m, opacity]);
    return m;
  }

  private lineMat(color: string, opacity: number) {
    const m = holoize(new LineBasicMaterial({ color, transparent: true, opacity, toneMapped: false }));
    this.mats.push([m, opacity]);
    return m;
  }

  private icon(): Icon {
    const plane = new CanvasPlane(0.025, 0.025, 2000);
    plane.draw('check', (ctx, w, h) => checkMark(ctx, w / 2, h / 2, w * 0.8, '#ffffff'));
    plane.mesh.visible = false;
    return { plane, until: 0 };
  }

  private dots() {
    const m = new InstancedMesh(new SphereGeometry(0.0022, 6, 4), new MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, toneMapped: false, depthWrite: false }), 12);
    m.frustumCulled = false;
    m.visible = false;
    return m;
  }

  /**
   * The projector table: graphite top with a warm lip, a glass bed under the
   * model with its labels, four emitters casting the hologram, and the crew's
   * coffee and radio on the far corners.
   */
  private buildTable() {
    const a = this.anchor;
    const top = new Mesh(new BoxGeometry(T.tableW, 0.025, T.tableD), new MeshStandardMaterial({ color: '#171a1f', roughness: 0.35, metalness: 0.55 }));
    top.position.y = -0.0165;
    const lip = new Mesh(new BoxGeometry(T.tableW * 0.96, 0.004, 0.004), new MeshBasicMaterial({ color: '#ffb36b', toneMapped: false }));
    lip.position.set(0, -0.027, T.tableD / 2 - 0.003);
    this.stand = new Mesh(new CylinderGeometry(0.025, 0.04, 1, 12), new MeshStandardMaterial({ color: '#202226', roughness: 0.5, metalness: 0.6 }));
    const bed = this.bed;
    bed.mesh.rotation.x = -Math.PI / 2;
    bed.mesh.position.y = -0.0035;
    // Emitters at the bed's corners, with faint rays up to the model.
    const ex = 0.335;
    const ez = 0.235;
    const pods = [];
    const rays: number[] = [];
    for (const [x, z] of [[-ex, -ez], [ex, -ez], [-ex, ez], [ex, ez]]) {
      const pod = new CylinderGeometry(0.007, 0.009, 0.006, 14);
      pod.translate(x, -0.001, z);
      pods.push(pod);
      rays.push(x, 0.002, z, x * 0.35, 0.085, z * 0.35);
    }
    const podMesh = new Mesh(mergeGeometries(pods), new MeshBasicMaterial({ color: '#9fe8ff', toneMapped: false }));
    const rayGeo = new BufferGeometry();
    rayGeo.setAttribute('position', new BufferAttribute(new Float32Array(rays), 3));
    const rayMat = new LineBasicMaterial({ color: COLOR.holo, transparent: true, opacity: 0.22, depthWrite: false, blending: AdditiveBlending, toneMapped: false });
    this.holoMats.push([rayMat, 0.22]);
    const rayLines = new LineSegments(rayGeo, rayMat);
    // Coffee, gone cold.
    const cupMat = new MeshStandardMaterial({ color: '#e4ded2', roughness: 0.45 });
    const cup = new Mesh(new CylinderGeometry(0.036, 0.031, 0.092, 20), cupMat);
    cup.position.set(0.345, 0.042, -0.245);
    const coffee = new Mesh(new CircleGeometry(0.033, 20), new MeshStandardMaterial({ color: '#2b170c', roughness: 0.2 }));
    coffee.rotation.x = -Math.PI / 2;
    coffee.position.set(0.345, 0.0885, -0.245);
    const handle = new Mesh(new TorusGeometry(0.02, 0.0055, 8, 16, Math.PI), cupMat);
    handle.position.set(0.379, 0.045, -0.245);
    handle.rotation.z = -Math.PI / 2;
    // The radio, face down: no talking on a job.
    const radio = new Mesh(new BoxGeometry(0.058, 0.03, 0.14), new MeshStandardMaterial({ color: '#202428', roughness: 0.55 }));
    radio.position.set(-0.335, 0.011, -0.215);
    radio.rotation.y = 0.35;
    const aerial = new Mesh(new CylinderGeometry(0.004, 0.004, 0.07, 6), radio.material);
    aerial.rotation.x = Math.PI / 2;
    aerial.position.set(-0.36, 0.015, -0.3);
    aerial.rotation.z = 0.35;
    a.add(top, lip, this.stand, bed.mesh, podMesh, rayLines, cup, coffee, handle, radio, aerial);
    this.decor = [cup, coffee, handle, radio, aerial];
  }

  /**
   * Shows a job's plan: drops the last job's model and builds this one, scaled
   * to fit the table. Guards get a figure and a light each.
   */
  setJob(L: Level) {
    this.level = L;
    const { w, d } = L.job;
    OX = (-w / 2) * S;
    OZ = (-d / 2) * S;
    this.holo.scale.setScalar(L.fit);
    this.holo.remove(this.model);
    this.model.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of ([] as Material[]).concat(m.material ?? [])) {
        (mat as MeshBasicMaterial).map?.dispose();
        mat.dispose();
      }
    });
    this.model = new Group();
    this.holo.add(this.model);
    this.modelMats = [];
    this.mats = this.modelMats;
    this.rings.clear();
    this.buildModel(L);
    const g1 = L.id === 'gallery';
    if (!g1) this.model.add(this.job2.build(L, (c, o) => this.holoMat(c, o), (c, o) => this.lineMat(c, o)));
    this.mats = this.holoMats;
    for (let i = 0; i < Math.max(this.guards.length, L.job.guards.length); i++) this.guard(i).fig.group.visible = i < L.job.guards.length;
    this.bed.draw(`bed|${L.id}`, (ctx, cw, ch) => drawBed(ctx, cw, ch, L));
    this.title.draw(`title|${L.id}`, (ctx, cw, ch) => drawTitle(ctx, cw, ch, L));
    this.eye.visible = g1;
    this.painting.visible = g1;
    if (L.job.eye) toModel(L.job.eye.x, L.job.eye.z, this.eye.position, 0.048);
    this.routesFor = '';
  }

  /** A guard's figure, light and question mark, made on first use. */
  private guard(i: number): GuardLook {
    while (this.guards.length <= i) {
      const color = GUARD_COLORS[this.guards.length % GUARD_COLORS.length];
      const fig = new Figure({ color, badge: null, hat: 'cap', scale: 1.14, torch: true });
      const fan = new Fan(color, false);
      const mark = new CanvasPlane(0.03, 0.03, 2000);
      mark.draw('?', (ctx, w, h) => {
        ctx.fillStyle = color;
        ctx.font = `700 ${h * 0.9}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('?', w / 2, h / 2);
      });
      const route = new LineSegments(new BufferGeometry(), holoize(new LineBasicMaterial({ color, transparent: true, opacity: 0, toneMapped: false, depthWrite: false })));
      route.frustumCulled = false;
      this.holo.add(fig.group, fan.mesh, mark.mesh, route);
      this.guards.push({ fig, fan, mark, route });
    }
    return this.guards[i];
  }

  /** The plan as a hologram: floor grid, walls, spots, then the job's own furniture. */
  private buildModel(L: Level) {
    const h = this.model;
    const { w: RW, d: RD } = L.job;
    const W = RW * S;
    const D = RD * S;
    // Floor with a 1 m grid.
    const grid = new CanvasPlane(W, D, 1000);
    grid.draw(`grid|${L.id}`, (ctx, w, hgt) => {
      ctx.fillStyle = 'rgba(8, 40, 60, 0.85)';
      ctx.fillRect(0, 0, w, hgt);
      ctx.strokeStyle = 'rgba(127, 220, 255, 0.16)';
      ctx.lineWidth = 2;
      for (let i = 1; i < RW; i++) {
        ctx.beginPath();
        ctx.moveTo((i / RW) * w, 0);
        ctx.lineTo((i / RW) * w, hgt);
        ctx.stroke();
      }
      for (let i = 1; i < RD; i++) {
        ctx.beginPath();
        ctx.moveTo(0, (i / RD) * hgt);
        ctx.lineTo(w, (i / RD) * hgt);
        ctx.stroke();
      }
    });
    grid.material.depthWrite = false;
    holoize(grid.material);
    this.mats.push([grid.material, 0.9]);
    grid.mesh.rotation.x = -Math.PI / 2;
    grid.mesh.position.y = 0.0005;
    h.add(grid.mesh);

    // Walls: low translucent strips, outlined top, bottom and at every end.
    const wallH = 0.05;
    const wallMat = this.holoMat(COLOR.holo, 0.13);
    const edges: number[] = [];
    const wall = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0) * S;
      const m = new Mesh(new PlaneGeometry(len, wallH), wallMat);
      toModel((x0 + x1) / 2, (z0 + z1) / 2, m.position, wallH / 2);
      m.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      h.add(m);
      for (const y of [wallH, 0.0008]) {
        const a = toModel(x0, z0, new Vector3(), y);
        const b = toModel(x1, z1, new Vector3(), y);
        edges.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
      for (const [x, z] of [[x0, z0], [x1, z1]]) {
        const a = toModel(x, z, new Vector3(), 0);
        edges.push(a.x, 0, a.z, a.x, wallH, a.z);
      }
    };
    for (const [x0, z0, x1, z1] of L.job.walls) wall(x0, z0, x1, z1);
    const edgeGeo = new BufferGeometry();
    edgeGeo.setAttribute('position', new BufferAttribute(new Float32Array(edges), 3));
    h.add(new LineSegments(edgeGeo, this.lineMat(COLOR.holo, 0.85)));

    if (L.id === 'gallery') this.buildGallery(wallH);
    else this.buildHalloran(wallH);

    // Spot rings: solid for cover, dashed for open ground. Doorways get none.
    for (const s of L.spots) {
      if (s.door) continue;
      const ringMat = holoize(new MeshBasicMaterial({ color: COLOR.holo, transparent: true, opacity: 0.6, depthWrite: false, side: DoubleSide, forceSinglePass: true, toneMapped: false }));
      const ring = new Mesh(s.cover ? new RingGeometry(0.034, 0.04, 40) : this.dashedRing(0.034, 0.04, 8), ringMat);
      ring.rotation.x = -Math.PI / 2;
      toModel(s.x, s.z, ring.position, 0.0012);
      h.add(ring);
      let fill: Mesh | null = null;
      if (s.cover) {
        fill = new Mesh(new CircleGeometry(0.034, 32), holoize(new MeshBasicMaterial({ color: COLOR.holo, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false })));
        fill.rotation.x = -Math.PI / 2;
        toModel(s.x, s.z, fill.position, 0.001);
        h.add(fill);
      }
      this.rings.set(s.id, { ring, fill });
    }
  }

  /** Job 1's window, door, furniture and paintings. */
  private buildGallery(wallH: number) {
    const h = this.model;
    // Window: rain-blue glow in the west wall gap.
    const [wz0, wz1] = [3.4, 4.6];
    const [dx0, dx1] = [5.4, 6.6];
    const win = new Mesh(new PlaneGeometry((wz1 - wz0) * S, wallH * 0.8), this.holoMat('#4aa8ff', 0.35));
    toModel(0, (wz0 + wz1) / 2, win.position, wallH * 0.45);
    win.rotation.y = Math.PI / 2;
    h.add(win);

    // Furniture, outlined like a blueprint: two draw calls for all of it.
    h.add(galleryProps().build(S, OX, OZ, this.holoMat(COLOR.holo, 0.17), this.lineMat(COLOR.holo, 0.8)));
    h.add(fuseProps().build(S, OX, OZ, this.holoMat('#bdefff', 0.45), this.lineMat('#e6fbff', 1)));
    const door = new Mesh(new PlaneGeometry((dx1 - dx0) * S, wallH * 0.9), this.holoMat('#ffcf8a', 0.2));
    toModel((dx0 + dx1) / 2, 8, door.position, wallH * 0.45);
    h.add(door);
    h.add(this.sign('EXIT', (dx0 + dx1) / 2, 7.98, Math.PI));

    // Paintings on the walls: Vance himself, and two from the collection.
    const art = (draw: (ctx: CanvasRenderingContext2D, w: number, hh: number) => void, key: string, x: number, z: number, ry: number, w = 0.035, hh = 0.042) => {
      const p = new CanvasPlane(w, hh, 2000);
      p.draw(key, draw);
      holoize(p.material);
      toModel(x, z, p.mesh.position, 0.055);
      p.mesh.rotation.y = ry;
      h.add(p.mesh);
    };
    art(drawVance, 'vance', 8.4, 0.05, 0);
    art(drawAbstract(0), 'a0', 2.2, 0.05, 0, 0.05, 0.034);
    art(drawAbstract(1), 'a1', 9.8, 7.95, Math.PI, 0.05, 0.034);
  }

  /** Job 2's furniture, the dock's roller door and a lot or two on the walls. */
  private buildHalloran(wallH: number) {
    const h = this.model;
    h.add(halloranProps().build(S, OX, OZ, this.holoMat(COLOR.holo, 0.17), this.lineMat(COLOR.holo, 0.8)));
    // Panel and breaker: the two boxes Rook has to work on stand out.
    const tech = new PropBatch().box(0.7, 0.9, 0.16, 4.9, 1.05, 0.1).cyl(0.035, 0.6, 4.7, 1.8, 0.08, 6).box(0.55, 0.7, 0.16, 11.2, 1.0, 0.1).box(0.12, 0.2, 0.08, 11.32, 1.0, 0.2);
    h.add(tech.build(S, OX, OZ, this.holoMat('#bdefff', 0.45), this.lineMat('#e6fbff', 1)));
    // The dock's roller door, with the night outside.
    const dock = new Mesh(new PlaneGeometry(1.2 * S, wallH * 0.85), this.holoMat('#4aa8ff', 0.3));
    toModel(0, 9.6, dock.position, wallH * 0.43);
    dock.rotation.y = Math.PI / 2;
    h.add(dock);
    h.add(this.sign('DOCK', 0.03, 9.6, Math.PI / 2));
    const art = (draw: (ctx: CanvasRenderingContext2D, w: number, hh: number) => void, key: string, x: number, z: number, ry: number) => {
      const p = new CanvasPlane(0.05, 0.034, 2000);
      p.draw(key, draw);
      holoize(p.material);
      toModel(x, z, p.mesh.position, 0.055);
      p.mesh.rotation.y = ry;
      h.add(p.mesh);
    };
    art(drawAbstract(0), 'lot12', 8.0, 11.95, Math.PI);
    art(drawAbstract(1), 'lot14', 13.2, 11.95, Math.PI);
  }

  /** A small lit sign on a wall. */
  private sign(text: string, x: number, z: number, ry: number) {
    const p = new CanvasPlane(0.03, 0.011, 3000);
    p.draw(`sign|${text}`, (ctx, w, hh) => {
      ctx.fillStyle = '#0e6b3a';
      ctx.fillRect(0, 0, w, hh);
      ctx.fillStyle = '#d8ffe6';
      ctx.font = `700 ${hh * 0.72}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, w / 2, hh * 0.55);
    });
    holoize(p.material);
    toModel(x, z, p.mesh.position, 0.058);
    p.mesh.rotation.y = ry;
    return p.mesh;
  }

  private dashedRing(inner: number, outer: number, dashes: number) {
    const geo = new BufferGeometry();
    const pos: number[] = [];
    const seg = 4;
    for (let d = 0; d < dashes; d++) {
      const a0 = (d / dashes) * Math.PI * 2;
      const a1 = a0 + (Math.PI * 2) / dashes / 1.8;
      for (let i = 0; i < seg; i++) {
        const t0 = a0 + ((a1 - a0) * i) / seg;
        const t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
        const p = (r: number, t: number) => [Math.cos(t) * r, Math.sin(t) * r, 0];
        pos.push(...p(inner, t0), ...p(outer, t0), ...p(outer, t1), ...p(inner, t0), ...p(outer, t1), ...p(inner, t1));
      }
    }
    geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    return geo;
  }

  /**
   * Mixed reality: no van and no stand to the floor; the projector sits lower,
   * nearer a real desk (Table up and down fine-tune it).
   */
  setMixed(on: boolean) {
    this.mixed = on;
    this.van.group.visible = !on;
    this.stand.visible = !on;
    for (const m of this.decor) m.visible = !on;
  }

  /** Place the table in front of the head and the van around the player. */
  place(head: Vector3, headQ: Quaternion, tableY: number, tableZ: number) {
    const fwd = this.tmp.set(0, 0, -1).applyQuaternion(headQ);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    const dist = T.tableDistance + tableZ;
    const below = T.tableBelowEyes + (this.mixed ? T.mixedExtraDrop : 0);
    this.anchor.position.set(head.x + fwd.x * dist, head.y - below + tableY, head.z + fwd.z * dist);
    this.anchor.rotation.set(0, yaw, 0);
    // The van is built for a seated player; standing, it rises with the eyes.
    this.van.group.position.set(head.x, Math.min(0.5, Math.max(0, head.y - 1.2)), head.z);
    this.van.group.rotation.set(0, yaw, 0);
    const h = Math.max(0.2, this.anchor.position.y - 0.03);
    this.stand.scale.set(1, h, 1);
    this.stand.position.y = -0.03 - h / 2;
    this.anchor.updateMatrixWorld(true);
  }

  /** Points in the anchor's frame, for zone and aim maths. */
  toAnchor(world: Vector3, out: Vector3) {
    return this.anchor.worldToLocal(out.copy(world));
  }

  routePreview(points: [number, number][]) {
    const a = this.route.geometry.attributes.position as BufferAttribute;
    const n = Math.min(points.length, 10);
    for (let i = 0; i < 10; i++) {
      const [x, z] = points[Math.min(i, n - 1)];
      toModel(x, z, this.tmp, 0.004);
      a.setXYZ(i, this.tmp.x, this.tmp.y, this.tmp.z);
    }
    a.needsUpdate = true;
    this.route.geometry.setDrawRange(0, n);
    this.routeT = 1;
  }

  checkMark(thief: ThiefId, now: number) {
    this.checks[thief].until = now + 1000;
  }

  shake(thief: ThiefId) {
    this.figures[thief].shake = 0.5;
  }

  spotted(thief: Thief) {
    toModel(thief.x, thief.z, this.flash.position, 0.003);
    this.flashT = 0.5;
  }

  label(hand: HandId, now: number) {
    this.labelUntil[hand] = now + 5000;
  }

  startEnd() {
    this.endT = 0;
  }

  resetEnd() {
    this.endT = -1;
    this.prize.visible = false;
    this.flashT = 0;
    this.routeT = 0;
    for (const t of THIEVES) this.checks[t].until = 0;
  }

  /** Model position of a thing in world space (for sounds). */
  worldOf(x: number, z: number, out: Vector3, y = 0.04) {
    return this.holo.localToWorld(toModel(x, z, out, y));
  }

  /** Anchor-frame position of a room point: where it sits on the table, after fitting. */
  anchorPoint(x: number, z: number, out: Vector3, y = 0) {
    return toModel(x, z, out, y).multiplyScalar(this.level.fit).add(this.holo.position);
  }

  /** Each guard's round as a dotted loop: bright during recon, faint during the job. */
  private syncRoutes(g: Game, alpha: number) {
    const show = g.open;
    const key = `${this.level.id}|${g.sim.seed}`;
    if (show && key !== this.routesFor) {
      this.routesFor = key;
      g.sim.loops.forEach((loop, i) => {
        const pts: number[] = [];
        const P = loop.points;
        const a = new Vector3();
        for (let k = 0; k < P.length; k++) {
          const [ax, az] = P[k];
          const [bx, bz] = P[(k + 1) % P.length];
          const len = Math.hypot(bx - ax, bz - az);
          for (let t = 0; t < len; t += 0.5) {
            const u0 = t / len;
            const u1 = Math.min(len, t + 0.26) / len;
            toModel(ax + (bx - ax) * u0, az + (bz - az) * u0, a, 0.0016);
            pts.push(a.x, a.y, a.z);
            toModel(ax + (bx - ax) * u1, az + (bz - az) * u1, a, 0.0016);
            pts.push(a.x, a.y, a.z);
          }
        }
        const route = this.guard(i).route;
        route.geometry.dispose();
        route.geometry = new BufferGeometry();
        route.geometry.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3));
      });
    }
    for (let i = 0; i < this.guards.length; i++) {
      const r = this.guards[i].route;
      const m = r.material as LineBasicMaterial;
      m.opacity = show && i < g.sim.s.guards.length ? alpha * (g.beat === 1 ? 0.75 : g.paused ? 0.5 : 0.18) : 0;
      r.visible = m.opacity > 0.01;
    }
  }

  textPrompt(text: string, caption: string, warn = false) {
    this.prompt.draw(`${text}|${warn}`, (ctx, w, h) => {
      if (!text) return;
      // Largest size whose wrapped lines fit the plate.
      let size = h * 0.5;
      let lines = 1;
      for (let i = 0; i < 6; i++) {
        ctx.font = `700 ${size}px "Atkinson Hyperlegible", sans-serif`;
        lines = wrap(ctx, text, w * 0.9).length;
        if (lines * size * 1.2 <= h * 0.92) break;
        size *= 0.88;
      }
      plate(ctx, w, h, 0.72, 0.3);
      textBlock(ctx, text, w, h / 2 - ((lines - 1) * size * 1.2) / 2, size, 700, warn ? COLOR.warn : COLOR.text);
    });
    this.caption.draw(caption, (ctx, w, h) => {
      if (!caption) return;
      // One line, shrunk to fit: a wrapped second line would fall off the plate.
      const size = fitSize(ctx, caption, w * 0.86, h * 0.5, 400);
      const tw = Math.min(w, (ctx.measureText(caption).width * size) / (h * 0.5) + h * 0.8);
      ctx.fillStyle = 'rgba(10, 14, 22, 0.65)';
      ctx.beginPath();
      ctx.roundRect((w - tw) / 2, 0, tw, h, h * 0.3);
      ctx.fill();
      textBlock(ctx, caption, w, h * 0.52, size, 400, COLOR.dim);
    });
  }

  debugText(lines: string[]) {
    this.debug.mesh.visible = true;
    this.debug.draw(lines.join('\n'), (ctx, w, h) => {
      plate(ctx, w, h, 0.8, 0.04);
      ctx.fillStyle = '#d0f0ff';
      ctx.font = `400 ${h / 15}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, i) => ctx.fillText(l, w * 0.03, h * 0.03 + i * (h / 13.5)));
    });
  }

  /** Per frame: everything on the table and around the hands. */
  sync(g: Game, frames: Record<HandId, HandFrame>, headQ: Quaternion, dt: number, now: number) {
    const s = g.sim.s;
    // Billboards on the model face the viewer.
    this.anchor.getWorldQuaternion(this.tmpQ);
    this.billboard.copy(this.tmpQ).invert().multiply(headQ);

    // Hologram: drawn in by the scan front, dimmed on pause, flickering on
    // rewind, faded at the end. Shared shader uniforms do the rest.
    let alpha = 1;
    const scan = g.beat === 0 ? Math.min(1, g.beatT / T.scanS) : 1;
    if (g.paused) alpha *= 0.35;
    if (g.rewindT > 0) alpha *= 0.6 + 0.4 * Math.abs(Math.sin(now * 0.03));
    if (this.endT >= 0) {
      this.endT += dt;
      alpha *= Math.max(0, 1 - this.endT / 1.5);
      this.prize.visible = this.endT > 1.2;
      const u = Math.min(1, Math.max(0, (this.endT - 1.2) / 0.6));
      this.prize.scale.setScalar(0.2 + 0.8 * u);
      this.prize.position.y = 0.07 + Math.sin(this.endT * 1.6) * 0.006;
      this.prize.rotation.y = Math.sin(this.endT * 0.7) * 0.25;
    }
    for (const [m, base] of this.holoMats) (m as MeshBasicMaterial).opacity = base * alpha;
    for (const [m, base] of this.modelMats) (m as MeshBasicMaterial).opacity = base * alpha;
    const L = this.level;
    const { w: RW, d: RD } = L.job;
    this.holo.visible = alpha > 0.01;
    this.scanBar.visible = scan < 1;
    if (scan < 1) toModel(RW * scan, RD / 2, this.scanBar.position, 0.03);
    this.holo.position.x = g.rewindT > 0 ? Math.sin(now * 0.09) * 0.002 : 0;
    this.holo.updateWorldMatrix(true, false);
    HOLO.uHoloInv.value.copy(this.holo.matrixWorld).invert();
    HOLO.uTime.value = now / 1000;
    HOLO.uReveal.value = scan < 1 ? OX + RW * S * scan : 10;
    HOLO.uAlarm.value = Math.max(this.flashT / 0.5, g.rewindT > 0 ? 0.25 : 0);
    const revealedX = RW * scan;

    // Title card while the room draws in.
    const tt = g.beat === 0 ? g.beatT : 99;
    const ta = Math.min(1, Math.max(0, (tt - 0.3) / 0.7)) * (1 - Math.min(1, Math.max(0, (tt - 3.3) / 0.7)));
    this.title.mesh.visible = ta > 0.01;
    this.title.material.opacity = ta;
    this.title.mesh.position.y = 0.12 + ta * 0.012;

    // Spot rings: prompted spots pulse, the aimed spot lights up, unavailable ones dim.
    const pulse = 0.55 + 0.45 * Math.sin(now * 0.008);
    const prompt = g.shownPrompt;
    for (const [id, { ring, fill }] of this.rings) {
      const mat = ring.material as MeshBasicMaterial;
      const aimed = frames.left.aimSpot === id || frames.right.aimSpot === id;
      const asked = prompt.spots.includes(id);
      const usable = g.beat < 2 || g.targetable(id);
      mat.color.set(aimed ? '#ffffff' : COLOR.holo);
      mat.opacity = alpha * (aimed ? 1 : asked ? 0.4 + 0.6 * pulse : usable ? 0.55 : 0.18);
      ring.scale.setScalar(aimed ? 1.15 : asked ? 1 + 0.12 * pulse : 1);
      if (fill) (fill.material as MeshBasicMaterial).opacity = alpha * (aimed ? 0.3 : 0.1);
    }

    // Figures. On a rewind they slide back to where the beat began, like tape.
    const snap = g.rewindT > 0 ? g.snapshotState : null;
    const ru = snap ? 1 - g.rewindT / T.rewindS : 0;
    const re = ru * ru * (3 - 2 * ru);
    const at = (x: number, z: number, sx: number, sz: number, out: Vector3) => toModel(snap ? x + (sx - x) * re : x, snap ? z + (sz - z) * re : z, out);
    for (const id of THIEVES) {
      const th = s[id];
      const f = this.figures[id];
      f.group.visible = th.state !== 'outside' && alpha > 0.3 && th.x <= revealedX;
      at(th.x, th.z, snap ? snap[id].x : 0, snap ? snap[id].z : 0, f.group.position);
      f.group.rotation.y = -th.face;
      const pose: FigurePose =
        th.state === 'climbing' ? 'climb'
        : th.state === 'frozen' ? 'crouch'
        : th.state === 'working' ? 'work'
        : s.carrying || (s.loot && id === 'lark') ? 'carry'
        : th.state === 'moving' ? 'walk'
        : 'stand';
      f.update(snap ? 'walk' : pose, dt, snap ? -1.4 : th.state === 'moving' || th.state === 'climbing' ? (th.creep ? 0.5 : 1) : 0);
      const active = g.settings.oneHand && g.activeThief === id && g.lit[id];
      f.ring.scale.setScalar(active ? 1.2 + 0.15 * pulse : 1);

      // Detection meter above the head; colour says which threat.
      const meter = this.meters[id];
      const level = Math.max(th.eye, th.guard);
      meter.visible = f.group.visible && level > 0.02 && !(s.carrying && id === 'rook');
      if (meter.visible) {
        meter.position.copy(f.group.position).setY(0.105);
        meter.quaternion.copy(this.billboard);
        const u = (meter.material as any).uniforms;
        u.progress.value = level;
        u.color.value.set(th.eye > th.guard ? COLOR.eye : COLOR.bert);
      }
      // Work progress.
      const pr = this.progressRings[id];
      const act = th.action;
      pr.visible = f.group.visible && th.state === 'working' && !!act;
      if (pr.visible && act) {
        pr.position.copy(f.group.position).setY(0.135);
        pr.quaternion.copy(this.billboard);
        (pr.material as any).uniforms.progress.value = Math.min(1, s.progress[act] / ACTION_TIME[act]);
      }
      const chk = this.checks[id];
      chk.plane.mesh.visible = f.group.visible && now < chk.until;
      if (chk.plane.mesh.visible) {
        chk.plane.mesh.position.copy(f.group.position).setY(0.12);
        chk.plane.mesh.quaternion.copy(this.billboard);
      }
    }
    // The Blue Kite leaves the wall when the lift completes and travels between them.
    this.painting.visible = L.id === 'gallery' && !s.carrying && !s.escaped;
    this.carried.visible = s.carrying && this.figures.lark.group.visible;
    if (this.carried.visible) {
      const lp = this.figures.lark.group.position;
      const rp = this.figures.rook.group.position;
      this.carried.position.addVectors(lp, rp).multiplyScalar(0.5).setY(0.05);
      this.carried.rotation.set(0, -Math.atan2(rp.z - lp.z, rp.x - lp.x), 0);
    }
    // Guards: figure, light (flickering before each turn), and a question mark while they wonder.
    const clip = (x: number, z: number, dx: number, dz: number, t: number) => L.ray(x, z, dx, dz, t, s.vaultOpen);
    for (let i = 0; i < this.guards.length; i++) {
      const look = this.guards[i];
      const b = s.guards[i];
      look.fan.mesh.visible = !!b;
      look.mark.mesh.visible = false;
      if (!b) {
        look.fig.group.visible = false;
        continue;
      }
      const sb = snap ? snap.guards[i] : null;
      look.fig.group.visible = alpha > 0.3 && b.x <= revealedX;
      at(b.x, b.z, sb ? sb.x : 0, sb ? sb.z : 0, look.fig.group.position);
      look.fig.group.rotation.y = -b.heading;
      look.fig.update(b.walking || snap ? 'walk' : 'stand', dt, snap ? -1.4 : 1);
      look.mark.mesh.visible = look.fig.group.visible && (!!b.suspect || b.listen > 0 || b.inv === 1 || b.inv === 2);
      if (look.mark.mesh.visible) {
        look.mark.mesh.position.copy(look.fig.group.position).setY(0.12);
        look.mark.mesh.quaternion.copy(this.billboard);
      }
      const flicker = b.flicker ? (Math.sin(now * 0.06) > 0 ? 1 : 0.35) : 1;
      const cone = g.sim.cone(i);
      look.fan.update(b.x, b.z, b.heading, cone.half, cone.range, S, OX, OZ, 0.0025, RW, RD, clip);
      look.fan.material.uniforms.opacity.value = 0.55 * alpha * flicker;
    }
    this.syncRoutes(g, alpha);

    // The Eye follows its sweep, sleeps until woken, and droops when cut.
    const eye = L.job.eye;
    const eyeOn = !!eye && s.eyeAwake && s.cameraOn;
    if (eye) {
      this.eye.rotation.set(0, -(s.eyeAwake ? g.sim.eyeAngle() : Math.atan2(eye.aimZ - eye.z, eye.aimX - eye.x)), s.cameraOn ? -0.25 : -0.7);
      (this.eyeLed.material as MeshBasicMaterial).color.set(eyeOn ? (Math.floor(now / 500) % 2 ? COLOR.eye : '#5a0a12') : '#1a0306');
      this.eyeLed.visible = alpha > 0.3;
    }
    this.beam.mesh.visible = eyeOn && alpha > 0.05;
    if (eye && eyeOn) {
      this.beam.update(eye.x, eye.z, g.sim.eyeAngle(), T.eyeHalfDeg * DEG, T.eyeRange, S, OX, OZ, 0.002);
      this.beam.material.uniforms.opacity.value = 0.5 * alpha;
    }

    // The van's screens follow the job: the Eye in Job 1, the laser hall in Job 2.
    const g1 = L.id === 'gallery';
    this.van.update({ clock: g.stats.time, eyeLive: g1 ? s.cameraOn : s.lasersOn, eyeLabel: g1 ? 'THE EYE  EAST HALL' : 'LASERS  VAULT HALL', alarm: g.rewindT > 0 }, now);
    if (!g1) this.job2.sync(g, alpha, now, dt, this.billboard, this.figures.lark);

    // Route preview fades out over a second.
    this.routeT = Math.max(0, this.routeT - dt);
    (this.route.material as LineBasicMaterial).opacity = this.routeT * 0.8 * alpha;

    // Red flash where a thief was spotted.
    this.flashT = Math.max(0, this.flashT - dt);
    this.flash.visible = this.flashT > 0;
    if (this.flash.visible) {
      const u = 1 - this.flashT / 0.5;
      this.flash.scale.setScalar(0.6 + u * 1.6);
      const fu = (this.flash.material as any).uniforms;
      fu.progress.value = 1;
      fu.opacity.value = 1 - u;
    }

    // Hands.
    for (const hand of HANDS) this.syncHand(g, hand, frames[hand], headQ, now);
    this.syncGhost(g, frames, now);
  }

  private syncHand(g: Game, hand: HandId, fr: HandFrame, headQ: Quaternion, now: number) {
    const mesh = this.hands[hand];
    const glyphPlane = this.glyphs[hand];
    const label = this.labels[hand];
    const dots = this.aimDots[hand];
    const mark = this.aimMarks[hand];
    mesh.group.visible = fr.tracked;
    glyphPlane.mesh.visible = false;
    label.mesh.visible = false;
    dots.visible = false;
    mark.visible = false;
    if (!fr.tracked) return;
    mesh.update(fr.joints);

    const thief = g.thiefFor(hand);
    const color = thief ? COLOR[thief] : '#dfe8f0';
    mesh.material.color.set(fr.nearEdge ? COLOR.warn : color);
    mesh.material.opacity = fr.inZone ? 0.95 : 0.4;

    // The glyph: the pose being held with its confirm ring, or the prompt's glyph pulsing.
    const f = g.filters[hand];
    const prompt = g.shownPrompt;
    const held = f.held === 'fist' || f.held === 'point' || f.held === 'thumb' ? f.held : null;
    const asked = prompt.glyph && prompt.hands.includes(hand) ? prompt.glyph : null;
    const show: Cmd | null = held && fr.inZone ? held : asked;
    if (show && thief) {
      const progress = held ? Math.round(f.progress(now) * 16) / 16 : 0;
      const hint = !held && g.hintLevel >= 1;
      const pulse = held ? 1 : 0.45 + 0.35 * (0.5 + 0.5 * Math.sin(now * 0.008)) + (hint ? 0.25 : 0);
      glyphPlane.draw(`${show}|${progress}|${color}|${held ? 1 : 0}|${hint}`, (ctx, w, h) => {
        ctx.fillStyle = 'rgba(10, 14, 22, 0.55)';
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w * 0.48, 0, Math.PI * 2);
        ctx.fill();
        glyph(ctx, show, w / 2, h * 0.56, w * 0.62, held ? '#ffffff' : color);
        ctx.lineWidth = w * 0.06;
        ctx.strokeStyle = color;
        ctx.globalAlpha = held ? 1 : 0.25;
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w * 0.45, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (held ? progress : 1));
        ctx.stroke();
      });
      glyphPlane.material.opacity = Math.min(1, pulse);
      glyphPlane.mesh.visible = true;
      glyphPlane.mesh.position.copy(fr.palm);
      glyphPlane.mesh.quaternion.copy(headQ);
      glyphPlane.mesh.scale.setScalar(hint ? 1.3 : 1);
    }

    // A name tag at the wrist when a thief comes online.
    if (thief && now < this.labelUntil[hand] && !this.clean) {
      label.draw(thief, (ctx, w, h) => {
        plate(ctx, w, h, 0.7, 0.4);
        ctx.fillStyle = COLOR[thief];
        ctx.font = `700 ${h * 0.62}px "Atkinson Hyperlegible", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(thief.toUpperCase(), w / 2, h * 0.54);
      });
      label.mesh.visible = true;
      label.mesh.position.set(fr.joints[0], fr.joints[1] - 0.035, fr.joints[2]);
      label.mesh.quaternion.copy(headQ);
    }

    // Aim: dotted line from the fingertip to the floor, and a marker where it lands.
    if (f.held === 'point' && fr.aimHit && thief) {
      const tip = this.tmp.set(fr.joints[27], fr.joints[28], fr.joints[29]);
      const hit = this.holo.localToWorld(this.tmp2.copy(fr.aimHit));
      const dm = dots.material as MeshBasicMaterial;
      dm.color.set(fr.aimSpot ? color : '#8a949e');
      const q = this.tmpQ.identity();
      for (let i = 0; i < 12; i++) {
        this.m4.compose(this.tmp3.lerpVectors(tip, hit, (i + 1) / 13), q, this.one);
        dots.setMatrixAt(i, this.m4);
      }
      dots.instanceMatrix.needsUpdate = true;
      dots.visible = true;
      mark.visible = true;
      mark.position.copy(fr.aimHit).setY(0.0025);
      (mark.material as any).uniforms.color.value.set(fr.aimSpot ? color : '#8a949e');
    }
  }

  /** Hint level 2: a translucent hand beside the player's demonstrates the signal, twice. */
  private syncGhost(g: Game, frames: Record<HandId, HandFrame>, now: number) {
    const prompt = g.shownPrompt;
    const glyphCmd = prompt.glyph;
    const hand = prompt.hands.find((h) => frames[h].tracked) ?? prompt.hands[0];
    this.ghost.group.visible = g.hintLevel >= 2 && !!glyphCmd && !!hand && !g.blocked();
    if (!this.ghost.group.visible || !glyphCmd || !hand) return;
    const cycle = (now % 3000) / 3000;
    const u = cycle < 0.15 ? 0 : cycle < 0.35 ? (cycle - 0.15) / 0.2 : cycle < 0.8 ? 1 : 1 - (cycle - 0.8) / 0.2;
    const shape: HandShape = lerpShape(SHAPES.open, SHAPES[glyphCmd], u);
    const left = hand === 'left';
    handJoints(shape, left, 1, this.ghostJoints);
    // Hand frame: copy the player's hand if tracked, else palm down over the
    // table's near edge. X = Y × Z works for both hands because the
    // generated left hand is already mirrored.
    const fr = frames[hand];
    const m = this.m4;
    const right = new Vector3(1, 0, 0).applyQuaternion(this.anchor.getWorldQuaternion(this.tmpQ));
    if (fr.tracked) {
      const j = fr.joints;
      const y = new Vector3(j[33] - j[0], j[34] - j[1], j[35] - j[2]).normalize();
      const a = new Vector3(j[18] - j[0], j[19] - j[1], j[20] - j[2]);
      const z = a.cross(new Vector3(j[63] - j[0], j[64] - j[1], j[65] - j[2]));
      if (left) z.negate();
      z.addScaledVector(y, -z.dot(y)).normalize();
      const x = new Vector3().crossVectors(y, z);
      const at = new Vector3(j[0], j[1], j[2]).addScaledVector(right, left ? -0.12 : 0.12);
      m.makeBasis(x, y, z).setPosition(at);
    } else {
      const at = this.holo.localToWorld(new Vector3(left ? -0.18 : 0.18, 0.1, 0.25));
      m.makeRotationFromQuaternion(this.tmpQ)
        .multiply(new Matrix4().makeBasis(new Vector3(-1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, -1, 0)))
        .setPosition(at);
    }
    const v = new Vector3();
    for (let i = 0; i < 25; i++) {
      v.set(this.ghostJoints[i * 3], this.ghostJoints[i * 3 + 1], this.ghostJoints[i * 3 + 2]).applyMatrix4(m);
      this.ghostJoints[i * 3] = v.x;
      this.ghostJoints[i * 3 + 1] = v.y;
      this.ghostJoints[i * 3 + 2] = v.z;
    }
    this.ghost.update(this.ghostJoints);
  }
}
