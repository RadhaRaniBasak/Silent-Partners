import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import { SessionMode, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { store } from './store';
import { sound } from './xr/audio';
import { CINEMA, GameSystem, launch } from './xr/system';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const landing = $<HTMLElement>('landing');
const enter = $<HTMLButtonElement>('enter');
const enter2 = $<HTMLButtonElement>('enter2');
const mixed = $<HTMLInputElement>('mixed');
const status = $<HTMLParagraphElement>('status');
const best = $<HTMLParagraphElement>('best');
const copyLog = $<HTMLButtonElement>('copy-log');
const download = $<HTMLAnchorElement>('download');
if (CINEMA) landing.hidden = true;

function refresh() {
  const b = store.best();
  const b2 = store.best('halloran');
  best.textContent = [b && `Job 1 best: ${b.stamp}, ${Math.round(b.time)} s.`, b2 && `Job 2 best: ${b2.stamp}, ${Math.round(b2.time)} s.`].filter(Boolean).join('  ');
  copyLog.hidden = !store.log();
  const rec = store.recording();
  download.hidden = !rec;
  if (download.href.startsWith('blob:')) URL.revokeObjectURL(download.href);
  if (rec) download.href = URL.createObjectURL(new Blob([rec], { type: 'application/json' }));
}

copyLog.onclick = async () => {
  const log = store.log() ?? '';
  try {
    await navigator.clipboard.writeText(log);
    status.textContent = 'Run log copied.';
  } catch {
    status.textContent = log;
  }
};

World.create($<HTMLDivElement>('scene-container'), projectOptions).then(async (world) => {
  world.registerSystem(GameSystem, { priority: 10 });

  const xr = navigator.xr;
  const supported = xr ? await xr.isSessionSupported('immersive-vr').catch(() => false) : false;
  enter.disabled = !supported;
  enter.textContent = supported ? 'Enter the van' : 'Open on your Quest';
  enter2.disabled = !supported;
  enter2.hidden = !supported;
  // Quest 3 and 3S can play on a real desk with passthrough.
  const ar = xr ? await xr.isSessionSupported('immersive-ar').catch(() => false) : false;
  $<HTMLLabelElement>('mixed-row').hidden = !ar;
  if (!supported) {
    status.className = 'info';
    status.textContent = `To play, open ${location.href.replace(/[?#].*$/, '')} in Meta Quest Browser.`;
    // On a desktop or phone, show what the game looks like instead.
    $<HTMLDivElement>('shots').hidden = false;
  }
  const trailerUrl = document.querySelector<HTMLMetaElement>('meta[name="trailer"]')?.content;
  if (trailerUrl) {
    const a = $<HTMLAnchorElement>('trailer');
    a.href = trailerUrl;
    a.hidden = false;
  }

  const go = (job: typeof launch.job) => {
    launch.job = job;
    launch.mixed = mixed.checked;
    sound.start();
    status.className = '';
    status.textContent = '';
    world.launchXR({ sessionMode: launch.mixed ? SessionMode.ImmersiveAR : SessionMode.ImmersiveVR });
    // launchXR reports failures only to the console; watch for a session that never arrives.
    const started = performance.now();
    const watch = setInterval(() => {
      if (world.session) return clearInterval(watch);
      if (!world.sessionRequestPending && performance.now() - started > 500) {
        clearInterval(watch);
        status.textContent = 'VR didn’t start. Check that hand tracking is turned on in your headset’s settings, then try again.';
      }
    }, 200);
  };
  enter.onclick = () => go('gallery');
  enter2.onclick = () => go('halloran');

  const xm = world.renderer.xr;
  xm.addEventListener('sessionstart', () => {
    landing.hidden = true;
  });
  xm.addEventListener('sessionend', () => {
    landing.hidden = false;
    enter.textContent = 'Job 1 again';
    refresh();
  });
  refresh();
}).catch((e) => {
  // No WebGL, or a chunk failed to load: say so instead of "Loading…" forever.
  console.error(e);
  enter.textContent = 'Couldn’t load';
  status.className = 'info';
  status.textContent = 'The 3D view couldn’t start here. Reload to try again, or open this page in Meta Quest Browser.';
  $<HTMLDivElement>('shots').hidden = false;
});
