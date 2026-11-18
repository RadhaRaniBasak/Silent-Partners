// Films the built game in a headless browser: store shots and the trailer.
//   npm run build && npm run film              (everything)
//   npm run film -- stills [01,04]             (some or all shots)
//   npm run film -- trailer
//   npm run film -- demo                       (the submission video)
//   npm run film -- job2                       (Job 2's highlights, from the player's eyes)
// The bot plays through the real input path (src/xr/cinema.ts). Each frame
// is one call into the page: advance, render, draw titles, encode.
// Needs Chromium for Playwright (npx playwright install chromium) and ffmpeg.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { ease, mix, open, serve } from './cinema-lib.mjs';

const what = process.argv[2] ?? 'all';
const OUT = 'media';
mkdirSync(`${OUT}/shots`, { recursive: true });

const LARK = '#2ec4b6';
const ROOK = '#f4a261';

/** One frame from the page as bytes. */
async function shoot(page, cam, steps, titles, type = 'image/jpeg') {
  const url = await page.evaluate(([c, s, t, ty]) => window.__shoot(c, s, t, ty), [cam, steps, titles, type]);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

async function startRun(page, opts, t) {
  await page.evaluate(([o, t]) => {
    window.__cinema.reset(o);
    window.__cinema.seek(t);
  }, [opts, t]);
}

// ── Store shots (3:2) ────────────────────────────────────────────────────
const JOB2 = { job: 'halloran', seed: 3, gap: 1.2 };
const STILLS = [
  { name: '01-cover', t: 21.95, cam: { pos: [0.08, 1.33, -0.03], look: [-0.03, 0.96, -0.6], fov: 50 }, badge: 1, clean: true },
  { name: '01-cover-clean', t: 21.95, cam: { pos: [0.08, 1.33, -0.03], look: [-0.03, 0.96, -0.6], fov: 50 }, clean: true },
  { name: '02-freeze', t: 6.15, cam: { pos: [0, 1.24, -0.06], look: [0, 0.95, -0.58], fov: 58 }, caption: [['Make a fist: '], ['Lark', LARK], [' freezes in cover.']] },
  { name: '03-point', t: 9.1, cam: { pos: [-0.32, 1.28, -0.02], look: [-0.08, 0.97, -0.56], fov: 48 }, caption: [['Point, and she goes.']] },
  { name: '04-the-eye', t: 12.75, cam: { pos: [0.02, 1.5, -0.22], look: [-0.02, 0.97, -0.6], fov: 40 }, caption: [['The Eye only sees movement.']] },
  { name: '05-rewind', run: { blunder: true }, t: 16.35, cam: { pos: [0.14, 1.44, -0.06], look: [-0.06, 0.97, -0.6], fov: 50 }, caption: [['Seen? The tape rewinds.']] },
  { name: '06-cut', t: 22.4, cam: { pos: [0.06, 1.16, -1.02], look: [-0.08, 0.98, -0.66], fov: 44 }, caption: [['Thumbs up: '], ['Rook', ROOK], [' cuts the camera.']] },
  { name: '07-lift', t: 34.95, cam: { pos: [-0.06, 1.36, 0.12], look: [0.08, 0.98, -0.55], fov: 50 }, caption: [['Some jobs take both hands.']] },
  { name: '08-carry', t: 53.6, cam: { pos: [-0.12, 1.4, -0.2], look: [-0.25, 0.97, -0.57], fov: 38 }, caption: [['Out the way you came in.']] },
  { name: '09-van', t: 26.0, cam: { pos: [0.45, 1.42, 0.55], look: [-0.25, 1.08, -0.6], fov: 72 }, caption: [['Run the job from the van.']] },
  { name: '10-end', t: 58.2, cam: { pos: [0, 1.2, 0.16], look: [0, 1.1, -0.5], fov: 58 } },
  // Job 2, the autoplay night (seed 3).
  { name: '11-job2-recon', run: JOB2, t: 6.0, cam: { pos: [0, 1.56, -0.13], look: [0, 0.95, -0.56], fov: 52 }, caption: [['Job 2: recon. Each guard’s round, on the plan.']] },
  { name: '12-job2-keys', run: JOB2, t: 112.6, cam: { pos: [0.3, 1.22, -0.3], look: [0.17, 0.96, -0.66], fov: 36 }, caption: [['Two keys, turned together.']] },
  { name: '13-job2-vault', run: JOB2, t: 121.0, cam: { pos: [0.24, 1.2, -0.36], look: [0.16, 0.96, -0.7], fov: 34 }, caption: [['Lark', LARK], [' cracks the case between the sensor’s looks.']] },
  { name: '14-job2-escape', run: JOB2, t: 146.0, cam: { pos: [-0.08, 1.5, -0.16], look: [-0.06, 0.95, -0.56], fov: 48 }, caption: [['Both partners have to get out.']] },
];

async function stills() {
  const { browser, page } = await open(srv.url, 1800, 1200);
  const only = process.argv[3]?.split(',');
  let current = null;
  for (const s of STILLS.filter((x) => !only || only.some((o) => x.name.startsWith(o)))) {
    const key = JSON.stringify(s.run ?? {});
    // Seeking only goes forward: start the run over to go back or switch runs.
    if (current?.key !== key || current.t > s.t - 0.05) await startRun(page, s.run ?? {}, s.t - 1 / 30);
    else await page.evaluate((t) => window.__cinema.seek(t), s.t - 1 / 30);
    current = { key, t: s.t };
    await page.evaluate((clean) => (window.__cinema.clean = clean), !!s.clean);
    const titles = { badge: s.badge ?? 0, lower: s.caption ? { words: s.caption, a: 1 } : undefined };
    writeFileSync(`${OUT}/shots/${s.name}.png`, await shoot(page, s.cam, 1, titles, 'image/png'));
    // The share image for the site: the cover again, as a small JPEG.
    if (s.name === '01-cover') writeFileSync('public/cover.jpg', await shoot(page, s.cam, 0, titles, 'image/jpeg'));
    console.log('shot', s.name);
  }
  await browser.close();
}

// ── Trailer (1080p30) ────────────────────────────────────────────────────
const fade = (t, t0, t1, edge = 0.4) => Math.min(ease((t - t0) / edge), ease((t1 - t) / edge));
const lower = (words, t0, t1) => (t) => ({ words, a: fade(t, t0, t1) });
const SHOTS = [
  { dur: 3.0, card: (t) => ({ words: [['No talking on a job.']], a: fade(t, 0, 3.0, 0.6) }) },
  { run: {}, t0: 0.0, dur: 5.0, from: { pos: [0.55, 1.45, 0.55], look: [-0.1, 1.02, -0.55], fov: 58 }, to: { pos: [0.06, 1.3, -0.04], look: [0, 0.98, -0.55], fov: 50 } },
  { run: {}, t0: 5.0, dur: 3.5, from: { pos: [-0.4, 1.16, -0.12], look: [-0.2, 1.0, -0.5], fov: 46 }, to: { pos: [-0.34, 1.14, -0.18], look: [-0.2, 0.99, -0.52], fov: 44 },
    lower: lower([['Your left hand is '], ['Lark', LARK], ['.']], 0.4, 3.3) },
  { run: {}, t0: 8.5, dur: 3.5, from: { pos: [-0.32, 1.3, 0.0], look: [-0.08, 0.97, -0.55], fov: 48 }, to: { pos: [-0.26, 1.28, -0.04], look: [-0.08, 0.97, -0.56], fov: 46 },
    lower: lower([['Point, and she goes.']], 0.3, 3.3) },
  { run: {}, t0: 12.0, dur: 3.0, from: { pos: [0.04, 1.52, -0.18], look: [-0.02, 0.97, -0.6], fov: 42 }, to: { pos: [0.0, 1.48, -0.24], look: [-0.02, 0.97, -0.6], fov: 40 },
    lower: lower([['The camera only sees movement.']], 0.3, 2.8) },
  { run: {}, t0: 16.0, dur: 4.5, from: { pos: [0.36, 1.3, -0.04], look: [-0.06, 0.97, -0.6], fov: 50 }, to: { pos: [0.3, 1.24, -0.16], look: [-0.06, 0.97, -0.62], fov: 48 },
    lower: lower([['Your right hand is '], ['Rook', ROOK], ['.']], 0.5, 4.2) },
  { run: {}, t0: 21.0, dur: 4.0, from: { pos: [0.08, 1.18, -1.04], look: [-0.08, 0.98, -0.66], fov: 46 }, to: { pos: [0.04, 1.15, -1.0], look: [-0.08, 0.98, -0.66], fov: 42 },
    lower: lower([['Thumbs up does the job.']], 0.4, 3.8) },
  { run: {}, t0: 25.0, dur: 2.5, from: { pos: [-0.2, 1.3, 0.12], look: [-0.86, 1.26, -0.5], fov: 50 }, to: { pos: [-0.28, 1.29, 0.08], look: [-0.88, 1.26, -0.48], fov: 46 },
    lower: lower([['The Eye is out.']], 0.3, 2.3) },
  { run: { blunder: true }, t0: 13.6, dur: 5.0, from: { pos: [0.16, 1.46, -0.02], look: [-0.06, 0.97, -0.6], fov: 50 }, to: { pos: [0.12, 1.42, -0.1], look: [-0.06, 0.97, -0.6], fov: 48 },
    lower: lower([['Seen? The tape rewinds.']], 2.4, 4.8) },
  { run: {}, t0: 33.9, dur: 4.5, from: { pos: [-0.06, 1.38, 0.14], look: [0.08, 0.98, -0.55], fov: 50 }, to: { pos: [-0.03, 1.34, 0.08], look: [0.08, 0.98, -0.55], fov: 48 },
    lower: lower([['Some jobs take both hands.']], 0.5, 4.2) },
  { run: {}, t0: 50.5, dur: 5.0, from: { pos: [-0.1, 1.44, -0.14], look: [-0.25, 0.97, -0.57], fov: 40 }, to: { pos: [-0.14, 1.38, -0.22], look: [-0.25, 0.97, -0.57], fov: 38 } },
  { run: {}, t0: 55.3, dur: 5.0, from: { pos: [0, 1.22, 0.2], look: [0, 1.1, -0.5], fov: 60 }, to: { pos: [0, 1.2, 0.14], look: [0, 1.1, -0.5], fov: 57 } },
  { dur: 6.5, logo: (t) => fade(t, 0, 6.5, 0.8) },
];

async function trailer() {
  // `npm run film -- trailer 1,8` re-renders only those shots (0-based) over the existing frames.
  const only = process.argv[3]?.split(',').map(Number);
  if (!only) rmSync(`${OUT}/frames`, { recursive: true, force: true });
  mkdirSync(`${OUT}/frames`, { recursive: true });
  const { browser, page } = await open(srv.url, 1920, 1080);
  let n = 0;
  let film = 0;
  let current = null;
  const started = Date.now();
  for (const [i, shot] of SHOTS.entries()) {
    const frames = Math.round(shot.dur * 30);
    if (only && !only.includes(i)) {
      n += frames;
      film += shot.dur;
      continue;
    }
    if (shot.run) {
      const key = JSON.stringify(shot.run);
      if (current?.key !== key || current.t > shot.t0) await startRun(page, shot.run, shot.t0);
      else await page.evaluate((t) => window.__cinema.seek(t), shot.t0);
      current = { key, t: shot.t0 + shot.dur };
    }
    for (let f = 0; f < frames; f++) {
      const t = f / 30;
      const u = ease(f / Math.max(1, frames - 1));
      const cam = shot.run ? { pos: mix(shot.from.pos, shot.to.pos, u), look: mix(shot.from.look, shot.to.look, u), fov: shot.from.fov + (shot.to.fov - shot.from.fov) * u } : null;
      const titles = {
        black: shot.run ? 0 : 1,
        card: shot.card?.(t),
        lower: shot.lower?.(t),
        logo: shot.logo?.(t) ?? 0,
      };
      writeFileSync(`${OUT}/frames/${String(n++).padStart(5, '0')}.jpg`, await shoot(page, cam, shot.run ? 1 : 0, titles));
    }
    film += shot.dur;
    const secs = (Date.now() - started) / 1000;
    console.log(`${film.toFixed(1)} s of film, ${n} frames, ${(secs / n).toFixed(2)} s a frame`);
  }
  // The score, cued to the cut (trailer seconds).
  const cues = [
    [0.2, 'title'], [3.0, 'start'],
    [15.0, 'tension', 0.45], [18.0, 'tension', 0.1], [26.5, 'tension', 0],
    [29.0, 'tension', 0.6], [31.3, 'duck'], [33.5, 'tension', 0.15],
    [38.5, 'tension', 0.5], [43.4, 'tension', 0],
    [45.3, 'finale'], [48.6, 'title'],
  ];
  const wav = await page.evaluate(([d, c]) => window.__score(d, c), [film, cues]);
  writeFileSync(`${OUT}/score.wav`, Buffer.from(wav, 'base64'));
  await browser.close();
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', '30', '-i', `${OUT}/frames/%05d.jpg`, '-i', `${OUT}/score.wav`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-shortest', `${OUT}/trailer.mp4`,
  ]);
  console.log('trailer:', `${OUT}/trailer.mp4`);
}

// ── Demo (1080p30): what a player sees, start to finish ─────────────────
// The rules ask for footage as seen in a headset or an emulator, so this is
// the autoplay run from the player's eyes, captioned, and labelled as such.
const POV = { pos: [0, 1.2, 0], look: [0, 0.97, -0.55], fov: 62 };
const HOOK = 3; // title card
const RUN = 72; // the heist, through its end card
const SET = 6; // the Settings panel
const OUTRO = 6;
// Where the player looks: the table, then up at the end card, then right at Settings.
const LOOK_END = [0, 1.22, -0.55];
const LOOK_SET = [0.36, 1.12, -0.41];
// Run seconds in, camera out; a seated head is never quite still.
const head = (t) => {
  let look = mix(POV.look, LOOK_END, ease((t - 64.4) / 1.1));
  look = mix(look, LOOK_SET, ease((t - RUN) / 1.1));
  return {
    pos: [POV.pos[0] + 0.012 * Math.sin(t * 0.37), POV.pos[1] + 0.006 * Math.sin(t * 0.53 + 1), POV.pos[2] + 0.01 * Math.sin(t * 0.29 + 2)],
    look: [look[0] + 0.03 * Math.sin(t * 0.21 + 0.5), look[1] + 0.012 * Math.sin(t * 0.33), look[2]],
    fov: POV.fov,
  };
};
const TAG = 'AUTOPLAY  ·  EMULATED HEADSET VIEW';
// [from, to, words] in run seconds, timed to the bot's run (Cinema.dry()).
// The game's own prompts name each signal; these say what it adds up to.
const CAPTIONS = [
  [4.4, 8.3, [['Your left hand commands '], ['Lark', LARK], ['.']]],
  [8.7, 13.0, [['No controllers. No buttons. Just your hands.']]],
  [13.3, 15.8, [['Move while the Eye is watching, and…']]],
  [15.9, 19.6, [['…the tape rewinds. No game over.']]],
  [19.9, 24.6, [['Go when it looks away.']]],
  [25.0, 31.2, [['Your right hand commands '], ['Rook', ROOK], ['.']]],
  [34.6, 44.4, [['Two partners at once, one in each hand.']]],
  [44.7, 47.3, [['Some jobs take both hands.']]],
  [47.6, 62.8, [['Out the way you came in.']]],
];
const caption = (t) => {
  const c = CAPTIONS.find(([a, b]) => t >= a && t <= b);
  return c ? { words: c[2], a: fade(t, c[0], c[1], 0.3) } : undefined;
};

async function demo() {
  rmSync(`${OUT}/demo-frames`, { recursive: true, force: true });
  mkdirSync(`${OUT}/demo-frames`, { recursive: true });
  const { browser, page } = await open(srv.url, 1920, 1080);
  let n = 0;
  const started = Date.now();
  const put = async (cam, steps, titles) =>
    writeFileSync(`${OUT}/demo-frames/${String(n++).padStart(5, '0')}.jpg`, await shoot(page, cam, steps, titles));
  for (let f = 0; f < HOOK * 30; f++) await put(null, 0, { black: 1, card: { words: [['No talking on a job.']], a: fade(f / 30, 0, HOOK, 0.6) } });
  await startRun(page, { blunder: true, gap: 1.2 }, 0);
  for (let f = 0; f < RUN * 30; f++) {
    const t = f / 30;
    await put(head(t), 1, { lower: caption(t), tag: TAG });
    if (f % 300 === 299) console.log(`${(HOOK + t).toFixed(0)} s of film, ${((Date.now() - started) / 1000 / n).toFixed(2)} s a frame`);
  }
  await page.evaluate(() => (window.__cinema.settings = true));
  for (let f = 0; f < SET * 30; f++) {
    const t = f / 30;
    await put(head(RUN + t), 1, { lower: { words: [['Play seated, with one hand, or with signs you record.']], a: fade(t, 0, SET, 0.4) }, tag: TAG });
  }
  for (let f = 0; f < OUTRO * 30; f++) {
    await put(null, 0, { black: 1, logo: fade(f / 30, 0, OUTRO, 0.8), url: 'radharanibasak.github.io/silent-partners' });
  }
  const at = (s) => HOOK + s;
  const cues = [
    [0.2, 'title'], [at(4.0), 'start'], [at(9.0), 'tension', 0.45], [at(15.9), 'duck'], [at(17.6), 'tension', 0.2],
    [at(22.0), 'tension', 0.4], [at(24.9), 'tension', 0.15], [at(34.4), 'tension', 0.05], [at(39.0), 'tension', 0.3],
    [at(47.2), 'tension', 0.55], [at(63.6), 'finale'], [at(RUN + SET) + 0.3, 'title'],
  ];
  const film = HOOK + RUN + SET + OUTRO;
  const wav = await page.evaluate(([d, c]) => window.__score(d, c), [film, cues]);
  writeFileSync(`${OUT}/demo-score.wav`, Buffer.from(wav, 'base64'));
  await browser.close();
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', '30', '-i', `${OUT}/demo-frames/%05d.jpg`, '-i', `${OUT}/demo-score.wav`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-shortest', `${OUT}/demo.mp4`,
  ]);
  console.log('demo:', `${OUT}/demo.mp4`);
}

// ── Job 2 highlights (1080p30): the autoplay night, cut to its big moments ──
// Cuts are placed from the bot's own timeline (Cinema.dry()), so they follow
// the run if the level changes. Same camera, tag and captions as the demo.
async function job2() {
  rmSync(`${OUT}/job2-frames`, { recursive: true, force: true });
  mkdirSync(`${OUT}/job2-frames`, { recursive: true });
  const { browser, page } = await open(srv.url, 1920, 1080);
  const run = { job: 'halloran', seed: 3, gap: 1.2 };
  const marks = await page.evaluate((o) => {
    window.__cinema.reset(o);
    return window.__cinema.dry(600);
  }, run);
  const at = (label, n = 0) => marks.filter(([, m]) => m === label)[n]?.[0];
  console.log(marks.map(([t, m]) => `${t} ${m}`).join(' | '));
  const W = [[' ']];
  // [start, seconds, caption, where to look]
  const cuts = [
    [at('beat 1') + 0.6, 6.5, [['Job 2. Recon first: each guard’s round, on the plan.']]],
    [at('climbed') - 0.8, 5.5, [['Walls block sight. Lit rooms help the guards see.']]],
    [at('done power') - 3.2, 5.0, [['Thumbs up: '], ['Rook', ROOK], [' cuts the power. The lasers drop.']]],
    [at('done lights') - 2.4, 5.0, [['Lights out. The guards are down to their torches.']]],
    [at('done keys') - 2.6, 5.5, [['Two keys, turned together.']]],
    [at('done keys') + 0.8, 6.0, [['The vault sensor blinks, then looks. Move while it rests.']]],
    [at('done crack') - 2.2, 5.0, [['Lark', LARK], [' cracks the case.']]],
    [at('escaped') - 7.0, 7.0, [['Both partners have to get out.']]],
    [at('end') + 0.2, 5.5, W, true],
  ];
  if (cuts.some(([t]) => !Number.isFinite(t))) throw new Error('a mark is missing from the run');
  let n = 0;
  const started = Date.now();
  const put = async (cam, steps, titles) =>
    writeFileSync(`${OUT}/job2-frames/${String(n++).padStart(5, '0')}.jpg`, await shoot(page, cam, steps, titles));
  const CARD = 2.5;
  for (let f = 0; f < CARD * 30; f++) await put(null, 0, { black: 1, card: { words: [['Job 2: '], ['Halloran’s', ROOK]], a: fade(f / 30, 0, CARD, 0.5) } });
  await page.evaluate((o) => window.__cinema.reset(o), run);
  let film = CARD;
  const cues = [[0.2, 'title'], [CARD, 'start']];
  for (const [t0, dur, words, end] of cuts) {
    await page.evaluate((t) => window.__cinema.seek(t), t0 - 1 / 30);
    if (words !== W) cues.push([film, 'tension', 0.25 + 0.05 * cues.length]);
    else cues.push([film - 0.5, 'finale']);
    for (let f = 0; f < dur * 30; f++) {
      const t = f / 30;
      // A seated head, never quite still; at the end it looks up at the end card.
      const look = end ? mix(POV.look, LOOK_END, ease(t / 1.1)) : POV.look;
      const k = t0 + t;
      const cam = {
        pos: [POV.pos[0] + 0.012 * Math.sin(k * 0.37), POV.pos[1] + 0.006 * Math.sin(k * 0.53 + 1), POV.pos[2] + 0.01 * Math.sin(k * 0.29 + 2)],
        look: [look[0] + 0.03 * Math.sin(k * 0.21 + 0.5), look[1] + 0.012 * Math.sin(k * 0.33), look[2]],
        fov: 56,
      };
      await put(cam, 1, { lower: words === W ? undefined : { words, a: fade(t, 0, dur, 0.3) }, tag: TAG });
    }
    film += dur;
    console.log(`${film.toFixed(1)} s of film, ${n} frames, ${((Date.now() - started) / 1000 / n).toFixed(2)} s a frame`);
  }
  const wav = await page.evaluate(([d, c]) => window.__score(d, c), [film, cues]);
  writeFileSync(`${OUT}/job2-score.wav`, Buffer.from(wav, 'base64'));
  await browser.close();
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', '30', '-i', `${OUT}/job2-frames/%05d.jpg`, '-i', `${OUT}/job2-score.wav`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-c:a', 'aac', '-b:a', '192k', '-shortest', `${OUT}/job2.mp4`,
  ]);
  console.log('job 2:', `${OUT}/job2.mp4`);
}

const srv = await serve();
try {
  if (what === 'all' || what === 'stills') await stills();
  if (what === 'all' || what === 'trailer') await trailer();
  if (what === 'demo') await demo();
  if (what === 'job2') await job2();
} finally {
  srv.stop();
}
