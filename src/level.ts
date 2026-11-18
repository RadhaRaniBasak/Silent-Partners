import { DEG, T } from './tuning';

/**
 * The jobs, as plans. Room coordinates are metres: x runs west to east, z
 * north to south. A Level wraps one plan with the maths the sim, the bot and
 * the view share: routes between spots, aim snapping, cover, walls and the
 * guards' rounds.
 */

export type SpotId = string;
export type JobId = 'gallery' | 'halloran';
export type ActionId = 'cut' | 'unlock' | 'lift' | 'power' | 'lights' | 'keys' | 'crack';
export type Seg = readonly [number, number, number, number];

export interface Spot {
  id: SpotId;
  x: number;
  z: number;
  cover: boolean;
  name: string;
  /** A doorway: routes pass through it, but it can't be pointed at. */
  door?: boolean;
}

/** Heading is an angle in the room's x–z plane: 0 east, 90° south, 180° west, -90° north. */
export const HEADING = { north: -90 * DEG, south: 90 * DEG, east: 0, west: 180 * DEG } as const;

export interface Waypoint {
  x: number;
  z: number;
  pause: number;
  face: number;
}

export interface GuardDef {
  id: string;
  name: string;
  /** Rounds to choose from. A varied job picks one per run and varies its pauses. */
  routes: Waypoint[][];
  /** Phase of the round he starts at. */
  start?: number;
  /** Job 1: he waits here through the intro, then walks to waypoint `join` and starts his round. */
  intro?: { x: number; z: number; join: number };
}

export interface JobDef {
  id: JobId;
  name: string;
  /** Room size in metres. */
  w: number;
  d: number;
  spots: Spot[];
  edges: [SpotId, SpotId][];
  /** Every wall, drawn, and blocking sight and sound: x0, z0, x1, z1. */
  walls: Seg[];
  /** A wall that opens with the vault. */
  vaultDoor?: Seg;
  guards: GuardDef[];
  /** Guards walk to sounds and last-seen places, search, then go back to their rounds. */
  smart?: boolean;
  /** Each run picks rounds and pauses from its seed. */
  varied?: boolean;
  /** Where each task is done. A two-person task names both spots. */
  tasks: Partial<Record<ActionId, SpotId[]>>;
  /** Where the crew climbs in (and in Job 2, out). */
  entry: SpotId;
  outside: { x: number; z: number };
  eye?: { x: number; z: number; aimX: number; aimZ: number };
  lasers?: Seg;
  sensor?: { x: number; z: number; r: number };
  /** Rooms lit until the breaker is cut: x0, z0, x1, z1. */
  lit?: Seg[];
}

const W = HEADING;

/** Job 1: the Vance Gallery, 12 m by 8 m. The tutorial. */
export const GALLERY: JobDef = {
  id: 'gallery',
  name: 'The Vance Gallery',
  w: 12,
  d: 8,
  spots: [
    { id: 'window', x: 0.6, z: 4.0, cover: false, name: 'Window' },
    { id: 'curtains', x: 1.0, z: 1.8, cover: true, name: 'Curtains' },
    { id: 'fusebox', x: 4.0, z: 0.6, cover: false, name: 'Fuse box' },
    { id: 'plinth', x: 3.6, z: 4.4, cover: true, name: 'Plinth' },
    { id: 'pillar', x: 6.0, z: 3.0, cover: true, name: 'Pillar' },
    { id: 'sofa', x: 8.6, z: 5.2, cover: true, name: 'Sofa' },
    { id: 'painting', x: 11.3, z: 3.6, cover: false, name: 'Painting' },
  ],
  edges: [
    ['window', 'curtains'],
    ['window', 'plinth'],
    ['curtains', 'fusebox'],
    ['curtains', 'plinth'],
    ['fusebox', 'pillar'],
    ['plinth', 'pillar'],
    ['pillar', 'sofa'],
    ['pillar', 'painting'],
    ['sofa', 'painting'],
  ],
  // The window (z 3.4–4.6) and the hall door (x 5.4–6.6) are gaps.
  walls: [
    [0, 0, 12, 0],
    [12, 0, 12, 8],
    [12, 8, 6.6, 8],
    [5.4, 8, 0, 8],
    [0, 8, 0, 4.6],
    [0, 3.4, 0, 0],
  ],
  guards: [
    {
      id: 'bert',
      name: 'Bert',
      routes: [
        [
          { x: 6.0, z: 7.6, pause: 2.0, face: W.north }, // hall door
          { x: 6.0, z: 6.0, pause: 0, face: 0 }, // south centre, rounds the corner
          { x: 10.2, z: 6.2, pause: 1.5, face: W.north }, // east corner
          { x: 10.2, z: 2.0, pause: 1.5, face: W.west }, // north-east
          { x: 7.0, z: 1.6, pause: 1.5, face: W.west }, // north centre
          { x: 6.0, z: 6.0, pause: 0, face: 0 }, // south centre
        ],
      ],
      // Beat 1: he checks his phone here with his back to Lark, then joins at north centre.
      intro: { x: 3.4, z: 1.4, join: 4 },
    },
  ],
  tasks: { cut: ['fusebox'], unlock: ['painting'], lift: ['painting', 'painting'] },
  entry: 'window',
  outside: { x: -0.4, z: 4.0 },
  eye: { x: 11.6, z: 0.4, aimX: 4.5, aimZ: 3.0 },
};

/** Beat 1 of Job 1: Lark creeps back and forth inside the curtains' cover. */
export const LARK_CREEP: readonly [number, number][] = [
  [0.95, 2.2],
  [1.05, 1.4],
];

/**
 * Job 2: Halloran's auction house, 18 m by 12 m, the night before a sale.
 * Store room, security office and vault along the north; a corridor; the
 * vault keys behind a laser door; the saleroom and loading bay to the south.
 */
export const HALLORAN: JobDef = {
  id: 'halloran',
  name: 'Halloran’s',
  w: 18,
  d: 12,
  spots: [
    { id: 'dock', x: 0.7, z: 9.6, cover: true, name: 'Dock' },
    { id: 'crates', x: 2.8, z: 7.4, cover: true, name: 'Crates' },
    { id: 'bayDoor', x: 4.5, z: 9.5, cover: false, name: 'Bay door', door: true },
    { id: 'chairs', x: 6.9, z: 8.9, cover: true, name: 'Chairs' },
    { id: 'podium', x: 9.4, z: 11.0, cover: true, name: 'Podium' },
    { id: 'easel', x: 11.4, z: 8.2, cover: true, name: 'Easel' },
    { id: 'saleDoor', x: 10.0, z: 6.5, cover: false, name: 'Saleroom door', door: true },
    { id: 'bench', x: 5.6, z: 5.6, cover: true, name: 'Bench' },
    { id: 'cabinet', x: 1.0, z: 5.5, cover: true, name: 'Cabinet' },
    { id: 'storeDoor', x: 3.0, z: 4.5, cover: false, name: 'Store door', door: true },
    { id: 'shelves', x: 1.3, z: 1.6, cover: true, name: 'Shelves' },
    { id: 'panel', x: 4.9, z: 0.7, cover: false, name: 'Power' },
    { id: 'officeDoor', x: 8.5, z: 4.5, cover: false, name: 'Office door', door: true },
    { id: 'desk', x: 7.4, z: 2.0, cover: true, name: 'Desk' },
    { id: 'breaker', x: 11.2, z: 0.8, cover: false, name: 'Breaker' },
    { id: 'statue', x: 10.4, z: 5.0, cover: true, name: 'Statue' },
    { id: 'laserDoor', x: 12.0, z: 5.5, cover: false, name: 'Laser door', door: true },
    { id: 'keyA', x: 13.6, z: 5.0, cover: false, name: 'West key' },
    { id: 'keyB', x: 17.2, z: 5.0, cover: false, name: 'East key' },
    { id: 'vaultDoor', x: 15.0, z: 4.5, cover: false, name: 'Vault door', door: true },
    { id: 'vitrine', x: 14.0, z: 1.8, cover: false, name: 'Heron' },
    { id: 'boxes', x: 17.0, z: 1.3, cover: true, name: 'Deposit boxes' },
  ],
  edges: [
    ['dock', 'crates'],
    ['dock', 'bayDoor'],
    ['crates', 'bayDoor'],
    ['bayDoor', 'chairs'],
    ['bayDoor', 'podium'],
    ['chairs', 'podium'],
    ['chairs', 'saleDoor'],
    ['chairs', 'easel'],
    ['podium', 'easel'],
    ['easel', 'saleDoor'],
    ['saleDoor', 'statue'],
    ['saleDoor', 'officeDoor'],
    ['saleDoor', 'bench'],
    ['bench', 'cabinet'],
    ['bench', 'storeDoor'],
    ['bench', 'officeDoor'],
    ['cabinet', 'storeDoor'],
    ['storeDoor', 'shelves'],
    ['storeDoor', 'panel'],
    ['shelves', 'panel'],
    ['officeDoor', 'desk'],
    ['officeDoor', 'breaker'],
    ['desk', 'breaker'],
    ['officeDoor', 'statue'],
    ['statue', 'laserDoor'],
    ['laserDoor', 'keyA'],
    ['keyA', 'vaultDoor'],
    ['vaultDoor', 'keyB'],
    ['vaultDoor', 'vitrine'],
    ['vaultDoor', 'boxes'],
    ['vitrine', 'boxes'],
  ],
  walls: [
    // Outside, with the dock's roller door in the west wall (z 9.0–10.2).
    [0, 0, 18, 0],
    [18, 0, 18, 12],
    [18, 12, 0, 12],
    [0, 12, 0, 10.2],
    [0, 9.0, 0, 0],
    // The north rooms' south wall: store door, office door, vault door.
    [0, 4.5, 2.4, 4.5],
    [3.6, 4.5, 7.9, 4.5],
    [9.1, 4.5, 14.4, 4.5],
    [15.6, 4.5, 18, 4.5],
    [6, 0, 6, 4.5],
    [12, 0, 12, 4.5],
    // The laser door between the corridor and the vault hall (z 4.9–6.1).
    [12, 4.5, 12, 4.9],
    [12, 6.1, 12, 6.5],
    // Corridor and bay | saleroom, with the saleroom door (x 9.4–10.6).
    [0, 6.5, 9.4, 6.5],
    [10.6, 6.5, 18, 6.5],
    // Bay | saleroom, with the bay door (z 8.9–10.1).
    [4.5, 6.5, 4.5, 8.9],
    [4.5, 10.1, 4.5, 12],
  ],
  vaultDoor: [14.4, 4.5, 15.6, 4.5],
  guards: [
    {
      id: 'bert',
      name: 'Bert',
      // The corridor, with a look into the store room and the office.
      routes: [
        [
          { x: 1.6, z: 5.5, pause: 1.6, face: W.east },
          { x: 3.0, z: 5.5, pause: 0, face: 0 },
          { x: 3.0, z: 2.8, pause: 2.0, face: -60 * DEG },
          { x: 3.0, z: 5.5, pause: 0, face: 0 },
          { x: 8.5, z: 5.5, pause: 0, face: 0 },
          { x: 8.5, z: 2.8, pause: 2.0, face: -45 * DEG },
          { x: 8.5, z: 5.5, pause: 0, face: 0 },
          { x: 10.6, z: 5.5, pause: 1.6, face: W.south },
        ],
        [
          { x: 1.6, z: 5.5, pause: 1.6, face: W.east },
          { x: 8.5, z: 5.5, pause: 0, face: 0 },
          { x: 8.5, z: 2.8, pause: 2.0, face: -45 * DEG },
          { x: 8.5, z: 5.5, pause: 0, face: 0 },
          { x: 10.6, z: 5.5, pause: 1.6, face: W.south },
          { x: 3.0, z: 5.5, pause: 0, face: 0 },
          { x: 3.0, z: 2.8, pause: 2.0, face: -60 * DEG },
          { x: 3.0, z: 5.5, pause: 0, face: 0 },
        ],
      ],
      start: 0.1,
    },
    {
      id: 'marge',
      name: 'Marge',
      // The saleroom, one way round or the other.
      routes: [
        [
          { x: 5.6, z: 11.2, pause: 1.6, face: W.north },
          { x: 16.6, z: 11.2, pause: 1.6, face: -135 * DEG },
          { x: 16.6, z: 7.5, pause: 1.6, face: W.west },
          { x: 8.0, z: 7.6, pause: 1.6, face: 150 * DEG },
        ],
        [
          { x: 5.6, z: 11.2, pause: 1.6, face: -45 * DEG },
          { x: 8.0, z: 7.6, pause: 1.6, face: W.east },
          { x: 16.6, z: 7.5, pause: 1.6, face: 135 * DEG },
          { x: 16.6, z: 11.2, pause: 1.6, face: W.west },
        ],
      ],
      start: 0.55,
    },
  ],
  smart: true,
  varied: true,
  tasks: { power: ['panel'], lights: ['breaker'], keys: ['keyA', 'keyB'], crack: ['vitrine'] },
  entry: 'dock',
  outside: { x: -0.6, z: 9.6 },
  lasers: [12, 4.9, 12, 6.1],
  sensor: { x: 15.0, z: 2.2, r: 2.8 },
  lit: [
    [4.5, 6.5, 18, 12],
    [0, 4.5, 12, 6.5],
  ],
};

export const JOBS: Record<JobId, JobDef> = { gallery: GALLERY, halloran: HALLORAN };

export const dist = (ax: number, az: number, bx: number, bz: number) => Math.hypot(bx - ax, bz - az);

/** Do segments p0–p1 and q0–q1 cross? (Touching ends count.) */
function crosses(ax: number, az: number, bx: number, bz: number, s: Seg): boolean {
  const [cx, cz, dx, dz] = s;
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

export interface Segment {
  t0: number;
  t1: number;
  kind: 'walk' | 'pause' | 'turn';
  ax: number;
  az: number;
  bx: number;
  bz: number;
  heading: number;
}

export interface Loop {
  segments: Segment[];
  period: number;
  /** Phase at which the guard reaches his join waypoint (Job 1's intro). */
  joinPhase: number;
  /** The round's corners, for drawing it during recon. */
  points: [number, number][];
}

export interface GuardPose {
  x: number;
  z: number;
  heading: number;
  walking: boolean;
  flicker: boolean;
}

/** Seeded randomness (mulberry32): the same seed always gives the same night. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Level {
  readonly spots: readonly Spot[];
  readonly spot: Record<SpotId, Spot>;
  /** Scale on the table, so a bigger plan still fits the glass bed. */
  readonly fit: number;
  /** Model metres per room metre, after fitting. */
  readonly scale: number;
  private readonly index = new Map<SpotId, number>();
  private readonly D: number[][] = [];
  private readonly NEXT: number[][] = [];

  constructor(readonly job: JobDef) {
    this.spots = job.spots;
    this.spot = Object.fromEntries(job.spots.map((s) => [s.id, s]));
    this.fit = Math.min(1, 0.68 / (job.w * T.modelScale), 0.44 / (job.d * T.modelScale));
    this.scale = T.modelScale * this.fit;
    job.spots.forEach((s, i) => this.index.set(s.id, i));
    // All-pairs shortest paths (Floyd–Warshall).
    const n = job.spots.length;
    const { D, NEXT } = this;
    for (let i = 0; i < n; i++) {
      D.push(new Array(n).fill(Infinity));
      NEXT.push(new Array(n).fill(-1));
      D[i][i] = 0;
      NEXT[i][i] = i;
    }
    for (const [a, b] of job.edges) {
      const i = this.i(a);
      const j = this.i(b);
      const d = dist(job.spots[i].x, job.spots[i].z, job.spots[j].x, job.spots[j].z);
      D[i][j] = D[j][i] = d;
      NEXT[i][j] = j;
      NEXT[j][i] = i;
    }
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++)
          if (D[i][k] + D[k][j] < D[i][j]) {
            D[i][j] = D[i][k] + D[k][j];
            NEXT[i][j] = NEXT[i][k];
          }
  }

  get id(): JobId {
    return this.job.id;
  }

  private i(id: SpotId) {
    const i = this.index.get(id);
    if (i === undefined) throw new Error(`No spot ${id} in ${this.job.id}`);
    return i;
  }

  nearCover(x: number, z: number) {
    return this.spots.some((s) => s.cover && dist(x, z, s.x, s.z) <= T.coverRadius);
  }

  pathLen(a: SpotId, b: SpotId) {
    return this.D[this.i(a)][this.i(b)];
  }

  /** Spots visited going from a to b, excluding a, including b. */
  path(a: SpotId, b: SpotId): SpotId[] {
    const out: SpotId[] = [];
    let i = this.i(a);
    const j = this.i(b);
    while (i !== j) {
      i = this.NEXT[i][j];
      out.push(this.spots[i].id);
    }
    return out;
  }

  /**
   * Route from an arbitrary position. At a spot: the shortest path. Mid-route:
   * via whichever end of the current edge is shorter overall. Anywhere else: via
   * the spot that minimises the total.
   */
  planRoute(x: number, z: number, edge: readonly [SpotId, SpotId] | null, at: SpotId | null, target: SpotId): SpotId[] {
    if (at) return this.path(at, target);
    const cands = edge ?? this.spots.map((s) => s.id);
    let best = cands[0];
    let bestCost = Infinity;
    for (const c of cands) {
      const s = this.spot[c];
      const cost = dist(x, z, s.x, s.z) + this.pathLen(c, target);
      if (cost < bestCost) {
        bestCost = cost;
        best = c;
      }
    }
    return best === target ? [target] : [best, ...this.path(best, target)];
  }

  /** Length of a route starting from a position. */
  routeLen(x: number, z: number, route: readonly SpotId[]): number {
    let len = 0;
    let px = x;
    let pz = z;
    for (const id of route) {
      const s = this.spot[id];
      len += dist(px, pz, s.x, s.z);
      px = s.x;
      pz = s.z;
    }
    return len;
  }

  /**
   * Aim target from a floor hit in room metres. The current spot stays selected
   * until the hit is more than the stick radius from it; otherwise the nearest
   * allowed spot inside the pick radius wins. Doorways are never picked.
   */
  pickSpot(x: number, z: number, allowed: (id: SpotId) => boolean, current: SpotId | null): SpotId | null {
    const stick = T.stickRadius / this.scale;
    const pick = T.pickRadius / this.scale;
    if (current && allowed(current) && dist(x, z, this.spot[current].x, this.spot[current].z) <= stick) return current;
    let best: SpotId | null = null;
    let bestD = pick;
    for (const s of this.spots) {
      if (s.door || !allowed(s.id)) continue;
      const d = dist(x, z, s.x, s.z);
      if (d <= bestD) {
        bestD = d;
        best = s.id;
      }
    }
    return best;
  }

  /** Nothing solid between two points: they can see and hear each other. */
  clear(ax: number, az: number, bx: number, bz: number, vaultOpen: boolean): boolean {
    for (const w of this.job.walls) if (crosses(ax, az, bx, bz, w)) return false;
    const v = this.job.vaultDoor;
    return !v || vaultOpen || !crosses(ax, az, bx, bz, v);
  }

  /** How far a ray from (x, z) travels, up to t, before a wall stops it. */
  ray(x: number, z: number, dx: number, dz: number, t: number, vaultOpen: boolean): number {
    const hit = (s: Seg) => {
      const [cx, cz, ex, ez] = s;
      const sx = ex - cx;
      const sz = ez - cz;
      const den = dx * sz - dz * sx;
      if (Math.abs(den) < 1e-9) return;
      const u = ((cx - x) * sz - (cz - z) * sx) / den;
      const v = ((cx - x) * dz - (cz - z) * dx) / den;
      if (u > 1e-4 && v >= 0 && v <= 1) t = Math.min(t, u);
    };
    for (const w of this.job.walls) hit(w);
    if (this.job.vaultDoor && !vaultOpen) hit(this.job.vaultDoor);
    return t;
  }

  /** Is this point in a room the breaker lights? */
  lit(x: number, z: number): boolean {
    return !!this.job.lit?.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
  }

  /**
   * A guard's round as timed segments: walk, pause facing somewhere, turn.
   * In a varied job the seed picks the round and stretches each pause.
   */
  makeLoop(guard: number, speed: number, seed: number): Loop {
    const def = this.job.guards[guard];
    const r = this.job.varied ? rng(seed * 7919 + guard * 104729) : null;
    const wps = r ? def.routes[Math.floor(r() * def.routes.length)] : def.routes[0];
    const segments: Segment[] = [];
    let t = 0;
    let joinT = 0;
    for (let i = 0; i < wps.length; i++) {
      const a = wps[i];
      const b = wps[(i + 1) % wps.length];
      const walkHeading = Math.atan2(b.z - a.z, b.x - a.x);
      const pause = r && a.pause > 0 ? a.pause * (0.6 + 0.8 * r()) : a.pause;
      if (i === def.intro?.join) joinT = t;
      if (pause > 0) {
        segments.push({ t0: t, t1: t + pause, kind: 'pause', ax: a.x, az: a.z, bx: a.x, bz: a.z, heading: a.face });
        t += pause;
        segments.push({ t0: t, t1: t + T.bertTurnS, kind: 'turn', ax: a.x, az: a.z, bx: a.x, bz: a.z, heading: walkHeading });
        t += T.bertTurnS;
      }
      const d = dist(a.x, a.z, b.x, b.z);
      segments.push({ t0: t, t1: t + d / speed, kind: 'walk', ax: a.x, az: a.z, bx: b.x, bz: b.z, heading: walkHeading });
      t += d / speed;
    }
    return { segments, period: t, joinPhase: joinT / t, points: wps.map((w) => [w.x, w.z]) };
  }
}

export function sampleLoop(loop: Loop, phase: number, out: GuardPose): GuardPose {
  const t = (((phase % 1) + 1) % 1) * loop.period;
  const segs = loop.segments;
  let s = segs[segs.length - 1];
  for (const seg of segs)
    if (t < seg.t1) {
      s = seg;
      break;
    }
  const u = Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0)));
  out.x = s.ax + (s.bx - s.ax) * u;
  out.z = s.az + (s.bz - s.az) * u;
  out.heading = s.heading;
  out.walking = s.kind === 'walk';
  out.flicker = s.kind === 'pause' && s.t1 - t < T.bertFlickerS;
  return out;
}

const levels = new Map<JobId, Level>();
/** One Level per job, shared by every sim of that job. */
export function level(id: JobId): Level {
  let l = levels.get(id);
  if (!l) levels.set(id, (l = new Level(JOBS[id])));
  return l;
}
