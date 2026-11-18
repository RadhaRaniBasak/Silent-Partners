import { T } from '../tuning';
import type { JobId, Level, SpotId } from '../level';
import { type Cmd, type Pose, PoseFilter } from './recognize';
import { type By, type SimEvent, Sim, type State, type ThiefId, settle } from './sim';

/**
 * The run: beats, prompts, hints, signals turned into orders, rewinds and the
 * end card. Pure logic; the headset layer feeds it hand data each frame and
 * draws what it reports.
 */

export type HandId = 'left' | 'right';

export interface Settings {
  oneHand: boolean;
  larkRight: boolean;
  assist: boolean;
  hints: boolean;
  tableY: number;
  tableZ: number;
  music: boolean;
}

export const DEFAULT_SETTINGS: Settings = { oneHand: false, larkRight: false, assist: false, hints: true, tableY: 0, tableZ: 0, music: true };

export interface HandInput {
  tracked: boolean;
  inZone: boolean;
  pose: Pose;
  aim: SpotId | null;
  palmUp: boolean;
  pinch: boolean;
}

export interface Prompt {
  text: string;
  hands: HandId[];
  glyph: Cmd | null;
  spots: SpotId[];
}

export type GameEvent =
  | { type: 'sim'; e: SimEvent }
  | { type: 'signal'; hand: HandId; cmd: Cmd; ok: boolean }
  | { type: 'route'; thief: ThiefId }
  | { type: 'no'; thief: ThiefId }
  | { type: 'beat'; beat: number }
  | { type: 'lit'; thief: ThiefId }
  | { type: 'rewind' }
  | { type: 'pause'; on: boolean }
  | { type: 'swap'; thief: ThiefId }
  | { type: 'assist' }
  | { type: 'checkpoint' }
  | { type: 'end' };

export type Stamp = 'Ghost' | 'Pro' | 'Messy';

interface HandState {
  tracked: boolean;
  inZone: boolean;
  palmUp: boolean;
  aim: SpotId | null;
  aimSince: number;
  sent: SpotId | null;
  /** The aiming sign that sent it (point or two). */
  sentBy: Pose;
  pinchSince: number;
  pinchDone: boolean;
}

const newHand = (): HandState => ({
  tracked: false,
  inZone: false,
  palmUp: false,
  aim: null,
  aimSince: 0,
  sent: null,
  sentBy: 'none',
  pinchSince: -1,
  pinchDone: false,
});

const FAIL_HINTS: Record<number, string> = {
  2: 'Wait for the red beam to pass, then point.',
  3: 'Freeze Rook while the torch passes.',
  4: 'Wait in cover until the torch passes.',
  5: 'Hop from cover to cover.',
};

/** Job 2's hints go by what caught you. */
const CAUGHT_HINTS: Record<string, string> = {
  laser: 'Cut the power before anyone crosses the lasers.',
  sensor: 'Freeze when the sensor blinks. Move while it rests.',
  guard: 'Wait in cover until the light passes.',
};

/** Read out during Job 2's recon, one at a time. */
const RECON_TIPS = [
  'Bert walks the corridor and looks into the back rooms.',
  'Marge has the saleroom. Lit rooms help them see.',
  'Lasers guard the vault keys. Their power is in the store room.',
  'A motion sensor guards the vault. It blinks, then looks.',
  'New sign: two fingers, aimed, tosses a coin. A guard goes to look.',
];

/** What a thumbs up does at each task, for the wrong partner. */
const WRONG: Record<string, string> = {
  cut: 'Rook handles the fuse box.',
  unlock: 'Lark unlocks the bracket.',
  power: 'Rook handles the wires.',
  lights: 'Rook handles the wires.',
  crack: 'Lark cracks the case.',
};

export class Game {
  readonly sim: Sim;
  readonly settings: Settings;
  beat = 0;
  sub = 0;
  beatT = 0;
  /** Seconds since the last useful signal in this step of the beat. */
  idleT = 0;
  paused = false;
  rewindT = 0;
  ended = false;
  prompt: Prompt = { text: '', hands: [], glyph: null, spots: [] };
  caption = '';
  captionT = 0;
  /** 0 none, 1 glyph brightens, 2 ghost hand demonstrates. */
  hintLevel = 0;
  offerAssist = false;
  beatRewinds = 0;
  stats = { time: 0, rewinds: 0, signals: 0 };
  stamp: Stamp = 'Messy';
  lit: Record<ThiefId, boolean> = { lark: false, rook: false };
  activeThief: ThiefId = 'lark';
  log: string[] = [];
  readonly filters: Record<HandId, PoseFilter> = { left: new PoseFilter(), right: new PoseFilter() };
  readonly hands: Record<HandId, HandState> = { left: newHand(), right: newHand() };
  private events: GameEvent[] = [];
  private snapshot: State;
  private acc = 0;
  private now = 0;
  private raisedT = 0;
  private pauseT = 0;
  private pauseLatched = false;
  private frozenT = 0;
  private offerT = 0;
  private thumbAt: Record<ThiefId, number> = { lark: -1e9, rook: -1e9 };
  private said = new Set<string>();
  private beatPrompt: Prompt = this.prompt;
  /** Assist was on at any point in this run: no Ghost stamp. */
  private assisted: boolean;
  /** What last caught the crew, for Job 2's hints. */
  private lastBy: By = '';
  private safeT = 0;
  private tip = -1;

  constructor(settings: Settings, job: JobId = 'gallery', seed = 1) {
    this.sim = new Sim(job, seed);
    this.settings = { ...settings };
    this.assisted = settings.assist;
    this.sim.setAssist(settings.assist);
    this.snapshot = this.sim.save();
    this.enter(0);
  }

  get level(): Level {
    return this.sim.level;
  }

  /** Job 2 onward: free play with recon, instead of Job 1's taught beats. */
  get open(): boolean {
    return this.sim.level.id !== 'gallery';
  }

  takeEvents(): GameEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  get snapshotState(): State {
    return this.snapshot;
  }

  /** Which thief a hand commands, or null if that thief isn't in play yet. */
  thiefFor(hand: HandId): ThiefId | null {
    if (this.settings.oneHand) return this.lit[this.activeThief] ? this.activeThief : null;
    const t: ThiefId = (hand === 'left') !== this.settings.larkRight ? 'lark' : 'rook';
    return this.lit[t] ? t : null;
  }

  /** Which thief a hand would command once lit; used for colour. */
  handThief(hand: HandId): ThiefId {
    if (this.settings.oneHand) return this.activeThief;
    return (hand === 'left') !== this.settings.larkRight ? 'lark' : 'rook';
  }

  handsOf(thief: ThiefId): HandId[] {
    if (this.settings.oneHand) return ['left', 'right'];
    return [(thief === 'lark') !== this.settings.larkRight ? 'left' : 'right'];
  }

  /** Spots a point can select right now. Teaching beats narrow the choice. */
  targetable = (spot: SpotId): boolean => {
    if (this.blocked() || this.beat < 2) return false;
    if (this.open) return this.sim.s.vaultOpen || (spot !== 'vitrine' && spot !== 'boxes');
    if (this.beat === 2) return this.sub === 0 ? spot === 'plinth' || spot === 'curtains' : spot !== 'fusebox' && spot !== 'window' && spot !== 'sofa' && spot !== 'painting';
    return true;
  };

  blocked() {
    return this.paused || this.rewindT > 0 || this.ended;
  }

  /** Per frame, per hand: the classified pose and aim, before update(). */
  hand(id: HandId, inp: HandInput, now: number) {
    this.now = now;
    const h = this.hands[id];
    const f = this.filters[id];
    h.tracked = inp.tracked;
    h.inZone = inp.tracked && inp.inZone;
    h.palmUp = inp.tracked && inp.palmUp && inp.pose === 'open';
    if (!h.inZone || this.blocked() || this.beat === 0) {
      f.reset();
      h.aim = null;
      h.sent = null;
      h.pinchSince = -1;
      return;
    }
    const fired = f.update(inp.pose, now);
    if (fired === 'fist' || fired === 'thumb') this.command(id, fired);
    // Point and two aim: they fire once held, on the spot the finger rests on.
    if (f.held === 'point' || f.held === 'two') {
      if (inp.aim !== h.aim) {
        h.aim = inp.aim;
        h.aimSince = now;
      }
      if (f.fired && h.aim && now - h.aimSince >= T.aimDwellMs && (h.aim !== h.sent || f.held !== h.sentBy)) {
        h.sent = h.aim;
        h.sentBy = f.held;
        this.command(id, f.held, h.aim);
      }
    } else {
      h.aim = null;
      h.sent = null;
    }
    if (this.settings.oneHand && inp.pinch) {
      if (h.pinchSince < 0) h.pinchSince = now;
      else if (!h.pinchDone && now - h.pinchSince >= T.pinchMs) {
        h.pinchDone = true;
        this.swap();
      }
    } else {
      h.pinchSince = -1;
      h.pinchDone = false;
    }
  }

  /** A confirmed signal. The bot in the checks calls this directly. */
  command(hand: HandId, cmd: Cmd, spot?: SpotId) {
    if (this.blocked()) return;
    if (this.offerAssist && cmd === 'thumb') return this.acceptAssist();
    // Recon: a thumbs up from either hand starts the job.
    if (this.open && this.beat === 1) {
      if (cmd !== 'thumb') return;
      this.stats.signals++;
      this.events.push({ type: 'signal', hand, cmd, ok: true });
      this.write(`signal ${hand} go in`);
      return this.enter(2);
    }
    const thief = this.thiefFor(hand);
    if (!thief) {
      if (this.beat >= 1) this.say(`${this.settings.oneHand ? 'Pinch to switch' : 'Rook isn’t here yet. Use your other hand'}.`, 3);
      return;
    }
    // Job 1 teaches one sign at a time.
    if (!this.open && this.beat === 1 && (cmd !== 'fist' || thief !== 'lark')) return;
    if (!this.open && this.beat === 2 && cmd === 'thumb') return;
    const sim = this.sim;
    let ok = false;
    if (cmd === 'fist') {
      if (this.settings.oneHand) {
        const a = sim.freeze('lark');
        const b = sim.freeze('rook');
        ok = a || b;
      } else ok = sim.freeze(thief);
    } else if (cmd === 'point' && spot) {
      ok = sim.go(thief, spot);
      if (ok) this.events.push({ type: 'route', thief: sim.s.carrying ? 'lark' : thief });
    } else if (cmd === 'thumb') ok = this.thumb(thief);
    else if (cmd === 'two' && spot) {
      ok = sim.toss(thief, spot);
      if (ok) this.say(`Coin away. ${sim.s.coins} left.`, 2);
      else if (this.open) this.say(sim.s.coins ? 'No clear throw from here.' : 'No coins left.', 3);
    }
    if (ok) {
      this.idleT = 0;
      this.hintLevel = 0;
    }
    this.stats.signals++;
    this.events.push({ type: 'signal', hand, cmd, ok });
    this.write(`signal ${hand} ${thief} ${cmd}${spot ? ` ${spot}` : ''} ${ok ? 'ok' : 'ignored'}`);
  }

  private liftWait = 0;

  private thumb(thief: ThiefId): boolean {
    const r = this.sim.act(thief);
    if (r === 'ok') return true;
    if (r === 'wrong') {
      const at = this.sim.s[thief].at;
      this.events.push({ type: 'no', thief });
      this.say(WRONG[(at && this.sim.taskAt(at)) || ''] ?? 'Not here.', 3);
      return false;
    }
    if (r !== 'pair') return false;
    this.thumbAt[thief] = this.now;
    const other: ThiefId = thief === 'lark' ? 'rook' : 'lark';
    if (!this.sim.canPair()) {
      this.say(this.open ? 'One at each key first.' : 'Get both to the painting first.', 3);
      return false;
    }
    if (this.settings.oneHand || this.now - this.thumbAt[other] <= T.liftWindowMs) {
      this.liftWait = 0;
      return this.sim.startPair();
    }
    // Half of a two-thumb lift: only nag if the other thumb doesn't follow.
    this.liftWait = this.now + T.liftWindowMs;
    return true;
  }

  private swap() {
    const next: ThiefId = this.activeThief === 'lark' ? 'rook' : 'lark';
    if (!this.lit[next]) return;
    this.activeThief = next;
    this.events.push({ type: 'swap', thief: next });
    this.write(`swap ${next}`);
  }

  setPaused(on: boolean) {
    if (this.ended || this.beat === 0 || on === this.paused) return;
    this.paused = on;
    this.filters.left.reset();
    this.filters.right.reset();
    this.events.push({ type: 'pause', on });
    this.write(on ? 'pause' : 'resume');
  }

  setAssist(on: boolean) {
    this.settings.assist = on;
    if (on) this.assisted = true;
    this.sim.setAssist(on);
    this.write(`assist ${on}`);
  }

  private acceptAssist() {
    this.offerAssist = false;
    this.setAssist(true);
    this.events.push({ type: 'assist' });
    this.say('Bert slows down.', 3);
  }

  say(text: string, seconds = 4) {
    this.caption = text;
    this.captionT = seconds;
  }

  private sayOnce(key: string, text: string, seconds = 4) {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.say(text, seconds);
  }

  private setPrompt(text: string, hands: HandId[], glyph: Cmd | null, spots: SpotId[]) {
    if (text !== this.prompt.text) this.idleT = 0;
    this.prompt = { text, hands, glyph, spots };
  }

  /** The prompt as shown: one-hand mode first asks for the right thief. */
  get shownPrompt(): Prompt {
    if (this.offerAssist) return { text: 'Slower guard? Thumbs up.', hands: ['left', 'right'], glyph: 'thumb', spots: [] };
    const p = this.prompt;
    if (this.settings.oneHand && p.glyph && p.glyph !== 'fist' && this.lit.lark && this.lit.rook) {
      const want = /Rook/.test(p.text) ? 'rook' : /Lark/.test(p.text) ? 'lark' : null;
      if (want && want !== this.activeThief) return { text: `Pinch to switch to ${want === 'rook' ? 'Rook' : 'Lark'}.`, hands: ['left', 'right'], glyph: null, spots: [] };
    }
    return p;
  }

  update(dt: number, now: number) {
    this.now = now;
    dt = Math.min(dt, 0.1);
    if (this.captionT > 0) {
      this.captionT -= dt;
      if (this.captionT <= 0) this.caption = '';
    }
    this.updatePause(dt);
    if (this.paused || this.ended) return;
    if (this.rewindT > 0) {
      this.rewindT -= dt;
      if (this.rewindT <= 0) this.restore();
      return;
    }
    this.beatT += dt;
    this.idleT += dt;
    if (this.beat >= 1) this.stats.time += dt;
    if (this.offerAssist && (this.offerT -= dt) <= 0) this.offerAssist = false;
    this.acc += dt;
    while (this.acc >= T.step) {
      this.acc -= T.step;
      this.sim.step(T.step);
      if (this.drainSim()) {
        this.acc = 0;
        return;
      }
    }
    this.updateBeat(dt);
    const hints = this.settings.hints && this.prompt.glyph !== null;
    this.hintLevel = hints ? (this.idleT >= T.hintGhostS ? 2 : this.idleT >= T.hintBrightenS ? 1 : 0) : 0;
  }

  private drainSim(): boolean {
    const events = this.sim.events;
    this.sim.events = [];
    for (const e of events) {
      this.events.push({ type: 'sim', e });
      if (e.type === 'heard') this.say(`${this.level.job.guards[e.guard].name} heard footsteps. Freeze!`, 3);
      if (e.type === 'coin' && e.guard >= 0) this.say(`${this.level.job.guards[e.guard].name} goes to look.`, 3);
      if (e.type === 'spotted') {
        this.lastBy = e.by;
        this.rewindT = T.rewindS;
        this.filters.left.reset();
        this.filters.right.reset();
        this.write(`spotted ${e.thief} by ${e.by}`);
        return true;
      }
    }
    return false;
  }

  private restore() {
    this.sim.load(this.snapshot);
    this.sim.events = [];
    this.sub = 0;
    this.frozenT = 0;
    this.prompt = this.beatPrompt;
    this.beatRewinds++;
    this.stats.rewinds++;
    this.acc = 0;
    this.idleT = 0;
    this.events.push({ type: 'rewind' });
    this.write(`rewind ${this.beat} (${this.beatRewinds})`);
    const hint = this.open ? CAUGHT_HINTS[this.lastBy === 'laser' || this.lastBy === 'sensor' ? this.lastBy : 'guard'] : FAIL_HINTS[this.beat];
    if (this.beatRewinds === T.failHintAfter && this.settings.hints && hint) this.say(hint, 6);
    if (this.beatRewinds >= T.assistOfferAfter && !this.settings.assist && !this.offerAssist) {
      this.offerAssist = true;
      this.offerT = 10;
    }
  }

  private updatePause(dt: number) {
    const L = this.hands.left;
    const R = this.hands.right;
    const up = this.settings.oneHand ? L.palmUp || R.palmUp : L.palmUp && R.palmUp;
    if (up && this.beat > 0 && !this.ended) {
      this.pauseT += dt;
      if (this.pauseT * 1000 >= T.pauseMs && !this.pauseLatched) {
        this.pauseLatched = true;
        this.setPaused(!this.paused);
      }
    } else {
      this.pauseT = 0;
      this.pauseLatched = false;
    }
  }

  private enter(beat: number) {
    this.beat = beat;
    this.sub = 0;
    this.beatT = 0;
    this.idleT = 0;
    this.beatRewinds = 0;
    this.offerAssist = false;
    const sim = this.sim;
    const lark = this.handsOf('lark');
    const rook = this.handsOf('rook');
    if (this.open && beat === 1) this.setPrompt('Plan it. Thumbs up when you’re ready.', ['left', 'right'], 'thumb', []);
    else if (this.open && beat === 2) {
      for (const t of ['lark', 'rook'] as ThiefId[]) {
        this.lit[t] = true;
        this.events.push({ type: 'lit', thief: t });
        sim.climbIn(t);
      }
      this.say('In through the dock.', 3);
      this.setPrompt('', [], null, []);
    } else switch (beat) {
      case 0:
        this.setPrompt('', [], null, []);
        break;
      case 1:
        this.lit.lark = true;
        this.events.push({ type: 'lit', thief: 'lark' });
        sim.startCreep();
        sim.s.invulnerable = true;
        this.setPrompt('Make a fist to freeze Lark.', lark, 'fist', []);
        break;
      case 2:
        sim.s.invulnerable = false;
        this.setPrompt('Point to send Lark.', lark, 'point', ['plinth']);
        break;
      case 3:
        this.lit.rook = true;
        this.events.push({ type: 'lit', thief: 'rook' });
        sim.climbIn('rook');
        this.say(this.settings.oneHand ? 'Rook is in. Pinch to switch.' : 'Your other hand is Rook.', 4);
        this.setPrompt('', rook, null, []);
        break;
      case 4:
      case 5:
        break;
    }
    this.snapshot = settle(sim.save());
    this.beatPrompt = this.prompt;
    this.events.push({ type: 'beat', beat });
    this.write(`beat ${beat}`);
  }

  private updateBeat(dt: number) {
    const s = this.sim.s;
    const lark = this.handsOf('lark');
    const rook = this.handsOf('rook');
    const both: HandId[] = this.settings.oneHand ? ['left', 'right'] : [...lark, ...rook];
    if (this.open && this.beat > 0) return this.updateOpen(dt, lark, rook, both);
    switch (this.beat) {
      case 0: {
        const L = this.hands.left;
        const R = this.hands.right;
        const up = this.settings.oneHand ? L.inZone || R.inZone : L.inZone && R.inZone;
        this.raisedT = up ? this.raisedT + dt : 0;
        if (this.beatT >= T.scanS && !this.prompt.text) this.setPrompt('Raise your hands.', [], null, []);
        if (this.beatT >= T.scanS && this.raisedT >= 1) this.enter(1);
        break;
      }
      case 1:
        if (s.lark.state === 'frozen') {
          this.frozenT += dt;
          this.sim.bertLook();
          if (this.sub === 0 && this.frozenT > 1.2) {
            this.sub = 1;
            this.say('Still and in cover, Lark can’t be seen.', 5);
            this.setPrompt('', [], null, []);
          }
          if (this.frozenT >= 2.5 && (s.guards[0].mode === 'exit' || s.guards[0].mode === 'loop')) this.enter(2);
        }
        break;
      case 2:
        if (this.sub === 0 && s.lark.at === 'plinth') {
          this.sub = 1;
          this.sim.wakeEye(T.eyeWakePhase);
          this.say('The camera only sees movement.', 5);
          this.setPrompt('Go when it looks away.', lark, 'point', ['pillar']);
        }
        if (this.sub === 1 && s.lark.at === 'pillar') this.enter(3);
        break;
      case 3:
        if (this.sub === 0 && s.rook.state !== 'climbing' && s.rook.state !== 'outside') {
          this.sub = 1;
          this.setPrompt('Point to send Rook.', rook, 'point', ['fusebox']);
        }
        if (this.sub === 1 && s.rook.at === 'fusebox') {
          this.sub = 2;
          this.setPrompt('Thumbs up: Rook cuts the camera.', rook, 'thumb', ['fusebox']);
        }
        if (s.rook.state === 'working' && this.sim.inTorch(s.rook.x, s.rook.z, 1.5, 30))
          this.sayOnce('torch', 'Torch coming! A fist pauses the work.', 4);
        if (!s.cameraOn) {
          this.say('The Eye is out.', 3);
          this.enter(4);
        }
        break;
      case 4:
        if (!s.bracketOpen && s.lark.at === 'painting' && s.lark.state !== 'working')
          this.setPrompt('Thumbs up: Lark unlocks the bracket.', lark, 'thumb', ['painting']);
        else if (s.bracketOpen && s.lark.at === 'painting' && s.rook.at === 'painting')
          this.setPrompt(this.settings.oneHand ? 'Thumbs up to lift it.' : 'It takes two. Both thumbs up.', both, 'thumb', ['painting']);
        else if (s.lark.state !== 'working') this.setPrompt('Get both to the painting.', both, 'point', ['painting']);
        if (this.liftWait && this.now > this.liftWait) {
          this.liftWait = 0;
          this.say('Both thumbs, together.', 3);
        }
        if (s.carrying) {
          this.setPrompt('Carry it out. Either hand steers.', both, 'point', ['window']);
          this.enter(5);
        }
        break;
      case 5:
        if (s.escaped) this.finish();
        break;
    }
  }

  /** Job 2: recon, then the next thing to do, and a checkpoint at every safe moment. */
  private updateOpen(dt: number, lark: HandId[], rook: HandId[], both: HandId[]) {
    const sim = this.sim;
    const s = sim.s;
    if (this.beat === 1) {
      const tip = Math.floor(this.beatT / 6) % RECON_TIPS.length;
      if (tip !== this.tip) {
        this.tip = tip;
        this.say(RECON_TIPS[tip], 6);
      }
      return;
    }
    if (s.escaped) return this.finish();
    const still = (th: typeof s.lark) => th.state === 'idle' || th.state === 'frozen';
    const busy = s.lark.state === 'working' || s.rook.state === 'working';
    for (const th of [s.lark, s.rook])
      if (th.state === 'working' && sim.inTorch(th.x, th.z, 1.5, 30)) this.sayOnce('torch', 'Light coming! A fist pauses the work.', 4);
    if (s.lark.state === 'working' && sim.sensor() === 'warn') this.sayOnce('sensor', 'The sensor blinks before it looks. Freeze!', 4);
    const task = (spot: SpotId, who: ThiefId, hands: HandId[], go: string, act: string) => {
      const th = s[who];
      if (th.at === spot && still(th)) this.setPrompt(act, hands, 'thumb', [spot]);
      else if (th.state === 'working') this.setPrompt('', [], null, []);
      else this.setPrompt(go, hands, 'point', [spot]);
    };
    // The next thing to do. The lights are advice, not a lock: partners already at the keys get the keys.
    const atKeys = !s.vaultOpen && sim.canPair();
    if (s.lasersOn) task('panel', 'rook', rook, 'Rook: the power panel, in the store room.', 'Thumbs up: Rook cuts the lasers.');
    else if (atKeys) this.setPrompt(this.settings.oneHand ? 'Thumbs up to turn both keys.' : 'Both thumbs up, together.', both, 'thumb', ['keyA', 'keyB']);
    else if (s.lightsOn && !s.vaultOpen) task('breaker', 'rook', rook, 'Rook: the breaker, in the office.', 'Thumbs up: Rook kills the lights.');
    else if (!s.vaultOpen) {
      if (!busy) this.setPrompt('Both to the vault keys, one each.', both, 'point', ['keyA', 'keyB']);
    } else if (!s.loot) task('vitrine', 'lark', lark, 'Lark: the Heron. Move while the sensor rests.', 'Thumbs up: Lark cracks the case.');
    else this.setPrompt('Out through the dock, both of you.', both, 'point', ['dock']);
    // One hand: once a partner is out, the hand passes to the one still inside.
    const other: ThiefId = this.activeThief === 'lark' ? 'rook' : 'lark';
    if (this.settings.oneHand && s[this.activeThief].state === 'outside' && s[other].state !== 'outside') {
      this.activeThief = other;
      this.events.push({ type: 'swap', thief: other });
    }
    if (this.liftWait && this.now > this.liftWait) {
      this.liftWait = 0;
      this.say('Both thumbs, together.', 3);
    }
    // Checkpoint: both still in cover (or out) for a moment, nobody looking, something new.
    const hidden = (th: typeof s.lark) => th.state === 'outside' || (still(th) && !!th.at && this.level.spot[th.at].cover);
    const calm = s.guards.every((b) => !b.suspect && b.listen <= 0 && b.inv === 0) && !s.coin;
    const quiet = s.lark.eye + s.lark.guard + s.rook.eye + s.rook.guard < 0.02;
    this.safeT = hidden(s.lark) && hidden(s.rook) && calm && quiet ? this.safeT + dt : 0;
    const key = (x: State) => [x.lark.at, x.rook.at, x.lark.state === 'outside', x.rook.state === 'outside', x.lasersOn, x.lightsOn, x.vaultOpen, x.loot].join();
    if (this.safeT >= T.checkpointS && key(s) !== key(this.snapshot)) {
      this.snapshot = settle(sim.save());
      this.beatRewinds = 0;
      this.events.push({ type: 'checkpoint' });
      this.write('checkpoint');
    }
  }

  private finish() {
    this.ended = true;
    this.beat = this.open ? 3 : 6;
    this.setPrompt('', [], null, []);
    const s = this.sim.s;
    const r = this.stats.rewinds;
    this.stamp = r === 0 && s.maxMeter <= 0.5 ? 'Ghost' : r <= 2 ? 'Pro' : 'Messy';
    if (this.assisted && this.stamp === 'Ghost') this.stamp = 'Pro';
    this.events.push({ type: 'end' });
    this.write(`end ${this.stamp} time ${this.stats.time.toFixed(1)} rewinds ${r} signals ${this.stats.signals}`);
  }

  private write(line: string) {
    this.log.push(`${(this.now / 1000).toFixed(2)} ${line}`);
  }
}
