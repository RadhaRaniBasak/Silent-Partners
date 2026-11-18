// Helpers for filming the built game in a headless browser (see film.mjs).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

export async function serve(port = 4174) {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { stdio: 'ignore' });
  const url = `https://localhost:${port}/`;
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(url);
      break;
    } catch (e) {
      // Self-signed certificate: any HTTP answer at all means the server is up.
      if (String(e?.cause?.code ?? e).includes('CERT') || String(e).includes('self-signed')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { url, stop: () => proc.kill() };
}

export async function open(url, width, height) {
  const browser = await chromium.launch({
    channel: 'chromium',
    args: ['--ignore-certificate-errors', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width, height }, ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${url}?cinema`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__cinema, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  return { browser, page };
}

/** Advances one film frame (1/30 s) with this camera, and waits until it has been drawn. */
export function frame(page, cam, steps = 1) {
  return page.evaluate(
    ([cam, steps]) =>
      new Promise((done) => {
        const c = window.__cinema;
        c.cam = cam;
        c.pending = steps;
        const wait = () => (c.pending > 0 ? requestAnimationFrame(wait) : requestAnimationFrame(() => requestAnimationFrame(done)));
        wait();
      }),
    [cam, steps],
  );
}

export const lerp = (a, b, u) => a + (b - a) * u;
export const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
export const mix = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
