import { Quaternion, Vector3, VisibilityState, createSystem } from '@iwsdk/core';
import { DEG, T } from '../tuning';
import type { JobId } from '../level';
import { DEFAULT_SETTINGS, Game, type HandId, type HandInput, type Settings } from '../core/game';
import {
  CMDS,
  type Cmd,
  JOINT_NAMES,
  type Pose,
  Recorder,
  type Template,
  buildTemplates,
  clashWith,
  classify,
  features,
  palmUp,
} from '../core/recognize';
import { store } from '../store';
import { sound } from './audio';
import { type Button, TouchPanel } from './panels';
import { Cinema, type Titles, drawTitles, renderScore } from './cinema';
import { type HandFrame, View, fromModel } from './view';

const DEBUG = new URLSearchParams(location.search).has('debug');
/** ?cinema: the bot plays while a headless browser films it (see scripts/film.mjs). */
export const CINEMA = new URLSearchParams(location.search).has('cinema');
/** ?autoplay: the same bot plays live in the headset or emulator, for recording a demo. */
const AUTOPLAY = new URLSearchParams(location.search).has('autoplay');
const HANDS: HandId[] = ['left', 'right'];
const NAMES: Record<Cmd, string> = { fist: 'freeze', point: 'go', thumb: 'do-it', two: 'coin' };
const POSE_NAMES: Record<Pose, string> = { fist: 'freeze', point: 'go', thumb: 'do it', two: 'coin', open: 'open hand', none: 'nothing yet' };
/** What each finished task looks like in the van's log. */
const DONE_LOG: Record<string, string> = {
  cut: 'FUSE CUT. EYE DARK.',
  unlock: 'BRACKET OPEN.',
  lift: 'PAINTING LIFTED.',
  power: 'POWER CUT. LASERS DOWN.',
  lights: 'LIGHTS OUT.',
  keys: 'BOTH KEYS. VAULT OPEN.',
  crack: 'CASE OPEN. HERON TAKEN.',
};
const BY_LOG: Record<string, string> = { eye: 'THE EYE', sensor: 'THE SENSOR', laser: 'THE LASERS' };

/** Which job the next headset session starts with, and whether in mixed reality; the landing page sets both. */
export const launch: { job: JobId; mixed: boolean } = { job: 'gallery', mixed: false };
/** A new night for every run of a varied job. */
const newSeed = () => 1 + Math.floor(Math.random() * 1e9);

const newFrame = (): HandFrame => ({
  tracked: false,
  joints: new Float32Array(75),
  inZone: false,
  nearEdge: false,
  aimHit: null,
  aimSpot: null,
  palm: new Vector3(),
});

interface RecordFlow {
  idx: number;
  rec: Recorder;
  got: Partial<Record<Cmd, number[]>>;
  msg: string;
}

/**
 * The headset layer. Each frame: read both hands' joints from WebXR, turn
 * them into poses, a command zone and an aim, run the game, then draw it and
 * play its sounds. Panels on the right of the table handle settings.
 */
export class GameSystem extends createSystem({}) {
  game!: Game;
  private view!: View;
  private dock!: TouchPanel;
  private settingsPanel!: TouchPanel;
  /** Every touch panel, in the order fingertips are tested. */
  private panels: TouchPanel[] = [];
  private endPanel!: TouchPanel;
  private recordPanel!: TouchPanel;
  private settings: Settings = store.settings();
  private templates: Template[] = buildTemplates(store.templates());
  private readonly frames: Record<HandId, HandFrame> = { left: newFrame(), right: newFrame() };
  private readonly mats = new Float32Array(25 * 16);
  private readonly spaces = new WeakMap<XRInputSource, XRSpace[]>();
  private readonly smooth: Record<HandId, { x: number; z: number; ok: boolean }> = {
    left: { x: 0, z: 0, ok: false },
    right: { x: 0, z: 0, ok: false },
  };
  private readonly f = [0, 0, 0, 0, 0];
  private readonly head = new Vector3();
  private readonly headQ = new Quaternion();
  private readonly placeHead = new Vector3(0, 1.2, 0);
  private readonly placeQ = new Quaternion();
  private readonly v = new Vector3();
  private readonly w = new Vector3();
  private readonly u = new Vector3();
  private readonly invHead = new Quaternion();
  private readonly aimVec: Record<HandId, Vector3> = { left: new Vector3(), right: new Vector3() };
  private placed = false;
  private inXR = false;
  private controllers = false;
  private noHandsT = 0;
  private settingsOpen = false;
  private pausedBySettings = false;
  private previewAcc = 0;
  /** Seconds left before Recentre re-places the table, so the player can look ahead first. */
  private recentreT = 0;
  private record: RecordFlow | null = null;
  private stepT = 0;
  private workT = 0;
  private wasLifting = false;
  private lastSensor = '';
  private blurred = false;
  private demo!: Game;
  private cinema: Cinema | null = null;
  private mark: HTMLImageElement | null = null;
  private frameCanvas: HTMLCanvasElement | null = null;
  private filmT = 0;
  private endAt = 0;
  private endStamped = false;
  private debugT = 0;
  private fps = 0;
  private readonly recording: (number[] | null)[][] = [];
  private recT = 0;
  private logged = 0;
  private lastPose: Record<HandId, string> = { left: '', right: '' };

  init() {
    const xr = this.input.xr;
    for (const h of HANDS) {
      xr.multiPointers[h].toggleSubPointer('ray', false);
      xr.visualAdapters.hand[h].toggleVisual(false);
    }
    this.view = new View();
    this.world.createTransformEntity(this.view.root, { persistent: true });

    this.dock = new TouchPanel(0.15, 0.06, 2, 0.005);
    this.settingsPanel = new TouchPanel(0.39, 0.34, 3);
    this.endPanel = new TouchPanel(0.46, 0.29, 2);
    this.recordPanel = new TouchPanel(0.39, 0.18, 2);
    this.panels = [this.dock, this.settingsPanel, this.endPanel, this.recordPanel];
    this.dock.plane.mesh.position.set(0.36, 0.035, 0.2);
    this.dock.plane.mesh.rotation.set(-0.7, -0.45, 0, 'YXZ');
    for (const p of [this.settingsPanel, this.recordPanel]) {
      p.plane.mesh.position.set(0.4, 0.2, 0.14);
      p.plane.mesh.rotation.set(-0.12, -0.78, 0, 'YXZ');
    }
    // The end card is the finale: centred, above the prize, within reach.
    this.endPanel.plane.mesh.position.set(0, 0.3, 0.08);
    this.endPanel.plane.mesh.rotation.set(-0.1, 0, 0);
    this.view.anchor.add(this.dock.plane.mesh, this.settingsPanel.plane.mesh, this.endPanel.plane.mesh, this.recordPanel.plane.mesh);

    this.game = new Game(this.settings);
    this.demo = new Game(DEFAULT_SETTINGS);
    this.demo.sim.s.guards[0].mode = 'loop';
    this.demo.beatT = T.scanS;
    this.view.place(this.placeHead, this.placeQ, 0, 0);

    if (import.meta.env.DEV) (window as any).__sp = this;
    if (CINEMA) {
      this.cinema = new Cinema();
      (window as any).__cinema = this.cinema;
      (window as any).__score = renderScore;
      this.mark = new Image();
      this.mark.src = './mark.svg';
      (window as any).__shoot = (cam: Cinema['cam'], steps: number, titles: Titles, type = 'image/jpeg') => this.shoot(cam, steps, titles, type);
      this.game = this.cinema.game;
    }
    const xm = this.world.renderer.xr;
    const onEnd = () => this.onSessionEnd();
    xm.addEventListener('sessionend', onEnd);
    this.cleanupFuncs.push(() => xm.removeEventListener('sessionend', onEnd));
  }

  private onSessionStart() {
    this.inXR = true;
    this.placed = false;
    this.game = new Game(this.settings, launch.job, newSeed());
    if (AUTOPLAY) {
      this.cinema = new Cinema();
      this.cinema.reset({ blunder: true, gap: 1.2, job: launch.job, seed: 3 });
      this.game = this.cinema.game;
    }
    this.view.setJob(this.game.level);
    // Passthrough: the session blends with the room, so the van gives way to it.
    const blend = this.world.session?.environmentBlendMode;
    this.view.setMixed(blend === 'alpha-blend' || blend === 'additive');
    this.endAt = 0;
    this.view.resetEnd();
    this.endPanel.show(null);
    this.settingsOpen = false;
    this.pausedBySettings = false;
    this.recentreT = 0;
    this.record = null;
    this.recordPanel.show(null);
    this.settingsPanel.show(null);
    sound.music?.setPaused(false);
    const session = this.world.session;
    // Headset off or asleep: no frames arrive, so pause here and resume sound on return.
    session?.addEventListener('visibilitychange', () => {
      if (session.visibilityState === 'visible') sound.start();
      else if (!this.cinema) this.game.setPaused(true);
    });
    // Stay at the browser's default 72 Hz: the simulation steps at 60 Hz, so 90 Hz
    // would cost 25% more frames without smoother motion.
    this.world.renderer.xr.setFoveation(1);
    sound.music?.setEnabled(this.settings.music);
  }

  private onSessionEnd() {
    this.inXR = false;
    if (AUTOPLAY) this.cinema = null;
    sound.music?.stop();
    // Rain, hums and the camera stop with the session; Enter resumes them.
    void sound.ctx?.suspend();
    store.saveLog(this.game.log.join('\n'));
    if (DEBUG && this.recording.length) store.saveRecording(JSON.stringify({ hz: 30, joints: JOINT_NAMES, frames: this.recording }));
    this.view.setMixed(false);
    this.view.place(this.placeHead.set(0, 1.2, 0), this.placeQ.identity(), 0, 0);
    this.placed = false;
  }

  update(delta: number, time: number) {
    const now = time * 1000;
    const session = this.world.session;
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    if (CINEMA) return this.film();
    if (!session || !frame || !ref) return this.preview(delta, now);
    if (!this.inXR) this.onSessionStart();
    // toggleVisual(false) stops the SDK posing its hand model, but its input
    // update still shows it every frame: a frozen open hand at each wrist that
    // also writes depth. Hide it after that update, before rendering.
    for (const h of HANDS) {
      const v = this.input.xr.visualAdapters.hand[h].visual;
      if (v) v.model.visible = false;
    }

    // The system menu is open: pause, and leave everything as it is.
    const vis = this.visibilityState.peek();
    if (vis === VisibilityState.VisibleBlurred || vis === VisibilityState.Hidden) {
      if (!this.blurred) {
        // Autoplay just stops here; no hands could un-pause it.
        if (!this.cinema) this.game.setPaused(true);
        sound.eye(false, this.head);
      }
      this.blurred = true;
      return;
    }
    this.blurred = false;

    this.player.head.getWorldPosition(this.head);
    this.player.head.getWorldQuaternion(this.headQ);
    if (!this.placed && this.head.y > 0.4) {
      this.placeHead.copy(this.head);
      this.placeQ.copy(this.headQ);
      this.placed = true;
      this.placeTable();
    }
    const fwd = this.v.set(0, 0, -1).applyQuaternion(this.headQ);
    const up = this.w.set(0, 1, 0).applyQuaternion(this.headQ);
    sound.listener(this.head, fwd.x, fwd.y, fwd.z, up.x, up.y, up.z);
    if (this.cinema) return this.autoplay(delta);

    this.readHands(session, frame, ref);
    const g = this.game;
    for (const h of HANDS) g.hand(h, this.handInput(h), now);
    this.pokePanels();

    if (this.record) this.updateRecord(delta);
    else g.update(delta, now);
    this.handleEvents(now);
    this.ambient(delta);
    this.score(g);
    this.updatePrompt(delta);
    if (this.recentreT > 0) {
      this.recentreT -= delta;
      this.view.textPrompt('Look straight ahead.', 'Recentring the table…');
      if (this.recentreT <= 0) this.placed = false;
    }
    this.updatePanels();
    this.view.sync(g, this.frames, this.headQ, delta, now);
    if (DEBUG) this.debug(delta, now);
    if (import.meta.env.DEV) {
      if (g.log.length < this.logged) this.logged = 0;
      while (this.logged < g.log.length) console.log(`[game] ${g.log[this.logged++]}`);
    }
  }

  /**
   * Cinema mode: one frame, start to finish, on demand: advance the film,
   * run the systems, render, lay the titles over it and encode. The SDK's own
   * loop is stopped so nothing renders twice.
   */
  private shoot(cam: Cinema['cam'], steps: number, titles: Titles, type: string) {
    const c = this.cinema!;
    const r = this.world.renderer;
    if (!this.frameCanvas) {
      r.setAnimationLoop(null);
      this.frameCanvas = document.createElement('canvas');
    }
    const out = this.frameCanvas!;
    // A full black card needs no render.
    if (titles.black !== 1) {
      c.cam = cam;
      c.pending = steps;
      this.world.update(1 / 30, c.t);
      r.render(this.world.scene, this.world.camera);
    }
    out.width = r.domElement.width;
    out.height = r.domElement.height;
    const ctx = out.getContext('2d')!;
    if (titles.black !== 1) ctx.drawImage(r.domElement, 0, 0);
    drawTitles(ctx, out.width, out.height, titles, this.mark!);
    return out.toDataURL(type, 0.92);
  }

  /** Milliseconds: wall time, or film time in cinema mode. */
  private clock() {
    return this.cinema ? this.cinema.t * 1000 : performance.now();
  }

  /** Cinema mode: one frame of film per requested step; otherwise hold still. */
  private film() {
    const c = this.cinema!;
    let dt = 0;
    if (c.pending > 0) {
      dt = 1 / 30;
      c.advance(dt);
      c.pending--;
    }
    if (this.game !== c.game) {
      this.game = c.game;
      if (this.view.level !== this.game.level) this.view.setJob(this.game.level);
      this.filmT = c.t;
      this.endAt = 0;
      this.view.resetEnd();
      this.view.van.clearLog();
    }
    const g = this.game;
    const now = c.t * 1000;
    // Animation catches up with any seek: effects decay, the end sequence plays.
    const viewDt = Math.min(3, Math.max(0, c.t - this.filmT));
    this.filmT = c.t;
    c.aim(this.camera);
    this.camera.getWorldQuaternion(this.headQ);
    c.frames(this.view, this.frames);
    this.handleEvents(now, c.events.splice(0));
    if (g.ended) this.endAt = c.endedAt * 1000;
    this.view.clean = c.clean;
    if (c.clean) this.view.textPrompt('', '');
    else this.updatePrompt(dt);
    this.settingsOpen = c.settings;
    this.updatePanels();
    this.dock.show(null);
    this.view.sync(g, this.frames, this.headQ, viewDt, now);
  }

  /** Autoplay: the bot's synthetic hands stand in for tracked ones, in real time. */
  private autoplay(dt: number) {
    const c = this.cinema!;
    c.advance(Math.min(dt, 0.1));
    const g = this.game;
    const now = c.t * 1000;
    c.frames(this.view, this.frames);
    this.handleEvents(now, c.events.splice(0));
    this.ambient(dt);
    this.score(g);
    this.updatePrompt(dt);
    this.updatePanels();
    this.view.sync(g, this.frames, this.headQ, dt, now);
  }

  private placeTable() {
    this.view.place(this.placeHead, this.placeQ, this.settings.tableY, this.settings.tableZ);
  }

  /** On the landing page: the gallery glows behind the menu while Bert patrols. */
  private preview(dt: number, now: number) {
    if (this.inXR) this.onSessionEnd();
    const d = this.demo;
    if (this.view.level !== d.level) this.view.setJob(d.level);
    // Fixed steps from an accumulator, so Bert walks at the same pace at 60, 90 or 144 Hz.
    this.previewAcc = Math.min(this.previewAcc + dt, 0.1);
    for (; this.previewAcc >= T.step; this.previewAcc -= T.step) d.sim.step();
    d.sim.events = [];
    this.camera.getWorldQuaternion(this.headQ);
    for (const h of HANDS) this.frames[h].tracked = false;
    this.view.textPrompt('', '');
    this.view.sync(d, this.frames, this.headQ, dt, now);
  }

  private readHands(session: XRSession, frame: XRFrame, ref: XRReferenceSpace) {
    this.controllers = false;
    for (const h of HANDS) this.frames[h].tracked = false;
    for (const src of session.inputSources) {
      const hand = src.hand;
      if (src.handedness !== 'left' && src.handedness !== 'right') continue;
      if (!hand) {
        if (src.gamepad) this.controllers = true;
        continue;
      }
      let spaces = this.spaces.get(src);
      if (!spaces) {
        spaces = JOINT_NAMES.map((n) => hand.get(n as XRHandJoint) as XRSpace);
        this.spaces.set(src, spaces);
      }
      this.frames[src.handedness].tracked = this.fill(frame, spaces, ref, this.frames[src.handedness].joints);
    }
  }

  /** Joint positions in world space. Uses fillPoses where the browser has it. */
  private fill(frame: XRFrame, spaces: XRSpace[], ref: XRReferenceSpace, out: Float32Array): boolean {
    const pm = this.player.matrixWorld;
    const fillPoses = (frame as any).fillPoses as ((s: XRSpace[], b: XRSpace, t: Float32Array) => boolean) | undefined;
    if (fillPoses) {
      if (!fillPoses.call(frame, spaces, ref, this.mats)) return false;
      for (let i = 0; i < 25; i++) {
        this.u.set(this.mats[i * 16 + 12], this.mats[i * 16 + 13], this.mats[i * 16 + 14]).applyMatrix4(pm);
        out[i * 3] = this.u.x;
        out[i * 3 + 1] = this.u.y;
        out[i * 3 + 2] = this.u.z;
      }
      return true;
    }
    for (let i = 0; i < 25; i++) {
      const pose = frame.getJointPose?.(spaces[i] as XRJointSpace, ref);
      if (!pose) return false;
      const p = pose.transform.position;
      this.u.set(p.x, p.y, p.z).applyMatrix4(pm);
      out[i * 3] = this.u.x;
      out[i * 3 + 1] = this.u.y;
      out[i * 3 + 2] = this.u.z;
    }
    return true;
  }

  /** Pose, command zone, aim and palm-up for one hand. */
  private handInput(h: HandId): HandInput {
    const fr = this.frames[h];
    const inp: HandInput = { tracked: fr.tracked, inZone: false, pose: 'none', aim: null, palmUp: false, pinch: false };
    fr.inZone = false;
    fr.nearEdge = false;
    fr.aimHit = null;
    fr.aimSpot = null;
    if (!fr.tracked) {
      this.smooth[h].ok = false;
      return inp;
    }
    const j = fr.joints;
    features(j, this.f);
    inp.pose = classify(this.f, this.templates);
    if (import.meta.env.DEV && inp.pose !== this.lastPose[h]) {
      this.lastPose[h] = inp.pose;
      console.log(`[pose] ${h} ${inp.pose} ${this.f.map((v) => v.toFixed(2)).join(' ')}`);
    }
    inp.palmUp = palmUp(j, h === 'left') > T.palmUpCos;
    inp.pinch = this.input.xr.getSelectState(h).active;

    // Glyph spot: above the middle of the hand.
    fr.palm.set((j[0] + j[33]) / 2, (j[1] + j[34]) / 2 + 0.065, (j[2] + j[35]) / 2);

    // Command zone: wrist over the table, in front of the head.
    const wrist = this.v.set(j[0], j[1], j[2]);
    const ahead = this.u.copy(wrist).sub(this.head);
    const fwd = this.w.set(0, 0, -1).applyQuaternion(this.headQ).setY(0).normalize();
    const forward = ahead.dot(fwd);
    // Near the edge of what the cameras see: warn before tracking drops.
    this.invHead.copy(this.headQ).invert();
    ahead.applyQuaternion(this.invHead);
    const side = Math.atan2(Math.abs(ahead.x), -ahead.z) / DEG;
    const vert = Math.atan2(Math.abs(ahead.y), -ahead.z) / DEG;
    fr.nearEdge = ahead.z > 0 || side > T.edgeSideDeg || vert > T.edgeVertDeg;
    const wl = this.view.toAnchor(wrist, this.u);
    fr.inZone =
      wl.y > T.zoneAbove &&
      Math.abs(wl.x) < T.tableW / 2 + T.zoneMargin &&
      Math.abs(wl.z) < T.tableD / 2 + T.zoneMargin &&
      forward > T.zoneAhead;
    inp.inZone = fr.inZone;

    // Aim: from between the eyes through the index fingertip, to the model floor.
    const sm = this.smooth[h];
    const held = this.game.filters[h].held;
    if (inp.pose === 'point' || inp.pose === 'two' || held === 'point' || held === 'two') {
      const eye = this.view.toAnchor(this.head, this.v);
      const tip = this.view.toAnchor(this.w.set(j[27], j[28], j[29]), this.w);
      const dy = tip.y - eye.y;
      if (dy < -1e-3) {
        const t = -eye.y / dy;
        const x = eye.x + (tip.x - eye.x) * t;
        const z = eye.z + (tip.z - eye.z) * t;
        if (sm.ok) {
          sm.x += (x - sm.x) * T.aimSmooth;
          sm.z += (z - sm.z) * T.aimSmooth;
        } else {
          sm.x = x;
          sm.z = z;
          sm.ok = true;
        }
        if (Math.abs(sm.x) < 0.36 && Math.abs(sm.z) < 0.26) {
          // The hologram is scaled to fit the table; aim works in its own units.
          const L = this.game.level;
          fr.aimHit = this.aimVec[h].set(sm.x / L.fit, 0, sm.z / L.fit);
          const [rx, rz] = fromModel(fr.aimHit);
          fr.aimSpot = L.pickSpot(rx, rz, this.game.targetable, this.game.hands[h].aim);
          inp.aim = fr.aimSpot;
        }
      } else sm.ok = false;
    } else sm.ok = false;
    return inp;
  }

  /** The score leans in as the guard closes and lifts on the way out. */
  private score(g: Game) {
    const m = sound.music;
    if (!m) return;
    const s = g.sim.s;
    const meter = Math.max(s.lark.eye, s.lark.guard, s.rook.eye, s.rook.guard);
    const wary = s.guards.some((b) => b.suspect || b.inv === 1 || b.inv === 2);
    m.setTension(g.ended ? 0 : Math.min(1, meter * 1.4 + (wary ? 0.5 : 0) + (s.carrying || s.loot ? 0.3 : 0)));
    m.update();
  }

  private vanLog(line: string) {
    this.view.van.log(line, this.game.stats.time);
  }

  private handleEvents(now: number, events = this.game.takeEvents()) {
    const g = this.game;
    const s = g.sim.s;
    const L = g.level;
    const at = (id: string) => this.view.worldOf(L.spot[id].x, L.spot[id].z, this.v);
    const guardAt = (i: number) => this.view.worldOf(s.guards[i].x, s.guards[i].z, this.v, 0.08);
    for (const e of events) {
      switch (e.type) {
        case 'signal': {
          sound.tick(e.hand === 'left', this.frames[e.hand].palm);
          const who = g.thiefFor(e.hand);
          if (e.ok && who && e.cmd !== 'point') this.vanLog(`${who.toUpperCase()}  ${e.cmd === 'fist' ? 'FREEZE' : 'DO IT'}`);
          break;
        }
        case 'route': {
          const th = s.carrying ? s.lark : s[e.thief];
          this.view.routePreview([[th.x, th.z], ...th.route.map((id) => [L.spot[id].x, L.spot[id].z] as [number, number])]);
          const to = th.route[th.route.length - 1];
          if (to) this.vanLog(`${s.carrying ? 'CREW' : e.thief.toUpperCase()}  GO ${to.toUpperCase()}`);
          break;
        }
        case 'no':
          sound.no(this.view.worldOf(s[e.thief].x, s[e.thief].z, this.v));
          this.view.shake(e.thief);
          break;
        case 'lit':
          for (const h of g.handsOf(e.thief)) this.view.label(h, now);
          if (e.thief === 'rook') sound.spark(this.frames[g.handsOf('rook')[0]].palm);
          break;
        case 'swap':
          for (const h of HANDS) this.view.label(h, now);
          break;
        case 'beat':
          if (e.beat === 0) {
            sound.scan();
            sound.music?.title();
            this.view.van.clearLog();
          }
          if (e.beat === 1) sound.music?.start();
          break;
        case 'rewind':
          sound.rewind();
          this.vanLog('REWOUND. AGAIN.');
          break;
        case 'assist':
          this.settings.assist = true;
          store.saveSettings(this.settings);
          sound.check();
          break;
        case 'checkpoint':
          this.vanLog('CHECKPOINT.');
          break;
        case 'end':
          this.endAt = this.clock();
          this.endStamped = false;
          sound.win();
          sound.music?.finale();
          this.vanLog('OUT CLEAN. NICE WORK.');
          this.view.startEnd();
          // A bot's run (autoplay) is not the player's best.
          if (!this.cinema) store.offerBest({ stamp: g.stamp, time: g.stats.time }, L.id);
          store.saveLog(g.log.join('\n'));
          break;
        case 'pause':
          sound.music?.setPaused(e.on);
          break;
        case 'sim': {
          const se = e.e;
          if (se.type === 'arrived') {
            this.view.checkMark(se.thief, now);
            sound.check(this.view.worldOf(s[se.thief].x, s[se.thief].z, this.v));
          } else if (se.type === 'done') {
            this.vanLog(DONE_LOG[se.action]);
            const p = at(L.job.tasks[se.action]![0]);
            if (se.action === 'cut' || se.action === 'power' || se.action === 'lights') sound.buzz(p);
            else if (se.action === 'keys') sound.vault(p);
            else sound.check(p);
          } else if (se.type === 'spotted') {
            const by = BY_LOG[se.by] ?? (L.job.guards.find((d) => d.id === se.by)?.name ?? se.by).toUpperCase();
            this.vanLog(`! ${se.thief.toUpperCase()} SPOTTED BY ${by}`);
            sound.music?.duck();
            sound.spotted(this.view.worldOf(s[se.thief].x, s[se.thief].z, this.v));
            this.view.spotted(s[se.thief]);
          } else if (se.type === 'suspicious') sound.question(guardAt(se.guard));
          else if (se.type === 'heard') {
            this.vanLog(`${L.job.guards[se.guard].name.toUpperCase()} HEARD SOMETHING.`);
            sound.question(guardAt(se.guard));
          } else if (se.type === 'climbed') sound.step(at(L.job.entry));
          else if (se.type === 'out') {
            this.vanLog(`${se.thief.toUpperCase()} IS OUT.`);
            sound.step(at(L.job.entry));
          } else if (se.type === 'coin') {
            sound.coin(this.view.worldOf(se.x, se.z, this.v, 0));
            this.vanLog(se.guard >= 0 ? `${L.job.guards[se.guard].name.toUpperCase()} GOES TO LOOK.` : 'COIN. NOBODY HEARD.');
          }
          break;
        }
      }
    }
  }

  /** Footsteps, work ticks, the lift tone and the camera's hum. */
  private ambient(dt: number) {
    const g = this.game;
    const s = g.sim.s;
    const live = !g.paused && !g.ended && g.rewindT <= 0 && !this.record;
    this.stepT += dt;
    if (live && this.stepT > 0.55) {
      this.stepT = 0;
      for (const b of s.guards) if (b.walking) sound.step(this.view.worldOf(b.x, b.z, this.v, 0));
    }
    // The vault sensor beeps as it blinks.
    const sensor = g.sim.sensor();
    if (live && sensor === 'warn' && this.lastSensor !== 'warn') {
      const c = g.level.job.sensor!;
      sound.beep(this.view.worldOf(c.x, c.z, this.v, 0.05));
    }
    this.lastSensor = sensor;
    const worker = s.lark.state === 'working' ? s.lark : s.rook.state === 'working' ? s.rook : null;
    this.workT += dt;
    if (live && worker && this.workT > 0.5) {
      this.workT = 0;
      sound.work(this.view.worldOf(worker.x, worker.z, this.v));
    }
    const pair = s.lark.state === 'working' && s.rook.state === 'working' && s.lark.action === s.rook.action;
    if (pair && !this.wasLifting) sound.lift(this.view.worldOf(s.lark.x, s.lark.z, this.v));
    this.wasLifting = pair;
    // The Eye's hum in Job 1, the lasers' in Job 2.
    const eye = g.level.job.eye;
    const las = g.level.job.lasers;
    const hum = eye ? s.eyeAwake && s.cameraOn : s.lasersOn;
    const hx = eye ? eye.x : las ? las[0] : 0;
    const hz = eye ? eye.z : las ? (las[1] + las[3]) / 2 : 0;
    sound.eye(live && hum, this.view.worldOf(hx, hz, this.v, 0.05));
  }

  private updatePrompt(dt: number) {
    const g = this.game;
    const any = this.frames.left.tracked || this.frames.right.tracked;
    this.noHandsT = any ? 0 : this.noHandsT + dt;
    if (this.record) return;
    if (this.controllers) return this.view.textPrompt('Put your controllers down. This job is hands only.', '', true);
    if (g.ended) return this.view.textPrompt('', '');
    if (this.noHandsT > 5 && g.beatT > T.scanS) return this.view.textPrompt('Raise your hands over the table.', '');
    if (g.paused) return this.view.textPrompt('Paused', this.settingsOpen ? '' : 'Palms up, or press Resume, to carry on.');
    if (g.rewindT > 0) return this.view.textPrompt('Spotted!', 'Rewinding…', true);
    this.view.textPrompt(g.shownPrompt.text, g.caption);
  }

  private pokePanels() {
    for (const h of HANDS) {
      const fr = this.frames[h];
      const tip = fr.tracked ? this.u.set(fr.joints[27], fr.joints[28], fr.joints[29]) : null;
      for (const p of this.panels) {
        const id = p.poke(h, tip);
        if (id) this.press(id);
      }
    }
  }

  private updatePanels() {
    const g = this.game;
    const s = this.settings;
    this.dock.show(
      g.ended || this.settingsOpen || this.record
        ? null
        : {
            title: '',
            buttons: [
              { id: 'pause', label: g.paused ? 'Resume' : 'Pause', col: 0, row: 0, on: g.paused },
              { id: 'settings', label: 'Settings', col: 1, row: 0, on: this.settingsOpen },
            ],
          },
    );
    // Built only while open: no per-frame garbage when Settings is closed.
    const settings: Button[] | null = this.settingsOpen && !this.record ? [
      { id: 'hands', label: s.oneHand ? 'Hands: one' : 'Hands: two', col: 0, row: 0, on: s.oneHand },
      { id: 'swap', label: s.larkRight ? 'Lark: right' : 'Lark: left', col: 1, row: 0, on: s.larkRight },
      { id: 'recentre', label: 'Recentre', col: 2, row: 0 },
      { id: 'up', label: 'Table up', col: 0, row: 1 },
      { id: 'down', label: 'Table down', col: 1, row: 1 },
      { id: 'assist', label: s.assist ? 'Assist: on' : 'Assist: off', col: 2, row: 1, on: s.assist },
      { id: 'near', label: 'Nearer', col: 0, row: 2 },
      { id: 'far', label: 'Farther', col: 1, row: 2 },
      { id: 'hints', label: g.settings.hints ? 'Hints: on' : 'Hints: off', col: 2, row: 2, on: g.settings.hints },
      { id: 'record', label: 'Re-record', col: 0, row: 3 },
      { id: 'reset', label: 'Reset all', col: 1, row: 3 },
      { id: 'close', label: 'Close', col: 2, row: 3 },
      { id: 'music', label: s.music ? 'Music: on' : 'Music: off', col: 0, row: 4, on: s.music },
    ] : null;
    this.settingsPanel.show(settings && { title: 'Settings', buttons: settings });
    // The end card lands after the prize rises: a stamp, then the numbers.
    const since = this.endAt ? (this.clock() - this.endAt) / 1000 : 0;
    if (g.ended && since > 1.9 && !this.endStamped) {
      this.endStamped = true;
      sound.stamp();
    }
    const pop = Math.min(1, Math.max(0, (since - 1.9) / 0.32));
    this.endPanel.plane.mesh.scale.setScalar(1 + 0.4 * (1 - pop) ** 3);
    if (g.ended && since > 1.9 && !this.settingsOpen && !this.record) {
      const t = Math.round(g.stats.time);
      const best = store.best(g.level.id);
      const g1 = !g.open;
      this.endPanel.show({
        title: g1 ? 'The Blue Kite is going home.' : 'The Gilded Heron flies tonight.',
        stamp: g.stamp.toUpperCase(),
        lines: [
          `Time ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}  ·  Rewinds ${g.stats.rewinds}  ·  Signals ${g.stats.signals}`,
          best ? `Best on this headset: ${best.stamp}, ${Math.round(best.time)} s` : '',
        ],
        buttons: g1
          ? [
              { id: 'next', label: 'Next job: Halloran’s', col: 0, row: 0, span: 2, on: true },
              { id: 'again', label: 'Again, no hints', col: 0, row: 1 },
              { id: 'settings', label: 'Settings', col: 1, row: 1 },
            ]
          : [
              { id: 'again', label: 'Again: a new night', col: 0, row: 0, span: 2, on: true },
              { id: 'job1', label: 'Back to Job 1', col: 0, row: 1 },
              { id: 'settings', label: 'Settings', col: 1, row: 1 },
            ],
      });
    } else this.endPanel.show(null);
    if (!this.record) this.recordPanel.show(null);
  }

  private press(id: string) {
    const g = this.game;
    const s = this.settings;
    sound.tick(false);
    switch (id) {
      case 'pause':
        g.setPaused(!g.paused);
        return;
      case 'settings':
        this.settingsOpen = !this.settingsOpen;
        if (this.settingsOpen && !g.paused && !g.ended && g.beat > 0) {
          g.setPaused(true);
          this.pausedBySettings = true;
        }
        if (!this.settingsOpen) this.closeSettings();
        return;
      case 'close':
        this.settingsOpen = false;
        this.closeSettings();
        return;
      case 'hands':
        s.oneHand = !s.oneHand;
        break;
      case 'swap':
        s.larkRight = !s.larkRight;
        break;
      case 'up':
        s.tableY = Math.min(0.15, s.tableY + T.tableStep);
        break;
      case 'down':
        s.tableY = Math.max(-0.15, s.tableY - T.tableStep);
        break;
      case 'near':
        s.tableZ = Math.max(-0.1, s.tableZ - T.tableStep);
        break;
      case 'far':
        s.tableZ = Math.min(0.15, s.tableZ + T.tableStep);
        break;
      case 'recentre':
        // The button is off to the side: wait for the player to face forward.
        this.recentreT = 1.5;
        return;
      case 'assist':
        s.assist = !s.assist;
        g.setAssist(s.assist);
        break;
      case 'hints':
        // Toggle what this run shows ("Again, no hints" turns hints off for one run).
        s.hints = !g.settings.hints;
        break;
      case 'music':
        s.music = !s.music;
        sound.music?.setEnabled(s.music);
        break;
      case 'record':
        this.record = { idx: 0, rec: new Recorder(), got: {}, msg: '' };
        return;
      case 'reset':
        store.reset();
        Object.assign(s, DEFAULT_SETTINGS);
        this.templates = buildTemplates({});
        g.setAssist(false);
        sound.music?.setEnabled(s.music);
        break;
      case 'again':
        // Job 1 again is a test without hints; Job 2 again is a new night.
        this.startJob(g.level.id, g.open ? s : { ...s, hints: false });
        return;
      case 'next':
        this.startJob('halloran', s);
        return;
      case 'job1':
        this.startJob('gallery', s);
        return;
      case 'cancel':
        this.record = null;
        return;
      case 'save':
        if (this.record) {
          // Use what was recorded even if storage refuses to keep it.
          const t = { ...store.templates(), ...this.record.got };
          store.saveTemplates(t);
          this.templates = buildTemplates(t);
        }
        this.record = null;
        return;
      default:
        return;
    }
    const hints = id === 'hints' ? s.hints : g.settings.hints;
    Object.assign(g.settings, s);
    g.settings.hints = hints;
    store.saveSettings(s);
    this.placeTable();
  }

  /** A fresh run of a job, on the table now. */
  private startJob(job: JobId, settings: Settings) {
    this.game = new Game(settings, job, newSeed());
    this.view.setJob(this.game.level);
    this.endAt = 0;
    this.view.resetEnd();
    this.view.van.clearLog();
  }

  private closeSettings() {
    this.record = null;
    if (this.pausedBySettings) this.game.setPaused(false);
    this.pausedBySettings = false;
  }

  /** Re-recording: three steady samples per signal, then a live try-out. */
  private updateRecord(dt: number) {
    const r = this.record!;
    // Sample the hand that is signing over the table, not one resting in view.
    const ready = (h: HandId) => this.frames[h].tracked && this.frames[h].inZone;
    const fr = ready('right') ? this.frames.right : ready('left') ? this.frames.left : null;
    const f = fr ? features(fr.joints, [0, 0, 0, 0, 0]) : null;
    if (r.idx < CMDS.length) {
      const cmd = CMDS[r.idx];
      r.rec.update(f, dt);
      if (r.rec.phase === 'done') {
        const tpl = r.rec.template;
        const clash = clashWith(tpl, cmd, buildTemplates({ ...store.templates(), ...r.got }));
        if (clash) r.msg = `Too close to your ${NAMES[clash]} sign. Try a more different shape.`;
        else {
          r.got[cmd] = tpl;
          r.idx++;
          r.msg = '';
        }
        r.rec = new Recorder();
      }
    }
    if (r.idx < CMDS.length) {
      const cmd = CMDS[r.idx];
      const n = r.rec.samples.length;
      this.view.textPrompt(`Make your ${NAMES[cmd]} sign. Hold still.`, r.msg || (fr ? `Sample ${Math.min(3, n + 1)} of 3${r.rec.phase === 'gap' ? ': relax, then again' : ''}` : 'Raise a hand over the table.'));
      this.recordPanel.show({
        title: 'Re-record signals',
        lines: [`Sign ${r.idx + 1} of ${CMDS.length}: ${NAMES[cmd]}`, `${Math.round(r.rec.progress * 100)}% captured`],
        buttons: [{ id: 'cancel', label: 'Cancel', col: 0, row: 0, span: 2 }],
      });
    } else {
      const pose = f ? classify(f, buildTemplates({ ...store.templates(), ...r.got })) : 'none';
      this.view.textPrompt('Try your signs.', `Reading: ${POSE_NAMES[pose]}`);
      this.recordPanel.show({
        title: 'Re-record signals',
        lines: ['All captured. Try them, then save.'],
        buttons: [
          { id: 'save', label: 'Save', col: 0, row: 0 },
          { id: 'cancel', label: 'Cancel', col: 1, row: 0 },
        ],
      });
    }
  }

  /** ?debug: features, poses and timing beside the table, plus a joint recording. */
  private debug(dt: number, now: number) {
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;
    this.recT += dt;
    if (this.recT >= 1 / 30) {
      this.recT = 0;
      const row = (h: HandId) => (this.frames[h].tracked ? Array.from(this.frames[h].joints, (v) => Math.round(v * 1e4) / 1e4) : null);
      this.recording.push([[Math.round(now)], row('left'), row('right')]);
      if (this.recording.length > 45 * 30) this.recording.shift();
    }
    this.debugT += dt;
    if (this.debugT < 0.2) return;
    this.debugT = 0;
    const g = this.game;
    const s = g.sim.s;
    const lines = [`fps ${this.fps.toFixed(0)}  beat ${g.beat}.${g.sub}  t ${s.t.toFixed(1)}`];
    for (const h of HANDS) {
      const fr = this.frames[h];
      const f = fr.tracked ? features(fr.joints, [0, 0, 0, 0, 0]) : null;
      lines.push(`${h}: ${fr.tracked ? 'tracked' : '-'} ${fr.inZone ? 'zone' : '-'} ${fr.nearEdge ? 'EDGE' : ''}`);
      lines.push(`  f ${f ? f.map((v) => v.toFixed(2)).join(' ') : '-'}`);
      lines.push(`  ${f ? classify(f, this.templates) : '-'} held ${g.filters[h].held} aim ${fr.aimSpot ?? '-'}`);
    }
    s.guards.forEach((b, i) => lines.push(`${g.level.job.guards[i].id} ${b.mode} ${b.phase.toFixed(2)} ${b.suspect ?? ''} inv${b.inv}`));
    lines.push(`lark ${s.lark.state} e${s.lark.eye.toFixed(2)} g${s.lark.guard.toFixed(2)}`);
    lines.push(`rook ${s.rook.state} e${s.rook.eye.toFixed(2)} g${s.rook.guard.toFixed(2)}`);
    lines.push(`rec ${this.recording.length} frames`);
    this.view.debugText(lines);
  }
}
