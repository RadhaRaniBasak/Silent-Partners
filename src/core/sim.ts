import { DEG, T } from '../tuning';
import {
  type ActionId,
  type GuardPose,
  type JobId,
  LARK_CREEP,
  type Level,
  type Loop,
  type SpotId,
  dist,
  level as levelOf,
  rng,
  sampleLoop,
} from '../level';

/**
 * The heist simulation. Deterministic: a fixed step, randomness only from the
 * run's seed, and its whole state is one plain object, so a snapshot is a
 * deep copy and a rewind replays exactly the same puzzle.
 */

export type ThiefId = 'lark' | 'rook';
export type TState = 'outside' | 'climbing' | 'idle' | 'moving' | 'frozen' | 'working';
export type { ActionId };
/** What spotted a thief: 'eye', 'sensor', 'laser', or a guard's id. */
export type By = string;
export type ActResult = 'ok' | 'wrong' | 'none' | 'busy' | 'pair';
export type SensorState = 'off' | 'rest' | 'warn' | 'armed';

export interface Thief {
  id: ThiefId;
  state: TState;
  x: number;
  z: number;
  face: number;
  route: SpotId[];
  /** Edge being walked, for re-routing from mid-route. */
  edge: [SpotId, SpotId] | null;
  /** Spot the thief stands on, if any. */
  at: SpotId | null;
  action: ActionId | null;
  /** Electronics: the Eye, the motion sensor, the lasers. */
  eye: number;
  /** The guards. */
  guard: number;
  timer: number;
  /** Beat 1 creep: 0 off, else 1-based index of the creep point being walked to. */
  creep: number;
}

export interface Guard {
  mode: 'wait' | 'look' | 'exit' | 'loop';
  x: number;
  z: number;
  heading: number;
  phase: number;
  modeT: number;
  suspect: ThiefId | null;
  walking: boolean;
  flicker: boolean;
  /** Seconds left turned toward a sound, and where the sound came from. */
  listen: number;
  noiseX: number;
  noiseZ: number;
  /** Seconds before another sound can draw him. */
  deaf: number;
  /** Investigating (Job 2): 0 no, 1 walking there, 2 searching, 3 walking back to his round. */
  inv: 0 | 1 | 2 | 3;
  invX: number;
  invZ: number;
  invT: number;
  homeX: number;
  homeZ: number;
  /** Where he last saw his suspect. */
  lastX: number;
  lastZ: number;
}

export interface Coin {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  t: number;
}

export interface State {
  t: number;
  lark: Thief;
  rook: Thief;
  /** Job 1: the crew carries the painting between them. */
  carrying: boolean;
  /** Job 2: Lark has the Heron. */
  loot: boolean;
  progress: Record<ActionId, number>;
  bracketOpen: boolean;
  cameraOn: boolean;
  eyeAwake: boolean;
  eyePhase: number;
  lasersOn: boolean;
  lightsOn: boolean;
  vaultOpen: boolean;
  coins: number;
  coin: Coin | null;
  guards: Guard[];
  invulnerable: boolean;
  escaped: boolean;
  maxMeter: number;
}

export type SimEvent =
  | { type: 'arrived'; thief: ThiefId; spot: SpotId }
  | { type: 'done'; action: ActionId }
  | { type: 'spotted'; thief: ThiefId; by: By }
  | { type: 'suspicious'; thief: ThiefId; guard: number }
  | { type: 'heard'; thief: ThiefId; guard: number }
  | { type: 'calm'; guard: number }
  | { type: 'climbed'; thief: ThiefId }
  | { type: 'out'; thief: ThiefId }
  | { type: 'coin'; guard: number; x: number; z: number }
  | { type: 'escaped' };

interface Task {
  who: ThiefId | 'both';
  time: number;
  ready: (s: State) => boolean;
  done: (s: State) => void;
}

/** Every task, in the order a spot offers them. */
export const TASKS: Record<ActionId, Task> = {
  cut: { who: 'rook', time: T.cutS, ready: (s) => s.cameraOn, done: (s) => void (s.cameraOn = false) },
  unlock: { who: 'lark', time: T.unlockS, ready: (s) => !s.bracketOpen, done: (s) => void (s.bracketOpen = true) },
  lift: { who: 'both', time: T.liftS, ready: (s) => s.bracketOpen && !s.carrying, done: (s) => void (s.carrying = true) },
  power: { who: 'rook', time: T.powerS, ready: (s) => s.lasersOn, done: (s) => void (s.lasersOn = false) },
  lights: { who: 'rook', time: T.lightsS, ready: (s) => s.lightsOn, done: (s) => void (s.lightsOn = false) },
  keys: { who: 'both', time: T.keysS, ready: (s) => !s.vaultOpen, done: (s) => void (s.vaultOpen = true) },
  crack: { who: 'lark', time: T.crackS, ready: (s) => s.vaultOpen && !s.loot, done: (s) => void (s.loot = true) },
};
const ORDER = Object.keys(TASKS) as ActionId[];

export const ACTION_TIME = Object.fromEntries(ORDER.map((a) => [a, TASKS[a].time])) as Record<ActionId, number>;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeThief(id: ThiefId, x: number, z: number, state: TState, at: SpotId | null): Thief {
  return { id, state, x, z, face: 0, route: [], edge: null, at, action: null, eye: 0, guard: 0, timer: 0, creep: 0 };
}

function makeGuard(x: number, z: number, mode: Guard['mode']): Guard {
  return {
    mode, x, z, heading: 0, phase: 0, modeT: 0, suspect: null, walking: false, flicker: false,
    listen: 0, noiseX: 0, noiseZ: 0, deaf: 0, inv: 0, invX: 0, invZ: 0, invT: 0, homeX: 0, homeZ: 0, lastX: 0, lastZ: 0,
  };
}

export class Sim {
  level: Level;
  /** The night: which rounds the guards walk and how long they linger (varied jobs). */
  seed: number;
  s: State;
  events: SimEvent[] = [];
  assist = false;
  loops: Loop[];
  private pose: GuardPose = { x: 0, z: 0, heading: 0, walking: false, flicker: false };

  constructor(job: JobId = 'gallery', seed = 1) {
    this.level = levelOf(job);
    this.seed = seed;
    this.loops = this.makeLoops();
    this.s = this.initial();
  }

  private makeLoops() {
    const speed = this.assist ? T.bertSpeedAssist : T.bertSpeed;
    return this.level.job.guards.map((_, i) => this.level.makeLoop(i, speed, this.seed));
  }

  private initial(): State {
    const L = this.level;
    const job = L.job;
    const out = job.outside;
    const start = job.id === 'gallery' ? L.spot.curtains : null;
    const r = rng(this.seed);
    const guards = job.guards.map((def, i) => {
      if (def.intro) return makeGuard(def.intro.x, def.intro.z, 'wait');
      const g = makeGuard(0, 0, 'loop');
      g.phase = ((def.start ?? 0) + (job.varied ? r() * 0.2 - 0.1 : 0) + 1) % 1;
      sampleLoop(this.loops[i], g.phase, this.pose);
      g.x = this.pose.x;
      g.z = this.pose.z;
      g.heading = this.pose.heading;
      return g;
    });
    return {
      t: 0,
      lark: start ? makeThief('lark', start.x, start.z, 'idle', start.id) : makeThief('lark', out.x, out.z, 'outside', null),
      rook: makeThief('rook', out.x, out.z, 'outside', null),
      carrying: false,
      loot: false,
      progress: Object.fromEntries(ORDER.map((a) => [a, 0])) as Record<ActionId, number>,
      bracketOpen: false,
      cameraOn: !!job.eye,
      eyeAwake: false,
      eyePhase: 0,
      lasersOn: !!job.lasers,
      lightsOn: !!job.lit,
      vaultOpen: false,
      coins: job.smart ? T.coins : 0,
      coin: null,
      guards,
      invulnerable: false,
      escaped: false,
      maxMeter: 0,
    };
  }

  setAssist(on: boolean) {
    this.assist = on;
    this.loops = this.makeLoops();
  }

  /** Same plan, night and pace as another sim, for playing moves out on a copy. */
  mirror(o: Sim) {
    this.level = o.level;
    this.seed = o.seed;
    this.assist = o.assist;
    this.loops = o.loops;
  }

  save(): State {
    return structuredClone(this.s);
  }

  load(state: State) {
    this.s = structuredClone(state);
  }

  present(th: Thief) {
    return th.state !== 'outside' && th.state !== 'climbing';
  }

  /** While carrying, both thieves move as one: Lark leads. */
  private leader(id: ThiefId) {
    return this.s.carrying ? this.s.lark : this.s[id];
  }

  private other(th: Thief) {
    return th.id === 'lark' ? this.s.rook : this.s.lark;
  }

  private stop(th: Thief, state: TState) {
    th.state = state;
    th.route = [];
    th.action = null;
    th.creep = 0;
  }

  private paired(th: Thief) {
    return !!th.action && TASKS[th.action].who === 'both';
  }

  // Orders. Each returns whether anything changed; repeating an order is harmless.

  freeze(id: ThiefId): boolean {
    const th = this.leader(id);
    if (!this.present(th) || th.state === 'frozen') return false;
    const pair = this.paired(th);
    this.stop(th, 'frozen');
    if (pair) this.stop(this.other(th), 'frozen');
    return true;
  }

  go(id: ThiefId, spot: SpotId): boolean {
    const th = this.leader(id);
    if (!this.present(th)) return false;
    if (th.state === 'moving' && th.route[th.route.length - 1] === spot) return false;
    const S = this.level.spot[spot];
    if (th.at === spot || dist(th.x, th.z, S.x, S.z) < T.arriveRadius) {
      if (th.state !== 'frozen') return false;
      th.state = 'idle';
      return true;
    }
    if (this.paired(th)) this.stop(this.other(th), 'idle');
    th.route = this.level.planRoute(th.x, th.z, th.edge, th.at, spot);
    th.state = 'moving';
    th.action = null;
    th.creep = 0;
    if (th.at) {
      th.edge = [th.at, th.route[0]];
      th.at = null;
    }
    return true;
  }

  /** The first task this spot offers right now. */
  taskAt(spot: SpotId): ActionId | null {
    const tasks = this.level.job.tasks;
    for (const a of ORDER) if (tasks[a]?.includes(spot) && TASKS[a].ready(this.s)) return a;
    return null;
  }

  act(id: ThiefId): ActResult {
    const s = this.s;
    const th = s[id];
    if (s.carrying || !this.present(th) || th.state === 'moving' || !th.at) return 'none';
    const action = this.taskAt(th.at);
    if (!action) return 'none';
    const who = TASKS[action].who;
    if (who === 'both') return 'pair';
    if (who !== id) return 'wrong';
    if (th.state === 'working' && th.action === action) return 'busy';
    th.state = 'working';
    th.action = action;
    th.route = [];
    return 'ok';
  }

  /** The two-person task both partners stand ready for, if any. */
  pairTask(): ActionId | null {
    const { lark, rook, carrying } = this.s;
    if (carrying) return null;
    const ready = (th: Thief) => th.state !== 'moving' && this.present(th);
    if (!ready(lark) || !ready(rook)) return null;
    for (const a of ORDER) {
      const spots = this.level.job.tasks[a];
      if (!spots || TASKS[a].who !== 'both' || !TASKS[a].ready(this.s)) continue;
      const [p, q] = spots;
      if ((lark.at === p && rook.at === q) || (lark.at === q && rook.at === p)) return a;
    }
    return null;
  }

  canPair(): boolean {
    return this.pairTask() !== null;
  }

  startPair(): boolean {
    const a = this.pairTask();
    if (!a) return false;
    for (const th of [this.s.lark, this.s.rook]) {
      th.state = 'working';
      th.action = a;
    }
    return true;
  }

  climbIn(id: ThiefId) {
    const th = this.s[id];
    if (th.state !== 'outside') return;
    th.state = 'climbing';
    th.timer = T.climbS;
  }

  /** Job 2: a coin tossed at a spot, for a guard to go and look at. */
  toss(id: ThiefId, spot: SpotId): boolean {
    const s = this.s;
    const th = this.leader(id);
    if (s.coins <= 0 || s.coin || !this.present(th)) return false;
    const sp = this.level.spot[spot];
    if (dist(th.x, th.z, sp.x, sp.z) > T.tossRange || !this.clear(th.x, th.z, sp.x, sp.z)) return false;
    s.coins--;
    s.coin = { x0: th.x, z0: th.z, x1: sp.x, z1: sp.z, t: 0 };
    return true;
  }

  startCreep() {
    const l = this.s.lark;
    l.state = 'moving';
    l.creep = 1;
    l.at = null;
    l.edge = null;
    [l.x, l.z] = LARK_CREEP[1];
  }

  bertLook() {
    const b = this.s.guards[0];
    if (b.mode !== 'wait') return;
    b.mode = 'look';
    b.modeT = 0;
  }

  wakeEye(phase: number) {
    this.s.eyeAwake = true;
    this.s.eyePhase = phase;
  }

  bertSpeed() {
    return this.assist ? T.bertSpeedAssist : T.bertSpeed;
  }

  eyeAngle() {
    const e = this.level.job.eye!;
    return Math.atan2(e.aimZ - e.z, e.aimX - e.x) + T.eyeSweepDeg * DEG * Math.sin(2 * Math.PI * this.s.eyePhase);
  }

  /** Nothing solid between two points (the vault door counts until it opens). */
  clear(ax: number, az: number, bx: number, bz: number) {
    return this.level.clear(ax, az, bx, bz, this.s.vaultOpen);
  }

  /** A guard's light: a wide beam in a lit room, his torch in the dark. */
  cone(i: number): { range: number; half: number } {
    const b = this.s.guards[i];
    const lit = this.s.lightsOn && this.level.lit(b.x, b.z);
    return lit ? { range: T.litRange, half: T.litHalfDeg * DEG } : { range: T.torchRange, half: T.torchHalfDeg * DEG };
  }

  /** Can guard i see this point? */
  sees(i: number, x: number, z: number, extraRange = 0, extraDeg = 0): boolean {
    const b = this.s.guards[i];
    const { range, half } = this.cone(i);
    const dx = x - b.x;
    const dz = z - b.z;
    if (Math.hypot(dx, dz) > range + extraRange) return false;
    if (Math.abs(wrap(Math.atan2(dz, dx) - b.heading)) > half + extraDeg * DEG) return false;
    return this.clear(b.x, b.z, x, z);
  }

  /** Does any guard's light reach this point? */
  inTorch(x: number, z: number, extraRange = 0, extraDeg = 0): boolean {
    for (let i = 0; i < this.s.guards.length; i++) if (this.sees(i, x, z, extraRange, extraDeg)) return true;
    return false;
  }

  inEye(x: number, z: number): boolean {
    const e = this.level.job.eye!;
    const dx = x - e.x;
    const dz = z - e.z;
    if (Math.hypot(dx, dz) > T.eyeRange) return false;
    return Math.abs(wrap(Math.atan2(dz, dx) - this.eyeAngle())) <= T.eyeHalfDeg * DEG;
  }

  /** The motion sensor's cycle: resting, a warning blink, then armed. Assist gives longer rests. */
  sensor(): SensorState {
    if (!this.level.job.sensor) return 'off';
    const rest = this.assist ? T.sensorRestS * 1.5 : T.sensorRestS;
    const u = this.s.t % (T.sensorPeriod - T.sensorRestS + rest);
    return u < rest ? 'rest' : u < rest + T.sensorWarnS ? 'warn' : 'armed';
  }

  /** In the sensor's circle, and not behind a wall from it. */
  inSensor(x: number, z: number) {
    const c = this.level.job.sensor;
    return !!c && dist(x, z, c.x, c.z) <= c.r && this.clear(c.x, c.z, x, z);
  }

  onLasers(x: number, z: number) {
    const l = this.level.job.lasers;
    return !!l && Math.abs(x - l[0]) <= T.laserWidth && z >= l[1] && z <= l[3];
  }

  step(dt = T.step) {
    const s = this.s;
    s.t += dt;
    for (let i = 0; i < s.guards.length; i++) this.stepGuard(i, dt);
    if (s.eyeAwake && s.cameraOn) s.eyePhase = (s.eyePhase + dt / (this.assist ? T.eyePeriodAssist : T.eyePeriod)) % 1;
    this.stepThief(s.lark, dt);
    if (s.carrying) this.follow();
    else this.stepThief(s.rook, dt);
    this.stepWork(dt);
    if (s.loot) this.leave();
    if (s.coin) this.stepCoin(dt);
    this.hear();
    this.detect(dt);
  }

  private stepGuard(i: number, dt: number) {
    const b = this.s.guards[i];
    const loop = this.loops[i];
    let target = b.heading;
    b.walking = false;
    b.flicker = false;
    b.deaf = Math.max(0, b.deaf - dt);
    switch (b.mode) {
      case 'wait':
        target = 0;
        break;
      case 'look': {
        const l = this.s.lark;
        b.modeT += dt;
        target = Math.atan2(l.z - b.z, l.x - b.x);
        if (b.modeT >= T.bertLookS) {
          b.mode = 'exit';
          b.modeT = 0;
        }
        break;
      }
      case 'exit': {
        const def = this.level.job.guards[i];
        const j = def.routes[0][def.intro!.join];
        const d = dist(b.x, b.z, j.x, j.z);
        const len = this.bertSpeed() * dt;
        target = Math.atan2(j.z - b.z, j.x - b.x);
        b.walking = true;
        if (d <= len) {
          b.x = j.x;
          b.z = j.z;
          b.mode = 'loop';
          b.phase = loop.joinPhase;
        } else {
          b.x += ((j.x - b.x) / d) * len;
          b.z += ((j.z - b.z) / d) * len;
        }
        break;
      }
      case 'loop': {
        if (b.suspect) {
          const t = this.s[b.suspect];
          target = Math.atan2(t.z - b.z, t.x - b.x);
          break;
        }
        // Heard something: stop and shine the torch at where the sound came from.
        if (b.listen > 0) {
          b.listen = Math.max(0, b.listen - dt);
          target = Math.atan2(b.noiseZ - b.z, b.noiseX - b.x);
          break;
        }
        if (b.inv) {
          target = this.investigate(b, dt);
          break;
        }
        b.phase = (b.phase + dt / loop.period) % 1;
        sampleLoop(loop, b.phase, this.pose);
        b.x = this.pose.x;
        b.z = this.pose.z;
        target = this.pose.heading;
        b.walking = this.pose.walking;
        b.flicker = this.pose.flicker;
      }
    }
    const max = T.torchTurnDegPerS * DEG * dt;
    const diff = wrap(target - b.heading);
    b.heading = wrap(b.heading + Math.max(-max, Math.min(max, diff)));
  }

  /** Walk over, sweep the torch around, walk back to the round. Returns the heading wanted. */
  private investigate(b: Guard, dt: number): number {
    if (b.inv === 2) {
      b.invT += dt;
      if (b.invT >= T.searchS) b.inv = 3;
      return Math.atan2(b.invZ - b.z, b.invX - b.x) + Math.sin(b.invT * 2.4) * T.searchSweepDeg * DEG;
    }
    const going = b.inv === 1;
    const tx = going ? b.invX : b.homeX;
    const tz = going ? b.invZ : b.homeZ;
    const d = dist(b.x, b.z, tx, tz) - (going ? T.searchStop : 0);
    const head = Math.atan2(tz - b.z, tx - b.x);
    const len = T.investigateSpeed * dt;
    if (d <= len) {
      if (going) {
        const k = Math.max(0, d);
        b.x += Math.cos(head) * k;
        b.z += Math.sin(head) * k;
        b.inv = 2;
        b.invT = 0;
      } else {
        b.x = tx;
        b.z = tz;
        b.inv = 0;
      }
    } else {
      b.x += Math.cos(head) * len;
      b.z += Math.sin(head) * len;
      b.walking = true;
    }
    return head;
  }

  /** A smart guard heads off to look at (x, z), after a moment turned toward it. */
  private alert(b: Guard, x: number, z: number, listenS: number) {
    if (!b.inv) {
      b.homeX = b.x;
      b.homeZ = b.z;
    }
    b.inv = 1;
    b.invX = x;
    b.invZ = z;
    b.invT = 0;
    b.listen = listenS;
    b.noiseX = x;
    b.noiseZ = z;
  }

  private stepThief(th: Thief, dt: number) {
    if (th.state === 'climbing') {
      const out = this.level.job.outside;
      const entry = this.level.spot[this.level.job.entry];
      th.timer -= dt;
      const u = Math.min(1, 1 - th.timer / T.climbS);
      th.x = out.x + (entry.x - out.x) * u;
      th.z = out.z + (entry.z - out.z) * u;
      th.face = 0;
      if (th.timer <= 0) {
        th.state = 'idle';
        th.at = entry.id;
        this.events.push({ type: 'climbed', thief: th.id });
      }
      return;
    }
    if (th.state !== 'moving') return;
    if (th.creep) {
      const [tx, tz] = LARK_CREEP[th.creep - 1];
      const d = dist(th.x, th.z, tx, tz);
      const len = T.creepSpeed * dt;
      th.face = Math.atan2(tz - th.z, tx - th.x);
      if (d <= len) {
        th.x = tx;
        th.z = tz;
        th.creep = th.creep === 1 ? 2 : 1;
      } else {
        th.x += ((tx - th.x) / d) * len;
        th.z += ((tz - th.z) / d) * len;
      }
      return;
    }
    let left = (this.s.carrying ? T.carrySpeed : T.thiefSpeed) * dt;
    while (left > 0 && th.route.length) {
      const sp = this.level.spot[th.route[0]];
      const d = dist(th.x, th.z, sp.x, sp.z);
      if (d > 1e-6) th.face = Math.atan2(sp.z - th.z, sp.x - th.x);
      if (d <= left) {
        th.x = sp.x;
        th.z = sp.z;
        left -= d;
        const reached = th.route.shift()!;
        if (th.route.length) {
          th.edge = [reached, th.route[0]];
          continue;
        }
        th.edge = null;
        th.at = reached;
        th.state = 'idle';
        this.events.push({ type: 'arrived', thief: th.id, spot: reached });
        if (this.s.carrying && reached === this.level.job.entry) {
          this.s.escaped = true;
          this.events.push({ type: 'escaped' });
        }
      } else {
        th.x += ((sp.x - th.x) / d) * left;
        th.z += ((sp.z - th.z) / d) * left;
        left = 0;
      }
    }
  }

  /** While carrying, Rook walks beside Lark with the painting between them. */
  private follow() {
    const { lark: l, rook: r } = this.s;
    r.x = l.x - Math.sin(l.face) * 0.35;
    r.z = l.z + Math.cos(l.face) * 0.35;
    r.face = l.face;
    r.state = l.state;
    r.at = l.at;
    r.edge = l.edge;
    r.route = [];
  }

  private stepWork(dt: number) {
    const s = this.s;
    for (const th of [s.lark, s.rook]) {
      const a = th.action;
      if (th.state !== 'working' || !a || TASKS[a].who === 'both') continue;
      s.progress[a] += dt;
      if (s.progress[a] >= TASKS[a].time) {
        this.stop(th, 'idle');
        TASKS[a].done(s);
        this.events.push({ type: 'done', action: a });
      }
    }
    const a = s.lark.action;
    if (s.lark.state === 'working' && s.rook.state === 'working' && a && a === s.rook.action && TASKS[a].who === 'both') {
      s.progress[a] += dt;
      if (s.progress[a] >= TASKS[a].time) {
        TASKS[a].done(s);
        this.stop(s.lark, 'idle');
        this.stop(s.rook, 'idle');
        this.events.push({ type: 'done', action: a });
      }
    }
  }

  /** Job 2: with the Heron taken, whoever stands at the dock slips out. */
  private leave() {
    const s = this.s;
    for (const th of [s.lark, s.rook]) {
      if (!this.present(th) || th.at !== this.level.job.entry || th.state === 'moving' || th.state === 'working') continue;
      this.stop(th, 'outside');
      th.at = null;
      th.eye = th.guard = 0;
      this.events.push({ type: 'out', thief: th.id });
    }
    if (!s.escaped && s.lark.state === 'outside' && s.rook.state === 'outside') {
      s.escaped = true;
      this.events.push({ type: 'escaped' });
    }
  }

  /** The coin lands: the nearest guard who can hear it goes to look. */
  private stepCoin(dt: number) {
    const s = this.s;
    const c = s.coin!;
    c.t += dt;
    if (c.t < T.tossS) return;
    s.coin = null;
    let best = -1;
    let bestD = T.coinHear;
    s.guards.forEach((b, i) => {
      const d = dist(b.x, b.z, c.x1, c.z1);
      if (b.mode !== 'loop' || b.suspect || d > bestD || !this.clear(b.x, b.z, c.x1, c.z1)) return;
      best = i;
      bestD = d;
    });
    if (best >= 0) this.alert(s.guards[best], c.x1, c.z1, T.listenSmartS);
    this.events.push({ type: 'coin', guard: best, x: c.x1, z: c.z1 });
  }

  /**
   * Footsteps: a partner walking close to a guard, outside his light, makes him
   * stop and turn toward the sound (a smart guard then goes to look). A frozen
   * or creeping partner is silent; carrying the painting is louder; walls stop it.
   */
  private hear() {
    const s = this.s;
    const smart = this.level.job.smart;
    const range = (this.assist ? T.hearAssist : T.hear) * (s.carrying ? T.hearCarry : 1);
    for (let i = 0; i < s.guards.length; i++) {
      const b = s.guards[i];
      if (b.mode !== 'loop' || b.suspect || b.listen > 0 || b.deaf > 0 || b.inv) continue;
      for (const th of s.carrying ? [s.lark] : [s.lark, s.rook]) {
        if (th.state !== 'moving' || th.creep || !this.present(th)) continue;
        if (dist(th.x, th.z, b.x, b.z) > range || this.sees(i, th.x, th.z) || !this.clear(b.x, b.z, th.x, th.z)) continue;
        if (smart) this.alert(b, th.x, th.z, T.listenSmartS);
        else {
          b.listen = T.listenS;
          b.noiseX = th.x;
          b.noiseZ = th.z;
        }
        b.deaf = T.listenS + T.deafS;
        this.events.push({ type: 'heard', thief: th.id, guard: i });
        break;
      }
    }
  }

  private detect(dt: number) {
    const s = this.s;
    const job = this.level.job;
    const fillActive = this.assist ? T.fillActiveAssistS : T.fillActiveS;
    const fillStill = this.assist ? T.fillStillOpenAssistS : T.fillStillOpenS;
    const armed = this.sensor() === 'armed';
    const list = s.carrying ? [s.lark] : [s.lark, s.rook];
    for (const th of list) {
      if (!this.present(th)) {
        th.eye = th.guard = 0;
        continue;
      }
      const active = th.state === 'moving' || th.state === 'working';
      const eyeSees = s.eyeAwake && s.cameraOn && active && this.inEye(th.x, th.z);
      const sensed = armed && active && this.inSensor(th.x, th.z);
      const laser = s.lasersOn && this.onLasers(th.x, th.z);
      let seer = -1;
      if (active || !this.level.nearCover(th.x, th.z))
        for (let i = 0; i < s.guards.length && seer < 0; i++) if (this.sees(i, th.x, th.z)) seer = i;
      th.eye = laser ? 1 : clamp01(th.eye + (sensed ? dt / T.sensorFillS : eyeSees ? dt / fillActive : -dt / T.drainS));
      th.guard = clamp01(th.guard + (seer >= 0 ? dt / (active ? fillActive : fillStill) : -dt / T.drainS));
      s.maxMeter = Math.max(s.maxMeter, th.eye, th.guard);
      if (seer >= 0) {
        const b = s.guards[seer];
        if (b.suspect === th.id) {
          b.lastX = th.x;
          b.lastZ = th.z;
        }
        if (b.mode === 'loop' && !b.suspect && active && th.guard >= T.suspiciousAt) {
          b.suspect = th.id;
          b.lastX = th.x;
          b.lastZ = th.z;
          this.events.push({ type: 'suspicious', thief: th.id, guard: seer });
        }
      }
      if (!s.invulnerable) {
        if (th.eye >= 1) this.events.push({ type: 'spotted', thief: th.id, by: laser ? 'laser' : job.eye ? 'eye' : 'sensor' });
        else if (th.guard >= 1) this.events.push({ type: 'spotted', thief: th.id, by: job.guards[Math.max(0, seer)].id });
      }
    }
    if (s.carrying) {
      s.rook.eye = s.lark.eye;
      s.rook.guard = s.lark.guard;
    }
    for (let i = 0; i < s.guards.length; i++) {
      const b = s.guards[i];
      if (b.suspect && s[b.suspect].guard < T.calmAt) {
        b.suspect = null;
        this.events.push({ type: 'calm', guard: i });
        // A smart guard goes to look where he last saw them.
        if (job.smart) this.alert(b, b.lastX, b.lastZ, 0);
      }
    }
  }
}

/** A safe restart point: everyone standing still, meters empty, guards calm. */
export function settle(state: State): State {
  for (const th of [state.lark, state.rook]) {
    if (th.creep) continue;
    if (th.state === 'moving' || th.state === 'working') {
      th.state = 'idle';
      th.route = [];
      th.action = null;
    }
    th.eye = 0;
    th.guard = 0;
  }
  for (const b of state.guards) {
    b.suspect = null;
    b.listen = 0;
    b.deaf = 0;
    if (b.inv === 1 || b.inv === 2) b.inv = 3;
  }
  state.coin = null;
  return state;
}
