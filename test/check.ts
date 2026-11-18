/**
 * One runnable check for the game's logic: recognition on synthetic hands,
 * the level's timing, and a bot that must beat the whole heist.
 * Run: npm run check
 */
import { DEG, T } from '../src/tuning';
import { type JobId, type SpotId, dist, level, sampleLoop } from '../src/level';
import {
  Recorder,
  buildTemplates,
  clashWith,
  classify,
  features,
  palmUp,
  type Cmd,
  type Pose,
  PoseFilter,
} from '../src/core/recognize';
import { type HandShape, SHAPES, handJoints } from '../src/core/handgen';
import { Sim, type State } from '../src/core/sim';
import { DEFAULT_SETTINGS, Game, type HandId, type HandInput } from '../src/core/game';
import { botStep, idleSafe } from '../src/core/bot';

const GAL = level('gallery');
const SPOT = GAL.spot;
const pickSpot = GAL.pickSpot.bind(GAL);

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed++;
}

// Seeded randomness so every run is the same.
let seed = 42;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

type Quat = [number, number, number, number];
function randomQuat(): Quat {
  const u1 = rand(), u2 = rand(), u3 = rand();
  const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
  return [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
}
function rotate(q: Quat, x: number, y: number, z: number): [number, number, number] {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}
function posed(shape: HandShape, left: boolean, scale: number, q: Quat, noise: number): Float32Array {
  const j = handJoints(shape, left, scale);
  for (let i = 0; i < 25; i++) {
    const [x, y, z] = rotate(q, j[i * 3], j[i * 3 + 1], j[i * 3 + 2]);
    j[i * 3] = x + gauss() * noise;
    j[i * 3 + 1] = 1 + y + gauss() * noise;
    j[i * 3 + 2] = -0.4 + z + gauss() * noise;
  }
  return j;
}
const jitter = (s: HandShape): HandShape => ({
  curls: s.curls.map((c) => clamp01(c + (rand() - 0.5) * 0.16)) as HandShape['curls'],
  thumb: clamp01(s.thumb + (rand() - 0.5) * 0.2),
  side: clamp01(s.side + (rand() - 0.5) * 0.2),
});

// ── Recognition ────────────────────────────────────────────────────────────
const templates = buildTemplates({});
{
  const cases: [keyof typeof SHAPES, Pose][] = [['fist', 'fist'], ['point', 'point'], ['thumb', 'thumb'], ['two', 'two'], ['open', 'open']];
  for (const [shape, want] of cases) {
    let hit = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const j = posed(jitter(SHAPES[shape]), rand() < 0.5, 0.85 + rand() * 0.3, randomQuat(), 0.0015);
      if (classify(features(j), templates) === want) hit++;
    }
    check(`${shape} recognised in any orientation, size and hand`, hit / n >= 0.97, `${((100 * hit) / n).toFixed(1)}%`);
  }
  let commands = 0;
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const relaxed: HandShape = {
      curls: [0, 0, 0, 0].map(() => 0.2 + rand() * 0.45) as HandShape['curls'],
      thumb: rand() * 0.5,
      side: rand(),
    };
    const p = classify(features(posed(relaxed, rand() < 0.5, 0.85 + rand() * 0.3, randomQuat(), 0.0015)), templates);
    if (p === 'fist' || p === 'point' || p === 'thumb' || p === 'two') commands++;
  }
  check('relaxed hands rarely look like a command', commands / n <= 0.02, `${((100 * commands) / n).toFixed(2)}% of frames`);

  const up: Quat = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  const down: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
  check('palm facing up is detected for both hands',
    palmUp(posed(SHAPES.open, false, 1, up, 0), false) > 0.9 && palmUp(posed(SHAPES.open, true, 1, up, 0), true) > 0.9 &&
    palmUp(posed(SHAPES.open, false, 1, down, 0), false) < -0.9);
}

// ── Confirm filter ────────────────────────────────────────────────────────
{
  const f = new PoseFilter();
  const fired: string[] = [];
  const plan: [Pose, number][] = [['none', 300], ['fist', 400], ['none', 200], ['point', 500], ['thumb', 400], ['none', 300], ['thumb', 50], ['none', 200], ['fist', 60], ['none', 300]];
  let t = 0;
  for (const [pose, ms] of plan)
    for (let e = 0; e < ms; e += 1000 / 72) {
      t += 1000 / 72;
      const glitch = rand() < 0.05;
      const r = f.update(glitch ? 'none' : pose, t);
      if (r) fired.push(r);
    }
  check('each held pose fires once; glitches and brief poses never fire', fired.join(',') === 'fist,point,thumb', fired.join(','));
}

// ── Re-recording ──────────────────────────────────────────────────────────
{
  const rec = new Recorder();
  const open = features(posed(SHAPES.open, false, 1, randomQuat(), 0));
  for (let t = 0; t < 6 && rec.phase !== 'done'; t += 1 / 72) rec.update(open.map((v) => clamp01(v + gauss() * 0.01)), 1 / 72);
  const tpl = rec.template;
  const close = tpl.every((v, k) => Math.abs(v - open[k]) < 0.05);
  check('recorder captures three steady samples', rec.phase === 'done' && close, tpl.map((v) => v.toFixed(2)).join(' '));
  const custom = buildTemplates({ fist: tpl });
  check('an open hand recorded as freeze then freezes', classify(open, custom) === 'fist' && clashWith(tpl, 'fist', custom) === null);
  check('a freeze too close to thumbs up is refused', clashWith([1, 1, 1, 1, 0.9], 'fist', templates) === 'thumb');
  // A slow change of shape: one steady second of the old sign, then the new one.
  const late = new Recorder();
  const fist = features(posed(SHAPES.fist, false, 1, randomQuat(), 0));
  for (let t = 0; t < 12 && late.phase !== 'done'; t += 1 / 72) late.update((t < 1 ? open : fist).map((v) => clamp01(v + gauss() * 0.01)), 1 / 72);
  const lt = late.template;
  check('a sample that disagrees starts the sign over', late.phase === 'done' && lt.every((v, k) => Math.abs(v - fist[k]) < 0.05), lt.map((v) => v.toFixed(2)).join(' '));
}

// ── Aim ───────────────────────────────────────────────────────────────────
{
  const all = () => true;
  const a = pickSpot(SPOT.plinth.x + 0.8, SPOT.plinth.z, all, null);
  const b = pickSpot(SPOT.plinth.x + 1.5, SPOT.plinth.z, all, 'plinth');
  const c = pickSpot(8.0, 0.8, all, null);
  check('aim snaps to the nearest spot and sticks while wobbling', a === 'plinth' && b === 'plinth' && c === null, `${a} ${b} ${c}`);
}

// ── Level timing ──────────────────────────────────────────────────────────
for (const assist of [false, true]) {
  for (const spot of ['window', 'fusebox', 'painting'] as SpotId[]) {
    const sim = new Sim();
    sim.setAssist(assist);
    const s = sim.s;
    s.guards[0].mode = 'loop';
    s.rook.state = 'frozen';
    s.rook.x = SPOT[spot].x;
    s.rook.z = SPOT[spot].z;
    s.rook.at = spot;
    let spotted = false;
    let peak = 0;
    for (let i = 0; i < (2 * sim.loops[0].period) / T.step; i++) {
      sim.step();
      peak = Math.max(peak, s.rook.guard);
      if (sim.events.some((e) => e.type === 'spotted' && e.thief === 'rook')) spotted = true;
      sim.events.length = 0;
    }
    check(`${assist ? 'assist: ' : ''}a thief frozen at the ${spot} survives every lap`, !spotted && peak < 0.95, `peak meter ${peak.toFixed(2)}, lap ${sim.loops[0].period.toFixed(1)} s`);
  }
}
{
  // Footsteps just behind Bert make him stop and turn; the same partner frozen is silent.
  const behind = (state: 'moving' | 'frozen') => {
    const sim = new Sim();
    const s = sim.s;
    s.guards[0].mode = 'loop';
    sim.step();
    const b = s.guards[0];
    s.rook.state = state;
    s.rook.route = [];
    s.rook.x = b.x - Math.cos(b.heading) * 1.2;
    s.rook.z = b.z - Math.sin(b.heading) * 1.2;
    const away = b.heading;
    sim.events.length = 0;
    for (let i = 0; i < 0.5 / T.step; i++) sim.step();
    const heard = sim.events.some((e) => e.type === 'heard');
    const turned = Math.abs(Math.atan2(Math.sin(b.heading - away), Math.cos(b.heading - away)));
    return { heard, turned, still: !b.walking };
  };
  const walk = behind('moving');
  const freeze = behind('frozen');
  check('footsteps behind Bert make him stop and turn; freezing is silent', walk.heard && walk.still && walk.turned > 2 && !freeze.heard,
    `walking: heard ${walk.heard}, turned ${(walk.turned / DEG).toFixed(0)}°; frozen: heard ${freeze.heard}`);
}
{
  const sim = new Sim();
  sim.wakeEye(T.eyeWakePhase);
  const onRoute = (u: number) => sim.inEye(3.6 + 2.4 * u, 4.4 - 1.4 * u);
  const coversAtWake = onRoute(0.7);
  let away = 0;
  for (let i = 0; i < 6 / T.step; i++) {
    sim.step();
    if (sim.s.t > 0.8 && !onRoute(0.5) && !onRoute(0.7) && !onRoute(0.9)) away += T.step;
    if (sim.s.t > 0.8 && (onRoute(0.5) || onRoute(0.9))) break;
  }
  check('the Eye wakes on Lark’s route, then leaves a gap to cross', coversAtWake && away >= 1.8, `gap ${away.toFixed(1)} s`);
}

// ── Threats ───────────────────────────────────────────────────────────────
{
  // Crossing from the plinth to the pillar: some moments get Lark caught, others don't.
  let caught = 0;
  let clear = 0;
  for (let p = 0; p < 1; p += 0.02) {
    const sim = new Sim();
    const s = sim.s;
    s.guards[0].mode = 'loop';
    s.guards[0].phase = 0.2; // Bert far away, at the east corner
    s.lark.state = 'idle';
    s.lark.at = 'plinth';
    s.lark.x = SPOT.plinth.x;
    s.lark.z = SPOT.plinth.z;
    sim.wakeEye(p);
    sim.go('lark', 'pillar');
    let by = '';
    for (let i = 0; i < 4 / T.step && !by; i++) {
      sim.step();
      for (const e of sim.events) if (e.type === 'spotted') by = e.by;
      sim.events.length = 0;
    }
    if (by === 'eye') caught++;
    else if (!by) clear++;
  }
  check('crossing under the camera depends on timing', caught >= 5 && clear >= 15, `${caught} of 50 starts caught, ${clear} clear`);
}
{
  // Bert's torch reaches the fuse box as he arrives at north centre.
  const run = (working: boolean) => {
    const sim = new Sim();
    const s = sim.s;
    s.cameraOn = false;
    s.guards[0].mode = 'loop';
    s.guards[0].phase = sim.loops[0].joinPhase - 2.5 / sim.loops[0].period;
    s.rook.state = 'idle';
    s.rook.at = 'fusebox';
    s.rook.x = SPOT.fusebox.x;
    s.rook.z = SPOT.fusebox.z;
    if (working) {
      s.rook.state = 'working';
      s.rook.action = 'cut';
      s.progress.cut = -100;
    }
    for (let i = 0; i < 6 / T.step; i++) {
      sim.step();
      if (sim.events.some((e) => e.type === 'spotted')) return true;
      sim.events.length = 0;
    }
    return false;
  };
  check('working at the fuse box while the torch passes gets Rook spotted', run(true));
  check('freezing at the fuse box while the torch passes is safe', !run(false));
}

// ── The bot plays the whole heist ─────────────────────────────────────────
function runBot(opts: { assist?: boolean; careless?: boolean; maxS?: number; delay?: number; assistBlip?: boolean; job?: JobId; seed?: number } = {}) {
  const g = new Game({ ...DEFAULT_SETTINGS, assist: !!opts.assist }, opts.job ?? 'gallery', opts.seed ?? 1);
  const raised: HandInput = { tracked: true, inZone: true, pose: 'none', aim: null, palmUp: false, pinch: false };
  let next = 0;
  let beat = -1;
  let snap: State | null = null;
  let unsafeSnapshot = '';
  let rewindExact = true;
  const beatStarts: string[] = [];
  const queue: { at: number; h: HandId; c: Cmd; spot?: SpotId }[] = [];
  const maxFrames = (opts.maxS ?? 900) * 60;
  for (let frame = 0; frame < maxFrames && !g.ended; frame++) {
    const now = (frame * 1000) / 60;
    if (opts.assistBlip && (frame === 600 || frame === 660)) g.setAssist(frame === 600);
    g.hand('left', raised, now);
    g.hand('right', raised, now);
    if (g.beat !== beat) {
      beat = g.beat;
      beatStarts.push(`${beat}@${(now / 1000).toFixed(0)}s`);
    }
    // Every rewind point (a beat's start, or a Job 2 checkpoint) must be safe to stand still at.
    if (g.snapshotState !== snap) {
      snap = g.snapshotState;
      if (!idleSafe(g.sim, snap, 60)) unsafeSnapshot += ` beat ${beat}@${(now / 1000).toFixed(0)}s`;
    }
    // A slower player: each signal lands `delay` seconds after the decision.
    while (queue.length && queue[0].at <= now) {
      const q = queue.shift()!;
      g.command(q.h, q.c, q.spot);
    }
    const delayMs = (opts.delay ?? 0) * 1000;
    if (!g.blocked() && now >= next && !queue.length && botStep(g, !!opts.careless, (h, c, spot) => (delayMs ? queue.push({ at: now + delayMs, h, c, spot }) : g.command(h, c, spot)), opts.delay ?? 0)) next = now + 300;
    g.update(1 / 60, now);
    for (const e of g.takeEvents())
      if (e.type === 'rewind' && JSON.stringify(g.sim.s) !== JSON.stringify(g.snapshotState)) rewindExact = false;
  }
  return { g, beatStarts, unsafeSnapshot, rewindExact };
}

for (const assist of [false, true]) {
  const { g, beatStarts, unsafeSnapshot } = runBot({ assist });
  const label = assist ? 'assist: ' : '';
  check(`${label}the bot finishes the heist`, g.ended,
    `${g.stats.time.toFixed(0)} s, ${g.stats.rewinds} rewinds, ${g.stats.signals} signals, stamp ${g.stamp}; beats ${beatStarts.join(' ')}`);
  check(`${label}standing still after any rewind is safe for 60 s`, unsafeSnapshot === '', unsafeSnapshot || 'all beats');
}
// Slower hands land signals later; every beat must still start from a safe place.
for (const delay of [0.25, 0.45, 0.7]) {
  const { g, unsafeSnapshot } = runBot({ delay });
  check(`a player ${delay} s slower still wins, and every rewind starts safe`, g.ended && unsafeSnapshot === '',
    `${g.stats.time.toFixed(0)} s, ${g.stats.rewinds} rewinds${unsafeSnapshot ? `; unsafe:${unsafeSnapshot}` : ''}`);
}
{
  const a = runBot();
  const b = runBot();
  check('two identical runs give identical logs', a.g.log.join('\n') === b.g.log.join('\n'), `${a.g.log.length} lines`);
  const c = runBot({ careless: true, maxS: 300 });
  check('a careless player gets caught, and rewinds restore the beat exactly', c.g.stats.rewinds > 0 && c.rewindExact,
    `${c.g.stats.rewinds} rewinds, reached beat ${c.g.beat}`);
  // With hearing off the bot's clean run earns Ghost, so the blip has something to rule out.
  const hear = T.hear;
  T.hear = 0;
  const ghost = runBot();
  const d = runBot({ assistBlip: true });
  T.hear = hear;
  check('turning Assist on, even briefly, rules out a Ghost stamp', ghost.g.stamp === 'Ghost' && d.g.ended && d.g.stamp !== 'Ghost',
    `clean run ${ghost.g.stamp}, with a blip of Assist ${d.g.stamp}`);
}

// ── Job 2: Halloran's ───────────────────────────────────────────────────
/** A Job 2 sim with both guards parked facing a wall: no sight, no hearing. */
function quiet(seed = 1) {
  const sim = new Sim('halloran', seed);
  for (const b of sim.s.guards) Object.assign(b, { mode: 'wait', x: 17.5, z: 11.5, heading: 0 });
  return sim;
}
const place = (sim: Sim, id: 'lark' | 'rook', spot: SpotId) => {
  const sp = level('halloran').spot[spot];
  Object.assign(sim.s[id], { state: 'idle', x: sp.x, z: sp.z, at: spot, edge: null, route: [] });
};
const runFor = (sim: Sim, seconds: number) => {
  const seen: string[] = [];
  for (let i = 0; i < seconds / T.step; i++) {
    sim.step();
    for (const e of sim.events) if (e.type === 'spotted') seen.push(e.by);
    sim.events.length = 0;
  }
  return seen;
};
{
  // Walls: the store room's wall hides it from the corridor, except through its door.
  const sim = new Sim('halloran', 1);
  sim.s.lightsOn = false;
  Object.assign(sim.s.guards[0], { mode: 'loop', x: 5.0, z: 5.5, heading: -90 * DEG });
  const wall = !sim.sees(0, 5.0, 3.0);
  Object.assign(sim.s.guards[0], { x: 3.0 });
  const door = sim.sees(0, 3.0, 3.0);
  check('guards can’t see through walls, only through doorways', wall && door);
  // Lit rooms: in the lit corridor Bert sees 5 m along it; with the lights out, he doesn’t.
  Object.assign(sim.s.guards[0], { x: 2.0, z: 5.5, heading: 0 });
  sim.s.lightsOn = true;
  const lit = sim.sees(0, 7.0, 5.5);
  sim.s.lightsOn = false;
  check('the lights let guards see farther; cutting them shrinks the beam', lit && !sim.sees(0, 7.0, 5.5));
}
{
  // Lasers: walking through the laser door trips them, until the power is cut.
  const cross = (power: boolean) => {
    const sim = quiet();
    sim.s.lasersOn = power;
    sim.s.lightsOn = false;
    place(sim, 'lark', 'statue');
    sim.go('lark', 'keyA');
    return runFor(sim, 6);
  };
  const on = cross(true);
  const off = cross(false);
  check('crossing the lasers trips them; with the power cut it’s safe', on[0] === 'laser' && off.length === 0, `on: ${on[0] ?? 'nothing'}, off: ${off[0] ?? 'nothing'}`);
}
{
  // The vault sensor: moving while it looks gets caught, moving while it rests or freezing while it looks doesn't.
  const vault = (start: number, move: boolean) => {
    const sim = quiet();
    Object.assign(sim.s, { lasersOn: false, lightsOn: false, vaultOpen: true, t: start });
    place(sim, 'lark', 'boxes');
    if (move) sim.go('lark', 'vitrine');
    return runFor(sim, move ? 3.0 : T.sensorPeriod);
  };
  const armed = vault(T.sensorRestS + T.sensorWarnS - 0.5, true);
  const resting = vault(0, true);
  const frozen = vault(0, false);
  check('the vault sensor catches movement only while armed', armed[0] === 'sensor' && resting.length === 0 && frozen.length === 0,
    `moving as it arms: ${armed[0] ?? 'nothing'}, while resting: ${resting[0] ?? 'nothing'}, standing through a cycle: ${frozen[0] ?? 'nothing'}`);
}
{
  // A coin: Bert walks over to the bench, searches, and goes back to his round.
  const sim = new Sim('halloran', 1);
  sim.s.lightsOn = false;
  const loop = sim.loops[0];
  const pose = { x: 0, z: 0, heading: 0, walking: false, flicker: false };
  let phase = 0;
  for (let p = 0; p < 1; p += 0.0005) if (sampleLoop(loop, p, pose) && dist(pose.x, pose.z, 10.6, 5.5) < 0.05 && !pose.walking) phase = p;
  Object.assign(sim.s.guards[0], { mode: 'loop', phase });
  Object.assign(sim.s.guards[1], { mode: 'wait', x: 17.5, z: 11.5, heading: 0 });
  sim.step();
  place(sim, 'rook', 'cabinet');
  sim.s.rook.state = 'frozen';
  const tossed = sim.toss('rook', 'bench');
  let drew = -2;
  let closest = 99;
  let back = false;
  for (let i = 0; i < 25 / T.step; i++) {
    sim.step();
    for (const e of sim.events) if (e.type === 'coin') drew = e.guard;
    sim.events.length = 0;
    const b = sim.s.guards[0];
    if (b.inv) closest = Math.min(closest, dist(b.x, b.z, 5.6, 5.6));
    if (drew === 0 && closest < 1 && b.inv === 0 && b.phase !== phase) back = true;
  }
  check('a tossed coin draws the nearest guard over; he searches, then goes back to his round', tossed && drew === 0 && closest < 1 && back && sim.s.coins === T.coins - 1,
    `drew guard ${drew}, came within ${closest.toFixed(1)} m, back on his round: ${back}`);
}
{
  // Varied nights: the seed picks rounds and pauses; the same seed is the same night.
  const periods = [1, 2, 3, 4, 5].map((seed) => new Sim('halloran', seed).loops.map((l) => l.period.toFixed(2)).join('/'));
  const same = new Sim('halloran', 3).loops.map((l) => l.period.toFixed(2)).join('/') === periods[2];
  check('each night varies the guards’ rounds; the same night replays exactly', new Set(periods).size >= 4 && same, periods.join(' '));
}
for (const [seed, opts] of [[1, {}], [2, {}], [3, { delay: 0.45 }], [4, { assist: true }]] as [number, { delay?: number; assist?: boolean }][]) {
  const { g, unsafeSnapshot } = runBot({ job: 'halloran', seed, ...opts });
  const label = opts.delay ? `, ${opts.delay} s slower` : opts.assist ? ', with Assist' : '';
  check(`Job 2 (night ${seed}${label}): the bot gets the Heron out, and every checkpoint is safe to stand at`, g.ended && unsafeSnapshot === '',
    `${g.stats.time.toFixed(0)} s, ${g.stats.rewinds} rewinds, ${g.stats.signals} signals, stamp ${g.stamp}${unsafeSnapshot ? `; unsafe:${unsafeSnapshot}` : ''}`);
}
{
  const c = runBot({ job: 'halloran', seed: 1, careless: true, maxS: 200 });
  check('Job 2: a careless player gets caught, and rewinds restore the checkpoint exactly', c.g.stats.rewinds > 0 && c.rewindExact, `${c.g.stats.rewinds} rewinds`);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
