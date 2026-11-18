import { DEFAULT_SETTINGS, type Settings, type Stamp } from './core/game';
import type { Cmd } from './core/recognize';
import type { JobId } from './level';

/** Everything the game keeps lives in this headset's browser storage. */

const KEY = 'silent-partners.v1.';

function get<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(KEY + key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function set(key: string, value: unknown) {
  try {
    localStorage.setItem(KEY + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the game still plays, it just won't remember.
  }
}

export interface Best {
  stamp: Stamp;
  time: number;
}

const RANK: Record<Stamp, number> = { Ghost: 0, Pro: 1, Messy: 2 };

export const store = {
  settings: (): Settings => ({ ...DEFAULT_SETTINGS, ...get<Partial<Settings>>('settings', {}) }),
  saveSettings: (s: Settings) => set('settings', s),
  templates: () => get<Partial<Record<Cmd, number[]>>>('templates', {}),
  saveTemplates: (t: Partial<Record<Cmd, number[]>>) => set('templates', t),
  /** Each job's best run; Job 1's keeps its original key. */
  best: (job: JobId = 'gallery') => get<Best | null>(job === 'gallery' ? 'best' : `best.${job}`, null),
  /** Keeps the better stamp, then the faster time. */
  offerBest(b: Best, job: JobId = 'gallery'): boolean {
    const old = this.best(job);
    if (old && (RANK[old.stamp] < RANK[b.stamp] || (old.stamp === b.stamp && old.time <= b.time))) return false;
    set(job === 'gallery' ? 'best' : `best.${job}`, b);
    return true;
  },
  log: () => get<string | null>('log', null),
  saveLog: (text: string) => set('log', text),
  recording: () => get<string | null>('recording', null),
  saveRecording: (json: string) => set('recording', json),
  reset() {
    try {
      for (const k of ['settings', 'templates']) localStorage.removeItem(KEY + k);
    } catch {
      // Blocked storage: nothing was saved, so nothing to reset.
    }
  },
};
