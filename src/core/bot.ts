import { T } from '../tuning';
import { type SpotId, dist } from '../level';
import type { Cmd } from './recognize';
import { Sim, type State, type ThiefId } from './sim';
import type { Game, HandId } from './game';

/**
 * A player that never gets caught: before each move it plays the move out
 * on a scratch copy of the sim and only goes if nobody is spotted. Used by
 * the checks to prove each heist can be beaten, and by the cinema mode to
 * stage the trailer. `issue` receives each signal it decides to give.
 */
export type Issue = (hand: HandId, cmd: Cmd, spot?: SpotId) => void;

const scratch = new Sim();
/** Job 2: also refuse plans that pass footsteps within a step of a guard's hearing. */
let strict = false;

/**
 * Footsteps just outside a guard's hearing. Hearing is a knife edge (a guard
 * who hears turns, walks over and often sees), and a real signal lands a frame
 * early or late, so the bot keeps a margin.
 */
function closeCall(sim: Sim): boolean {
  const s = sim.s;
  const range = (sim.assist ? T.hearAssist : T.hear) + 0.6;
  for (const b of s.guards) {
    if (b.mode !== 'loop' || b.listen > 0 || b.inv || b.suspect || b.deaf > 0) continue;
    for (const th of [s.lark, s.rook])
      if (th.state === 'moving' && sim.present(th) && dist(th.x, th.z, b.x, b.z) < range && sim.clear(b.x, b.z, th.x, th.z)) return true;
  }
  return false;
}

/** Runs the scratch sim for `steps` steps; true if nobody was spotted. */
function clean(steps: number): boolean {
  for (let i = 0; i < steps; i++) {
    scratch.step();
    if (scratch.events.some((e) => e.type === 'spotted') || (strict && closeCall(scratch))) return false;
    scratch.events.length = 0;
  }
  return true;
}

/**
 * Plays `act` out on a scratch sim: true if nobody is spotted within
 * `horizon` seconds. `delay` is how long the signal takes to land (a real
 * hand needs a moment to form it); the world keeps moving meanwhile.
 */
export function safe(g: Game, act: (s: Sim) => unknown, horizon: number, delay = 0): boolean {
  scratch.mirror(g.sim);
  strict = g.open;
  scratch.load(g.sim.s);
  scratch.events = [];
  const wait = Math.round(delay / T.step);
  for (let i = 0; i < wait; i++) {
    scratch.step();
    if (scratch.events.some((e) => e.type === 'spotted')) return false;
    scratch.events.length = 0;
  }
  act(scratch);
  return clean(Math.ceil(horizon / T.step));
}

export function idleSafe(sim: Sim, state: State, seconds: number): boolean {
  scratch.mirror(sim);
  strict = false;
  scratch.load(state);
  scratch.events = [];
  return clean(Math.ceil(seconds / T.step));
}

type Ok = (act: (s: Sim) => unknown, horizon: number) => boolean;

function travel(g: Game, id: ThiefId, spot: SpotId) {
  const s = g.sim.s;
  const th = s.carrying ? s.lark : s[id];
  const r = g.level.planRoute(th.x, th.z, th.edge, th.at, spot);
  return g.level.routeLen(th.x, th.z, r) / (s.carrying ? T.carrySpeed : T.thiefSpeed);
}

/** Toward the target: straight there if that's safe, else the nearest safe cover on the way. */
function goTo(g: Game, id: ThiefId, target: SpotId, ok: Ok, issue: Issue): boolean {
  const s = g.sim.s;
  const L = g.level;
  const th = s.carrying ? s.lark : s[id];
  if (th.state !== 'idle' && th.state !== 'frozen') return false;
  if (th.at === target) return false;
  const here = th.at;
  const cands = [target, ...L.spots.filter((sp) => sp.cover && sp.id !== here).map((sp) => sp.id)]
    .filter((c) => c === target || !here || L.pathLen(c, target) < L.pathLen(here, target))
    .filter((c) => g.targetable(c))
    .sort((a, b) => L.pathLen(a, target) - L.pathLen(b, target));
  for (const c of cands)
    if (ok((x) => x.go(id, c), travel(g, id, c) + 3)) {
      issue(g.handsOf(id)[0], 'point', c);
      return true;
    }
  return false;
}

/** Back into the nearest cover that's safe to reach. */
function retreat(g: Game, id: ThiefId, ok: Ok, issue: Issue): boolean {
  const L = g.level;
  const th = g.sim.s[id];
  const from = th.at;
  if (!from) return false;
  const cands = L.spots.filter((sp) => sp.cover && g.targetable(sp.id)).sort((a, b) => L.pathLen(from, a.id) - L.pathLen(from, b.id));
  for (const c of cands)
    if (ok((x) => x.go(id, c.id), travel(g, id, c.id) + 3)) {
      issue(g.handsOf(id)[0], 'point', c.id);
      return true;
    }
  return false;
}

/** Get to a task's spot, then do it when it's safe to start. */
function work(g: Game, id: ThiefId, spot: SpotId, horizon: number, ok: Ok, issue: Issue): boolean {
  const th = g.sim.s[id];
  if (th.at !== spot) return goTo(g, id, spot, ok, issue);
  if (th.state !== 'working' && ok((x) => x.act(id), horizon)) {
    issue(g.handsOf(id)[0], 'thumb');
    return true;
  }
  return false;
}

export function botStep(g: Game, careless: boolean, issue: Issue, delay = 0): boolean {
  const s = g.sim.s;
  // With a reaction delay, also allow for a slightly slower hand.
  const ok: Ok = (act, h) => careless || (safe(g, act, h, delay) && (!delay || safe(g, act, h, delay + 0.1)));
  const hand = (id: ThiefId): HandId => g.handsOf(id)[0];
  if (!careless)
    for (const id of ['lark', 'rook'] as ThiefId[]) {
      const th = s.carrying ? s.lark : s[id];
      if ((th.state === 'moving' || th.state === 'working') && th.creep === 0 && !safe(g, () => {}, 1.2 + delay)) {
        issue(hand(id), 'fist');
        return true;
      }
      if (s.carrying) break;
    }
  if (g.open) return botOpen(g, careless, issue, delay, ok);
  switch (g.beat) {
    case 1:
      if (s.lark.state !== 'frozen' && g.beatT > 1.5) {
        issue(hand('lark'), 'fist');
        return true;
      }
      return false;
    case 2:
      return goTo(g, 'lark', g.sub === 0 ? 'plinth' : 'pillar', ok, issue);
    case 3:
      if (g.sub === 0) return false;
      if (s.rook.at !== 'fusebox') return goTo(g, 'rook', 'fusebox', ok, issue);
      if (s.rook.state !== 'working' && ok((x) => x.act('rook'), T.cutS - s.progress.cut + 3)) {
        issue(hand('rook'), 'thumb');
        return true;
      }
      return false;
    case 4:
      if (s.lark.at !== 'painting' && goTo(g, 'lark', 'painting', ok, issue)) return true;
      if (s.rook.at !== 'painting' && goTo(g, 'rook', 'painting', ok, issue)) return true;
      if (!s.bracketOpen && s.lark.at === 'painting' && s.lark.state !== 'working' && ok((x) => x.act('lark'), T.unlockS - s.progress.unlock + 3)) {
        issue(hand('lark'), 'thumb');
        return true;
      }
      if (s.bracketOpen && g.sim.canPair() && s.lark.state !== 'working' && ok((x) => x.startPair(), T.liftS - s.progress.lift + 3)) {
        issue(hand('lark'), 'thumb');
        issue(hand('rook'), 'thumb');
        return true;
      }
      return false;
    case 5:
      return goTo(g, 'lark', 'window', ok, issue);
  }
  return false;
}

/** Job 2: lasers, lights, both keys, the case, then out; stepping back into cover when a light comes. */
function botOpen(g: Game, careless: boolean, issue: Issue, delay: number, ok: Ok): boolean {
  const s = g.sim.s;
  const L = g.level;
  const hand = (id: ThiefId): HandId => g.handsOf(id)[0];
  if (g.beat === 1) {
    // Study the rounds for a moment, as a player would.
    if (g.beatT < 6) return false;
    issue(hand('lark'), 'thumb');
    return true;
  }
  if (g.beat !== 2) return false;
  if (!careless)
    for (const id of ['lark', 'rook'] as ThiefId[]) {
      const th = s[id];
      if ((th.state === 'idle' || th.state === 'frozen') && th.at && !L.spot[th.at].cover && !safe(g, () => {}, 3 + delay) && retreat(g, id, ok, issue))
        return true;
    }
  if (s.lasersOn) return work(g, 'rook', 'panel', T.powerS - s.progress.power + 3, ok, issue);
  if (s.lightsOn) return work(g, 'rook', 'breaker', T.lightsS - s.progress.lights + 3, ok, issue);
  if (!s.vaultOpen) {
    if (s.lark.at !== 'keyA' && goTo(g, 'lark', 'keyA', ok, issue)) return true;
    if (s.rook.at !== 'keyB' && goTo(g, 'rook', 'keyB', ok, issue)) return true;
    if (g.sim.canPair() && s.lark.state !== 'working' && ok((x) => x.startPair(), T.keysS - s.progress.keys + 3)) {
      issue(hand('lark'), 'thumb');
      issue(hand('rook'), 'thumb');
      return true;
    }
    return false;
  }
  // The sensor cycles faster than the case cracks: start when it rests, freeze when it blinks.
  if (!s.loot) return work(g, 'lark', 'vitrine', Math.min(T.crackS - s.progress.crack + 3, 2), ok, issue);
  for (const id of ['lark', 'rook'] as ThiefId[]) if (s[id].state !== 'outside' && goTo(g, id, 'dock', ok, issue)) return true;
  return false;
}
