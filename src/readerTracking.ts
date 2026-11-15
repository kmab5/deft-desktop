import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { rpc } from './api';
import type { Locator, ReadingMode } from './types';

interface TrackingOptions {
  bookId: string;
  mode: ReadingMode;
  locator: Locator;
  idleMinutes: number;
  enabled: boolean;
  keepAwake: boolean;
  notice: (message: string) => void;
}

interface Segment {
  id: Promise<string>;
  startLocator: Locator;
  sample: number;
  wall: number;
  interacted: number;
  checkpoint: number;
  activeMs: number;
  pagesTurned: number;
  zoneOffsetMinutes: number;
  locator: Locator;
  failureReported: boolean;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const CHECKPOINT_MS = 30 * SECOND;
const MAX_VALID_SAMPLE_MS = 5 * SECOND;

function accrue(segment: Segment, time: number, idleMs: number): void {
  const wall = Date.now();
  const step = time - segment.sample;
  const wallStep = wall - segment.wall;
  // A suspended machine or throttled background timer may deliver its next tick much later.
  // The gap has no reliable foreground duration, so skip it.
  if (step <= MAX_VALID_SAMPLE_MS && wallStep <= MAX_VALID_SAMPLE_MS) {
    const until = idleMs > 0 ? Math.min(time, segment.interacted + idleMs) : time;
    segment.activeMs += Math.max(0, until - segment.sample);
  }
  segment.sample = time;
  segment.wall = wall;
}

export function useReaderTracking(options: TrackingOptions) {
  const latest = useRef(options);
  latest.current = options;
  const current = useRef<Segment | null>(null);
  const initial = useRef(true);
  const queue = useRef(Promise.resolve());
  const location = useRef(options.locator);
  const awake = useRef(false);
  const isClosing = useRef(false);
  const flush = useRef<() => Promise<void>>(async () => {});
  const [status, setStatus] = useState({ seconds: 0, active: false });

  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const task = queue.current.then(action);
    queue.current = task.then(() => {}, () => {});
    return task;
  }

  function power(value: boolean): void {
    if (awake.current === value) return;
    awake.current = value;
    void enqueue(async () => {
      await rpc('keepAwake', { value });
    }).catch(() => {});
  }

  function update(segment: Segment, closed: boolean): Promise<void> {
    const payload = {
      locator: segment.locator,
      startLocator: segment.startLocator,
      activeMs: Math.floor(segment.activeMs),
      pagesTurned: segment.pagesTurned,
      zoneOffsetMinutes: segment.zoneOffsetMinutes,
      closed,
    };
    return enqueue(async () => {
      const readingId = await segment.id;
      await rpc('readingUpdate', { readingId, ...payload });
    }).catch(error => {
      if (!segment.failureReported) {
        segment.failureReported = true;
        latest.current.notice(`Reading history could not be saved. ${String(error)}`);
      }
      if (closed) {
        return enqueue(async () => {
          const readingId = await segment.id;
          await rpc('readingUpdate', { readingId, ...payload });
        }).catch(() => {});
      }
    });
  }

  function start(): void {
    if (current.current || isClosing.current || !latest.current.enabled || document.hidden || !document.hasFocus()) return;
    const { bookId, mode } = latest.current;
    const effectiveMode = initial.current || mode === 'browse' || mode === 'resume' ? mode : 'normal';
    initial.current = false;
    const start = performance.now();
    const zoneOffsetMinutes = -new Date().getTimezoneOffset();
    const locator = location.current;
    const id = enqueue(async () => {
      const result = await rpc<{ readingId: string }>('beginReading', { bookId, mode: effectiveMode, locator, zoneOffsetMinutes });
      return result.readingId;
    });
    // The checkpoint or close operation reports initialization errors.
    void id.catch(() => {});
    current.current = { id, startLocator: locator, sample: start, wall: Date.now(), interacted: start, checkpoint: start,
      activeMs: 0, pagesTurned: 0, zoneOffsetMinutes, locator, failureReported: false };
    setStatus({ seconds: 0, active: true });
    power(latest.current.keepAwake);
  }

  function stop(): Promise<void> {
    const segment = current.current;
    if (!segment) return queue.current;
    current.current = null;
    accrue(segment, performance.now(), latest.current.idleMinutes * MINUTE);
    setStatus(previous => ({ seconds: previous.seconds, active: false }));
    power(false);
    return update(segment, true);
  }

  function tick(): void {
    const segment = current.current;
    if (!segment) {
      start();
      return;
    }
    if (document.hidden || !document.hasFocus()) {
      void stop();
      return;
    }
    const elapsed = performance.now();
    const idle = elapsed - segment.interacted;
    const idleMs = latest.current.idleMinutes * MINUTE;
    accrue(segment, elapsed, idleMs);
    setStatus({ seconds: Math.floor(segment.activeMs / SECOND), active: idleMs === 0 || idle < idleMs });
    power(latest.current.keepAwake && idle < (idleMs || 15 * MINUTE));
    if (elapsed - segment.checkpoint >= CHECKPOINT_MS) {
      segment.checkpoint = elapsed;
      void update(segment, false);
    }
  }

  useEffect(() => {
    if (!options.enabled) return;
    const foreground = () => { if (document.hidden || !document.hasFocus()) void stop(); else start(); };
    const onBlur = () => { void stop(); };
    const pending = window.setTimeout(start, 0);
    const clock = window.setInterval(tick, SECOND);
    window.addEventListener('focus', foreground);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onBlur);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      window.clearTimeout(pending);
      window.clearInterval(clock);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onBlur);
      document.removeEventListener('visibilitychange', foreground);
      void stop();
    };
  // The callbacks read current preferences and position from refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.enabled]);

  function move(locator: Locator, interaction: boolean, advance = false): void {
    location.current = locator;
    const segment = current.current;
    if (!segment) return;
    segment.locator = locator;
    if (!interaction) return;
    const now = performance.now();
    accrue(segment, now, latest.current.idleMinutes * MINUTE);
    segment.interacted = now;
    if (advance) segment.pagesTurned += 1;
    power(latest.current.keepAwake && !document.hidden && document.hasFocus());
  }

  function finishPrompt(): Promise<boolean | undefined> {
    start();
    const segment = current.current;
    if (!segment) return Promise.resolve(undefined);
    return enqueue(async () => {
      await segment.id;
      if (current.current !== segment) return undefined;
      return rpc<boolean>('finishPrompt', { bookId: latest.current.bookId });
    });
  }

  async function close(): Promise<void> {
    isClosing.current = true;
    await stop();
    await queue.current;
  }

  flush.current = close;
  useEffect(() => {
    const unsubscribe = listen('deft:flush-and-close', async () => {
      try { await flush.current(); }
      finally { await rpc('closeWindow').catch(() => {}); }
    }).catch(() => () => {});
    return () => { void unsubscribe.then(stop => stop()); };
  }, []);

  return { status, move, close, finishPrompt };
}
